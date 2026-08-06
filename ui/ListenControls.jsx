import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Stop, TextToSpeech } from '@openai/apps-sdk-ui/components/Icon'
import { createAudioFrameBatcher, createSpeechBoundaryTrimmer } from '../speech-audio.js'
import { createSpeechMediaBridge } from '../speech-media.js'
import { addSpeechPauses, createSpeechTimeline } from '../speech-timeline.js'
import {
  activeVoiceModel,
  batchSpeechDocument,
  isSpeechCancellation,
  readVoiceCatalog,
  synthesizeSpeech,
} from '../speech-capability.js'
import { openShellPlayback } from '../shell-playback.js'

const AUDIO_BATCH_SECONDS = 0.32
const INITIAL_AUDIO_LEAD_SECONDS = 0.65
const RECOVERY_AUDIO_LEAD_SECONDS = 0.15
const PROGRESS_TICK_MS = 250

function canonicalSpeechText(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return /[.!?…][\]})"']?$/.test(text) ? text : `${text}.`
}

function partKind(element) {
  if (element.matches('h1')) return 'title'
  if (element.matches('h2')) return 'section'
  if (element.matches('h3')) return 'subsection'
  if (element.matches('details > summary')) return 'summary'
  if (element.matches('li')) return 'list'
  if (element.matches('blockquote')) return 'quote'
  if (element.matches('.callout')) return 'callout'
  if (element.matches('figcaption')) return 'caption'
  if (element.matches('header > p')) return 'eyebrow'
  return 'paragraph'
}

/**
 * Keep the report's editorial structure instead of flattening it to one text
 * prompt. The Speech Document carries semantic blocks, while the player owns
 * the audible silence between boundary events.
 */
export function reportSpeechDocument(report) {
  const hints = report?.speechHints || []
  if (report?.html && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(report.html, 'text/html')
    const selector = 'header > p, h1, details > summary, h2, h3, p, li, blockquote, .callout, figcaption'
    const parts = []
    const elements = [...document.body.querySelectorAll(selector)].filter(
      (element) => !element.closest('script, style, template, [aria-hidden="true"]'),
    )
    for (let index = 0; index < elements.length; index += 1) {
      const element = elements[index]
      const text = canonicalSpeechText(element.textContent)
      if (!text || parts.at(-1)?.text === text) continue
      let kind = partKind(element)
      const details = element.closest('details')
      if (details && elements[index + 1]?.closest('details') !== details) {
        kind = 'section-end'
      }
      parts.push({ text, kind })
    }
    if (parts.length) {
      return {
        version: 1,
        locale: report?.locale || '',
        hints,
        segments: addSpeechPauses(parts).map(({ text, kind, pauseMs }) => ({
          text, kind, pauseAfterMs: pauseMs,
        })),
      }
    }
  }

  const parts = []
  const push = (value, kind) => {
    const text = canonicalSpeechText(value)
    if (text) parts.push({ text, kind })
  }
  push(report?.summary, 'paragraph')
  for (const section of report?.sections || []) {
    push(section?.title, 'section')
    for (const article of section?.articles || []) {
      push(article?.headline, 'subsection')
      push(article?.summary, 'paragraph')
    }
  }
  return {
    version: 1,
    locale: report?.locale || '',
    hints,
    segments: addSpeechPauses(parts).map(({ text, kind, pauseMs }) => ({
      text, kind, pauseAfterMs: pauseMs,
    })),
  }
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function ListenControls({ report }) {
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [durationExact, setDurationExact] = useState(false)
  const [playbackProgress, setPlaybackProgress] = useState(0)
  const [streamReady, setStreamReady] = useState(false)
  const [loadingState, setLoadingState] = useState({ stage: 'idle', percent: 0 })
  const contextRef = useRef(null)
  const mediaElementRef = useRef(null)
  const mediaBridgeRef = useRef(null)
  const shellMediaRef = useRef(null)
  const abortRef = useRef(null)
  const sourcesRef = useRef(new Set())
  const firstAtRef = useRef(0)
  const nextAtRef = useRef(0)
  const streamDoneRef = useRef(false)
  const runRef = useRef(0)
  const animationRef = useRef(0)
  const durationRef = useRef(0)
  const progressRef = useRef(0)

  const resetPlayback = useCallback((nextPhase = 'idle') => {
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    for (const source of sourcesRef.current) {
      try { source.stop() } catch {}
    }
    sourcesRef.current.clear()
    mediaBridgeRef.current?.dispose()
    mediaBridgeRef.current = null
    shellMediaRef.current?.close()
    shellMediaRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') context.close().catch(() => {})
    clearTimeout(animationRef.current)
    firstAtRef.current = 0
    nextAtRef.current = 0
    streamDoneRef.current = false
    setStreamReady(false)
    setLoadingState({ stage: 'idle', percent: 0 })
    setElapsed(0)
    setDuration(0)
    setDurationExact(false)
    setPlaybackProgress(0)
    durationRef.current = 0
    progressRef.current = 0
    setPhase(nextPhase)
  }, [])

  useEffect(() => () => {
    resetPlayback('idle')
  }, [resetPlayback])

  const updateProgress = useCallback(() => {
    const context = contextRef.current
    if (!context) return
    const current = firstAtRef.current ? Math.max(0, context.currentTime - firstAtRef.current) : 0
    const elapsedNow = Math.min(current, Math.max(0, nextAtRef.current - firstAtRef.current))
    setElapsed(elapsedNow)
    if (durationRef.current > 0) {
      const cap = streamDoneRef.current ? 100 : 98
      progressRef.current = Math.max(
        progressRef.current,
        Math.min(cap, elapsedNow / durationRef.current * 100),
      )
      setPlaybackProgress(progressRef.current)
    }
    animationRef.current = window.setTimeout(updateProgress, PROGRESS_TICK_MS)
  }, [])

  const start = useCallback(async () => {
    resetPlayback('idle')
    const run = runRef.current
    const speechDocument = reportSpeechDocument(report)
    const parts = speechDocument.segments
    if (!parts.length) {
      setError('This report has no readable text.')
      setPhase('error')
      return
    }
    let speechDocuments
    try {
      speechDocuments = batchSpeechDocument(speechDocument)
    } catch (caught) {
      setError(caught?.message || 'This report is too large to read aloud.')
      setPhase('error')
      return
    }
    const timeline = createSpeechTimeline(parts.map((part) => ({
      ...part,
      pauseMs: part.pauseAfterMs,
    })))
    durationRef.current = timeline.initialDuration
    setDuration(timeline.initialDuration)
    setDurationExact(false)

    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) {
      setError('This browser cannot play streamed speech.')
      setPhase('error')
      return
    }

    const context = new AudioContext()
    contextRef.current = context
    // Resume inside the tap handler before the first network await. This is
    // the mobile autoplay boundary: doing it after fetch would be rejected.
    await context.resume()
    let speechModel
    try {
      speechModel = activeVoiceModel(await readVoiceCatalog())
    } catch (caught) {
      resetPlayback('error')
      setError(caught?.message || 'The selected voice is unavailable.')
      return
    }
    if (!speechModel) {
      resetPlayback('error')
      setError('Open Voice and download a voice, then select it on this device.')
      return
    }
    const sampleRate = speechModel.sampleRate || 24_000
    let mediaBridge
    const failMediaAction = (caught) => {
      if (run !== runRef.current) return
      resetPlayback('error')
      setError(caught?.message || 'Background playback stopped unexpectedly.')
    }
    const resumeFromMedia = async () => {
      try {
        await mediaBridge?.resume()
        if (run === runRef.current) {
          setPhase('playing')
          shellMediaRef.current?.setState('playing')
        }
      } catch (caught) { failMediaAction(caught) }
    }
    const pauseFromMedia = async () => {
      try {
        await mediaBridge?.pause()
        if (run === runRef.current) {
          setPhase('paused')
          shellMediaRef.current?.setState('paused')
        }
      } catch (caught) { failMediaAction(caught) }
    }
    mediaBridge = createSpeechMediaBridge({
      context,
      element: mediaElementRef.current,
      metadata: {
        title: report?.date ? `Daily digest · ${report.date}` : 'Daily digest',
        artist: 'News',
        album: 'Möbius',
      },
      onPlay: resumeFromMedia,
      onPause: pauseFromMedia,
      onStop: () => resetPlayback('idle'),
    })
    mediaBridgeRef.current = mediaBridge
    try {
      await mediaBridge.start()
    } catch (caught) {
      resetPlayback('error')
      setError(caught?.message || 'This browser could not start background playback.')
      return
    }
    shellMediaRef.current = openShellPlayback({
      title: report?.date ? `Daily digest · ${report.date}` : 'Daily digest',
      onControl: (action) => {
        if (action === 'play') return resumeFromMedia()
        if (action === 'pause') return pauseFromMedia()
        if (action === 'stop') resetPlayback('idle')
      },
    })
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setPhase('loading')
    setLoadingState({ stage: 'checking', percent: 0 })
    streamDoneRef.current = false

    const finishPlayback = () => {
      if (run !== runRef.current) return
      clearTimeout(animationRef.current)
      const exact = Math.max(0, nextAtRef.current - firstAtRef.current)
      setElapsed(exact)
      setPlaybackProgress(100)
      progressRef.current = 100
      mediaBridge.finish()
      shellMediaRef.current?.close()
      shellMediaRef.current = null
      setPhase('finished')
    }

    const scheduleSamples = (samples) => {
      if (!samples.length) return
      const buffer = context.createBuffer(1, samples.length, sampleRate)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(mediaBridge.destination)
      const minimumLead = firstAtRef.current
        ? RECOVERY_AUDIO_LEAD_SECONDS
        : INITIAL_AUDIO_LEAD_SECONDS
      const startAt = Math.max(nextAtRef.current || 0, context.currentTime + minimumLead)
      if (!firstAtRef.current) firstAtRef.current = startAt
      nextAtRef.current = startAt + buffer.duration
      sourcesRef.current.add(source)
      source.onended = () => {
        sourcesRef.current.delete(source)
        if (streamDoneRef.current && sourcesRef.current.size === 0 && run === runRef.current) {
          finishPlayback()
        }
      }
      source.start(startAt)
      setStreamReady(true)
      const playbackState = context.state === 'suspended' ? 'paused' : 'playing'
      setPhase(playbackState)
      shellMediaRef.current?.setState(playbackState)
    }

    const schedulePause = (milliseconds) => {
      if (!firstAtRef.current) return
      nextAtRef.current += Math.max(0, Number(milliseconds) || 0) / 1000
    }

    const audioBatcher = createAudioFrameBatcher({
      targetSamples: sampleRate * AUDIO_BATCH_SECONDS,
      onBatch: scheduleSamples,
    })

    let index = 0
    let partSamples = 0
    let trimmer = createSpeechBoundaryTrimmer({
      sampleRate,
      onSamples: (samples) => {
        partSamples += samples.length
        audioBatcher.push(samples)
      },
    })
    const completePart = (boundary) => {
      if (index >= parts.length || run !== runRef.current) return
      const completedIndex = index
      const pauseAfterMs = Number.isFinite(boundary?.pauseAfterMs)
        ? boundary.pauseAfterMs
        : parts[completedIndex].pauseAfterMs
      trimmer.flush()
      audioBatcher.flush()
      if (completedIndex < parts.length - 1) schedulePause(pauseAfterMs)
      const queued = Math.max(0, nextAtRef.current - firstAtRef.current)
      const estimate = timeline.completePart(completedIndex, partSamples / sampleRate, queued)
      durationRef.current = estimate
      setDuration(estimate)
      index += 1
      partSamples = 0
      if (index < parts.length) {
        trimmer = createSpeechBoundaryTrimmer({
          sampleRate,
          onSamples: (samples) => {
            partSamples += samples.length
            audioBatcher.push(samples)
          },
        })
      }
    }

    try {
      updateProgress()
      for (const speechBatch of speechDocuments) {
        if (run !== runRef.current) return
        await synthesizeSpeech({
          document: speechBatch,
          modelId: speechModel.id,
          signal: controller.signal,
          onLoading: (next) => setLoadingState({
            stage: next?.stage || 'checking',
            percent: Number.isFinite(next?.percent) ? next.percent : 0,
          }),
          onAudio: (samples) => {
            if (run === runRef.current) trimmer.push(samples)
          },
          onBoundary: completePart,
        })
      }
      if (run !== runRef.current) return
      streamDoneRef.current = true
      setStreamReady(true)
      const exact = Math.max(0, nextAtRef.current - firstAtRef.current)
      durationRef.current = exact
      setDuration(exact)
      setDurationExact(true)
      if (sourcesRef.current.size === 0) finishPlayback()
    } catch (caught) {
      if (run !== runRef.current) return
      if (isSpeechCancellation(caught)) {
        resetPlayback('idle')
        return
      }
      resetPlayback('error')
      setError(caught?.message || 'Speech stopped unexpectedly.')
    }
  }, [report, resetPlayback, updateProgress])

  const togglePause = async () => {
    const mediaBridge = mediaBridgeRef.current
    if (!mediaBridge) return
    if (phase === 'playing') {
      await mediaBridge.pause()
      setPhase('paused')
      shellMediaRef.current?.setState('paused')
    } else if (phase === 'paused') {
      await mediaBridge.resume()
      setPhase('playing')
      shellMediaRef.current?.setState('playing')
    }
  }

  const loadingProgress = Math.max(0, Math.min(100, loadingState.percent))
  const loadingDeterminate = loadingState.stage === 'reading' && loadingProgress > 0
  const loadingStatus = loadingState.stage === 'reading'
    ? `${Math.round(loadingProgress)}% · opening the saved voice locally · no download`
    : loadingState.stage === 'preparing'
      ? 'Preparing the saved voice locally · no download'
      : loadingState.stage === 'generating'
        ? 'Generating the first audio · the first section is slowest'
        : loadingState.stage === 'starting'
          ? 'Starting the local speech engine'
          : loadingState.stage === 'checking'
            ? 'Checking the saved download'
            : ''
  const progress = streamReady && duration > 0
    ? playbackProgress
    : Math.max(0, Math.min(100, loadingProgress))
  const active = ['loading', 'playing', 'paused'].includes(phase)
  const label = phase === 'loading' && loadingState.stage === 'reading' ? 'Opening saved voice…'
    : phase === 'loading' && loadingState.stage === 'preparing' ? 'Preparing saved voice…'
      : phase === 'loading' && loadingState.stage === 'generating' ? 'Generating first audio…'
        : phase === 'loading' && loadingState.stage === 'starting' ? 'Starting saved voice…'
          : phase === 'loading' ? 'Checking saved download…'
            : phase === 'playing' ? 'Pause'
              : phase === 'paused' ? 'Resume'
                : phase === 'finished' ? 'Listen again'
                  : phase === 'error' ? 'Try again'
                    : 'Listen to this digest'
  const status = active
    ? streamReady
      ? `${clock(elapsed)} / ${durationExact ? '' : '~'}${clock(duration)}`
      : loadingStatus
    : 'Voice · selected on this device'

  return (
    <div className={`nw-listen-player is-${phase}`}>
      <audio ref={mediaElementRef} aria-hidden="true" />
      <button
        type="button"
        className="nw-listen-main"
        onClick={phase === 'playing' || phase === 'paused' ? togglePause : start}
        disabled={phase === 'loading'}
        aria-busy={phase === 'loading'}
      >
        <span className="nw-listen-icon" aria-hidden="true">
          {phase === 'playing' ? <Pause /> : phase === 'loading' ? <TextToSpeech /> : <Play />}
        </span>
        <span className="nw-listen-copy">
          <strong>{label}</strong>
          {status && <small>{status}</small>}
          {active && (
            <span
              className={`nw-listen-track${streamReady || loadingDeterminate ? '' : ' is-building'}`}
              role="progressbar"
              aria-label={streamReady ? 'Playback progress' : 'Preparing speech'}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={streamReady || loadingDeterminate ? String(Math.round(progress)) : undefined}
              aria-valuetext={!streamReady && loadingStatus ? loadingStatus : undefined}
            >
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
        </span>
      </button>
      {active && (
        <button type="button" className="nw-listen-stop" onClick={() => resetPlayback('idle')}>
          <Stop aria-hidden="true" /> Stop
        </button>
      )}
      {error && <div className="nw-listen-error" role="alert">{error}</div>}
    </div>
  )
}
