import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play, Stop, TextToSpeech } from '@openai/apps-sdk-ui/components/Icon'
import { concatAudioFrames, createSpeechBoundaryTrimmer } from '../speech-audio.js'
import {
  createPitchPreservingSpeechOutput,
  createSpeechMediaBridge,
} from '../speech-media.js'
import {
  addSpeechPauses,
  createSpeechTimeline,
  normalizePlaybackSettings,
  normalizePlaybackRate,
  playbackSettingsWithRate,
  playbackSettingsWithResume,
  PLAYBACK_RATES,
  resumeSegmentFor,
  speechReportKey,
} from '../speech-timeline.js'
import {
  activeVoiceModel,
  batchSpeechDocument,
  isSpeechCancellation,
  isSpeechReplacement,
  readVoiceCatalog,
  speechHintsForReport,
  synthesizeSpeech,
  voicePlaybackConfig,
} from '../speech-capability.js'
import { openShellPlayback } from '../shell-playback.js'

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
  const hints = speechHintsForReport(report?.speechHints)
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
  const speechDocument = useMemo(() => reportSpeechDocument(report), [report])
  const reportKey = useMemo(
    () => speechReportKey(report?.date, speechDocument.segments),
    [report?.date, speechDocument.segments],
  )
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [durationExact, setDurationExact] = useState(false)
  const [playbackProgress, setPlaybackProgress] = useState(0)
  const [streamReady, setStreamReady] = useState(false)
  const [buffering, setBuffering] = useState(false)
  const [loadingState, setLoadingState] = useState({ stage: 'idle', percent: 0 })
  const [playbackSettings, setPlaybackSettings] = useState(() => normalizePlaybackSettings(null))
  const contextRef = useRef(null)
  const mediaElementRef = useRef(null)
  const mediaBridgeRef = useRef(null)
  const playbackOutputRef = useRef(null)
  const shellMediaRef = useRef(null)
  const abortRef = useRef(null)
  const streamDoneRef = useRef(false)
  const streamReadyRef = useRef(false)
  const runRef = useRef(0)
  const animationRef = useRef(0)
  const durationRef = useRef(0)
  const progressRef = useRef(0)
  const completedContentRef = useRef(0)
  const playbackRateRef = useRef(1)
  const playbackSettingsRef = useRef(normalizePlaybackSettings(null))
  const settingsWriteRef = useRef(Promise.resolve())
  const settingsErrorShownRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    const storage = window.mobius?.storage
    if (typeof storage?.subscribe !== 'function') return undefined
    return storage.subscribe('playback.json', (value) => {
      const settings = normalizePlaybackSettings(value)
      playbackSettingsRef.current = settings
      playbackRateRef.current = settings.rate
      setPlaybackSettings(settings)
    })
  }, [])

  const persistPlaybackSettings = useCallback((nextValue, failureMessage) => {
    const next = normalizePlaybackSettings(nextValue)
    playbackSettingsRef.current = next
    playbackRateRef.current = next.rate
    if (mountedRef.current) setPlaybackSettings(next)
    const task = settingsWriteRef.current.catch(() => {}).then(() => {
      const durableWrite = window.mobius?.durableWrite
      if (typeof durableWrite !== 'function') {
        throw new Error('Durable playback settings are unavailable.')
      }
      return durableWrite('playback.json', next)
    })
    settingsWriteRef.current = task
    task.catch((caught) => {
      if (mountedRef.current && !settingsErrorShownRef.current) {
        settingsErrorShownRef.current = true
        setError(failureMessage)
      }
      window.mobius?.signal?.('error', {
        source: 'playback-settings',
        message: caught?.message || failureMessage,
      })
    })
    return task
  }, [])

  const saveResume = useCallback((nextSegment) => persistPlaybackSettings(
    playbackSettingsWithResume(playbackSettingsRef.current, {
      reportKey,
      nextSegment,
    }),
    'Playback continues, but News couldn’t save your place.',
  ), [persistPlaybackSettings, reportKey])

  const clearResume = useCallback(() => persistPlaybackSettings(
    playbackSettingsWithResume(playbackSettingsRef.current, null),
    'News couldn’t clear the saved listening position.',
  ), [persistPlaybackSettings])

  const disposePlayback = useCallback(() => {
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    playbackOutputRef.current?.dispose()
    playbackOutputRef.current = null
    mediaBridgeRef.current?.dispose()
    mediaBridgeRef.current = null
    shellMediaRef.current?.close()
    shellMediaRef.current = null
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') context.close().catch(() => {})
    clearTimeout(animationRef.current)
    streamDoneRef.current = false
    streamReadyRef.current = false
    completedContentRef.current = 0
  }, [])

  const resetPlayback = useCallback((nextPhase = 'idle') => {
    disposePlayback()
    setStreamReady(false)
    setBuffering(false)
    setError('')
    setNotice('')
    setLoadingState({ stage: 'idle', percent: 0 })
    setElapsed(0)
    setDuration(0)
    setDurationExact(false)
    setPlaybackProgress(0)
    durationRef.current = 0
    progressRef.current = 0
    setPhase(nextPhase)
  }, [disposePlayback])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      disposePlayback()
    }
  }, [disposePlayback])

  const updateProgress = useCallback(() => {
    const output = playbackOutputRef.current
    if (!output) return
    const elapsedNow = Math.min(
      completedContentRef.current + output.elapsedSeconds(),
      durationRef.current,
    )
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

  const stopPlayback = useCallback(() => {
    resetPlayback('idle')
    void clearResume()
  }, [clearResume, resetPlayback])

  const changePlaybackRate = useCallback(async (value) => {
    const rate = normalizePlaybackRate(value)
    setError('')
    playbackOutputRef.current?.setRate(rate)
    try {
      await persistPlaybackSettings(
        playbackSettingsWithRate(playbackSettingsRef.current, rate),
        `Using ${rate}× now, but News couldn’t remember that speed.`,
      )
    } catch {
      // persistPlaybackSettings owns the visible recovery message and signal.
    }
  }, [persistPlaybackSettings])

  const start = useCallback(async (requestedStart = undefined) => {
    const allParts = speechDocument.segments
    const savedStart = resumeSegmentFor(
      playbackSettingsRef.current,
      reportKey,
      allParts.length,
    )
    const startIndex = Number.isInteger(requestedStart)
      ? Math.max(0, Math.min(requestedStart, Math.max(0, allParts.length - 1)))
      : savedStart ?? 0
    resetPlayback('idle')
    const run = runRef.current
    const parts = allParts.slice(startIndex)
    if (!parts.length) {
      setError('This report has no readable text.')
      setPhase('error')
      return
    }
    let speechDocuments
    try {
      speechDocuments = batchSpeechDocument({
        ...speechDocument,
        segments: parts,
      })
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

    let context
    try {
      context = new AudioContext()
    } catch (caught) {
      setError(caught?.message || 'This browser could not create an audio player.')
      setPhase('error')
      return
    }
    contextRef.current = context
    // Resume inside the tap handler before the first network await. This is
    // the mobile autoplay boundary: doing it after fetch would be rejected.
    try {
      await context.resume()
    } catch (caught) {
      if (run !== runRef.current) return
      resetPlayback('error')
      setError(caught?.message || 'This browser blocked speech playback. Tap Try again.')
      return
    }
    if (run !== runRef.current) return
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
          const nextPhase = streamReadyRef.current ? 'playing' : 'loading'
          setPhase(nextPhase)
          shellMediaRef.current?.setState(nextPhase)
        }
      } catch (caught) { failMediaAction(caught) }
    }
    const pauseFromMedia = async () => {
      try {
        await mediaBridge?.pause()
        if (run === runRef.current) {
          const nextPhase = streamReadyRef.current ? 'paused' : 'loading'
          setPhase(nextPhase)
          shellMediaRef.current?.setState('paused')
        }
      } catch (caught) { failMediaAction(caught) }
    }
    try {
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
        onStop: stopPlayback,
      })
      mediaBridgeRef.current = mediaBridge
      await mediaBridge.start()
    } catch (caught) {
      if (run !== runRef.current) return
      resetPlayback('error')
      setError(caught?.message || 'This browser could not start background playback.')
      return
    }
    if (run !== runRef.current) return
    // Persist the restart boundary before catalog/model/worklet startup. If
    // the frame leaves during those slower steps, Continue can still recover
    // this exact section while the old frame releases its speech session.
    void saveResume(startIndex)
    shellMediaRef.current = openShellPlayback({
      title: report?.date ? `Daily digest · ${report.date}` : 'Daily digest',
      onControl: (action) => {
        if (action === 'play') return resumeFromMedia()
        if (action === 'pause') return pauseFromMedia()
        if (action === 'stop') stopPlayback()
      },
    })
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setPhase('loading')
    setLoadingState({ stage: 'checking', percent: 0 })
    streamDoneRef.current = false

    let catalog
    try {
      catalog = await readVoiceCatalog(controller.signal)
    } catch (caught) {
      if (run !== runRef.current) return
      resetPlayback('error')
      setError(caught?.message || 'The selected voice is unavailable.')
      return
    }
    const speechModel = activeVoiceModel(catalog)
    if (!speechModel) {
      resetPlayback('error')
      setError('Open Voice and download a voice, then select it on this device.')
      return
    }
    const playbackConfig = voicePlaybackConfig(catalog)
    if (!playbackConfig) {
      resetPlayback('error')
      setError('Update Möbius to use pitch-preserving voice speed controls.')
      return
    }
    const sampleRate = speechModel.sampleRate || 24_000
    let output
    try {
      output = await createPitchPreservingSpeechOutput({
        context,
        destination: mediaBridge.destination,
        workletUrl: playbackConfig.workletUrl,
      })
      if (run !== runRef.current) {
        output.dispose()
        return
      }
      output.setRate(playbackRateRef.current)
      playbackOutputRef.current = output
    } catch (caught) {
      if (run !== runRef.current) return
      resetPlayback('error')
      setError(caught?.message || 'Pitch-preserving speech playback could not start.')
      return
    }
    let pendingSegments = 0
    let generatedContentSeconds = 0
    let generatedDone = false
    let generationFailure = null

    const finishPlayback = () => {
      if (run !== runRef.current || pendingSegments > 0 || !generatedDone) return
      clearTimeout(animationRef.current)
      const exact = completedContentRef.current
      setElapsed(exact)
      setPlaybackProgress(100)
      progressRef.current = 100
      output.dispose()
      playbackOutputRef.current = null
      mediaBridge.finish()
      mediaBridgeRef.current = null
      shellMediaRef.current?.close()
      shellMediaRef.current = null
      contextRef.current = null
      if (context.state !== 'closed') context.close().catch(() => {})
      abortRef.current = null
      setBuffering(false)
      void clearResume()
      setPhase('finished')
    }

    const markStreamReady = () => {
      setBuffering(false)
      streamReadyRef.current = true
      setStreamReady(true)
      const playbackState = context.state === 'suspended' ? 'paused' : 'playing'
      setPhase(playbackState)
      shellMediaRef.current?.setState(playbackState)
    }

    let generatedIndex = 0
    let partSamples = 0
    let partFrames = []
    let trimmer = createSpeechBoundaryTrimmer({
      sampleRate,
      onSamples: (samples) => {
        partSamples += samples.length
        partFrames.push(samples)
      },
    })
    const completePart = (boundary) => {
      if (generatedIndex >= parts.length || run !== runRef.current) return
      const completedIndex = generatedIndex
      const absoluteIndex = startIndex + completedIndex
      const pauseAfterMs = Number.isFinite(boundary?.pauseAfterMs)
        ? boundary.pauseAfterMs
        : parts[completedIndex].pauseAfterMs
      trimmer.flush()
      const samples = concatAudioFrames(partFrames, partSamples)
      if (!samples.length) {
        generationFailure = new Error(`Section ${absoluteIndex + 1} produced no playable audio.`)
        controller.abort()
        return
      }
      const semanticPauseMs = absoluteIndex < allParts.length - 1 ? pauseAfterMs : 0
      pendingSegments += 1
      let scheduled
      try {
        // The output owns one audio-clock queue. Enqueue as soon as a complete
        // semantic section exists; an `ended` callback never starts audio.
        scheduled = output.play(samples, {
          sampleRate,
          pauseAfterMs: semanticPauseMs,
          playbackRate: playbackRateRef.current,
          final: absoluteIndex === allParts.length - 1,
          onEnded: (completedSeconds) => {
            if (run !== runRef.current) return
            completedContentRef.current += completedSeconds
            pendingSegments -= 1
            if (absoluteIndex + 1 < allParts.length) void saveResume(absoluteIndex + 1)
            if (pendingSegments === 0) {
              if (generatedDone) finishPlayback()
              else {
                setBuffering(true)
                if (context.state !== 'suspended') shellMediaRef.current?.setState('loading')
              }
            }
          },
        })
      } catch (caught) {
        pendingSegments -= 1
        resetPlayback('error')
        setError(caught?.message || 'Speech playback stopped unexpectedly.')
        return
      }
      markStreamReady()
      generatedContentSeconds += scheduled.logicalDuration
      const estimate = timeline.completePart(
        completedIndex,
        partSamples / sampleRate,
        generatedContentSeconds,
      )
      durationRef.current = estimate
      setDuration(estimate)
      generatedIndex += 1
      partSamples = 0
      partFrames = []
      if (generatedIndex < parts.length) {
        trimmer = createSpeechBoundaryTrimmer({
          sampleRate,
          onSamples: (samples) => {
            partSamples += samples.length
            partFrames.push(samples)
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
          onLoading: (next) => {
            if (run === runRef.current) {
              setLoadingState({
                stage: next?.stage || 'checking',
                percent: Number.isFinite(next?.percent) ? next.percent : 0,
              })
            }
          },
          onAudio: (samples) => {
            if (run === runRef.current) trimmer.push(samples)
          },
          onBoundary: completePart,
        })
      }
      if (run !== runRef.current) return
      generatedDone = true
      streamDoneRef.current = true
      const exact = generatedContentSeconds
      durationRef.current = exact
      setDuration(exact)
      setDurationExact(true)
      finishPlayback()
    } catch (caught) {
      if (run !== runRef.current) return
      if (generationFailure) {
        resetPlayback('error')
        setError(generationFailure.message)
        return
      }
      if (isSpeechReplacement(caught)) {
        resetPlayback('idle')
        setNotice('Another voice session started. Resume here whenever you’re ready.')
        return
      }
      if (isSpeechCancellation(caught)) {
        resetPlayback('idle')
        return
      }
      resetPlayback('error')
      setError(caught?.message || 'Speech stopped unexpectedly.')
    }
  }, [
    clearResume,
    report?.date,
    reportKey,
    resetPlayback,
    saveResume,
    speechDocument,
    stopPlayback,
    updateProgress,
  ])

  const togglePause = async () => {
    const mediaBridge = mediaBridgeRef.current
    if (!mediaBridge) return
    try {
      if (phase === 'playing') {
        await mediaBridge.pause()
        setPhase('paused')
        shellMediaRef.current?.setState('paused')
      } else if (phase === 'paused') {
        await mediaBridge.resume()
        setPhase('playing')
        shellMediaRef.current?.setState(buffering ? 'loading' : 'playing')
      }
    } catch (caught) {
      resetPlayback('error')
      setError(caught?.message || 'Background playback stopped unexpectedly.')
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
  const resumeAt = resumeSegmentFor(
    playbackSettings,
    reportKey,
    speechDocument.segments.length,
  )
  const label = phase === 'loading' && loadingState.stage === 'reading' ? 'Opening saved voice…'
    : phase === 'loading' && loadingState.stage === 'preparing' ? 'Preparing saved voice…'
      : phase === 'loading' && loadingState.stage === 'generating' ? 'Generating first audio…'
        : phase === 'loading' && loadingState.stage === 'starting' ? 'Starting saved voice…'
          : phase === 'loading' ? 'Checking saved download…'
            : phase === 'playing' ? 'Pause'
              : phase === 'paused' ? 'Resume'
                : phase === 'finished' ? 'Listen again'
                  : phase === 'error' ? 'Try again'
                    : resumeAt !== null ? 'Resume this digest'
                      : 'Listen to this digest'
  const status = active
    ? streamReady
      ? buffering
        ? 'Generating the next section…'
        : `${clock(elapsed)} / ${durationExact ? '' : '~'}${clock(duration)}`
      : loadingStatus
    : notice || (resumeAt !== null
      ? `Continue from section ${resumeAt + 1} of ${speechDocument.segments.length}`
      : 'Voice · selected on this device')

  return (
    <div className={`nw-listen-player is-${phase}`}>
      <audio ref={mediaElementRef} aria-hidden="true" />
      <button
        type="button"
        className="nw-listen-main"
        onClick={phase === 'playing' || phase === 'paused'
          ? togglePause
          : () => { void start() }}
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
              <span style={{ transform: `scaleX(${progress / 100})` }} />
            </span>
          )}
        </span>
      </button>
      {active && (
        <button type="button" className="nw-listen-stop" onClick={stopPlayback}>
          <Stop aria-hidden="true" /> Stop
        </button>
      )}
      {!active && resumeAt !== null && (
        <button type="button" className="nw-listen-stop nw-listen-restart" onClick={() => { void start(0) }}>
          Start over
        </button>
      )}
      <label className="nw-listen-speed">
        <span className="nw-visually-hidden">Playback speed</span>
        <select
          aria-label="Playback speed"
          value={playbackSettings.rate}
          title="Playback speed · pitch preserved"
          onChange={(event) => { void changePlaybackRate(event.target.value) }}
        >
          {PLAYBACK_RATES.map((rate) => (
            <option key={rate} value={rate}>{rate}×</option>
          ))}
        </select>
      </label>
      {error && <div className="nw-listen-error" role="alert">{error}</div>}
    </div>
  )
}
