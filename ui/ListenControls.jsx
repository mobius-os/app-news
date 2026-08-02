import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Stop, TextToSpeech } from '@openai/apps-sdk-ui/components/Icon'
import { languageInfo } from '../preferences.js'
import { applySpeechHints } from '../report-schema.mjs'
import { browserSpeechEngine, releaseBrowserSpeechEngine } from '../browser-tts.js'

const SAMPLE_RATE = 24_000

const PAUSE_AFTER = {
  eyebrow: 360,
  title: 900,
  summary: 620,
  section: 760,
  subsection: 560,
  paragraph: 420,
  list: 300,
  quote: 560,
  callout: 520,
  caption: 420,
}

function spokenText(value, hints) {
  const text = applySpeechHints(value, hints).replace(/\s+/g, ' ').trim()
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
 * prompt. Pocket TTS deliberately strips newlines and does not support pause
 * markup, so the player synthesizes each semantic block and schedules silence
 * between blocks itself.
 */
export function reportSpeechParts(report) {
  const hints = report?.speechHints || []
  if (report?.html && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(report.html, 'text/html')
    const selector = 'header > p, h1, details > summary, h2, h3, p, li, blockquote, .callout, figcaption'
    const parts = []
    for (const element of document.body.querySelectorAll(selector)) {
      if (element.closest('script, style, template, [aria-hidden="true"]')) continue
      const text = spokenText(element.textContent, hints)
      if (!text || parts.at(-1)?.text === text) continue
      const kind = partKind(element)
      parts.push({ text, pauseMs: PAUSE_AFTER[kind] || PAUSE_AFTER.paragraph, kind })
    }
    if (parts.length) return parts
  }

  const parts = []
  const push = (value, kind) => {
    const text = spokenText(value, hints)
    if (text) parts.push({ text, pauseMs: PAUSE_AFTER[kind] || PAUSE_AFTER.paragraph, kind })
  }
  push(report?.summary, 'paragraph')
  for (const section of report?.sections || []) {
    push(section?.title, 'section')
    for (const article of section?.articles || []) {
      push(article?.headline, 'subsection')
      push(article?.summary, 'paragraph')
    }
  }
  return parts
}

function clock(seconds) {
  const whole = Math.max(0, Math.floor(seconds || 0))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

export function ListenControls({ appId, token, report, preferences }) {
  const [phase, setPhase] = useState('idle')
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [duration, setDuration] = useState(0)
  const [streamReady, setStreamReady] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [speechBackend, setSpeechBackend] = useState('')
  const contextRef = useRef(null)
  const abortRef = useRef(null)
  const sourcesRef = useRef(new Set())
  const firstAtRef = useRef(0)
  const nextAtRef = useRef(0)
  const streamDoneRef = useRef(false)
  const runRef = useRef(0)
  const animationRef = useRef(0)

  const closeAudio = useCallback((nextPhase = 'idle') => {
    runRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    releaseBrowserSpeechEngine()
    for (const source of sourcesRef.current) {
      try { source.stop() } catch {}
    }
    sourcesRef.current.clear()
    const context = contextRef.current
    contextRef.current = null
    if (context && context.state !== 'closed') context.close().catch(() => {})
    cancelAnimationFrame(animationRef.current)
    firstAtRef.current = 0
    nextAtRef.current = 0
    streamDoneRef.current = false
    setStreamReady(false)
    setLoadingProgress(0)
    setSpeechBackend('')
    setElapsed(0)
    setDuration(0)
    setPhase(nextPhase)
  }, [])

  useEffect(() => () => closeAudio('idle'), [closeAudio])

  const animate = useCallback(() => {
    const context = contextRef.current
    if (!context) return
    const current = firstAtRef.current ? Math.max(0, context.currentTime - firstAtRef.current) : 0
    setElapsed(Math.min(current, Math.max(0, nextAtRef.current - firstAtRef.current)))
    setDuration(Math.max(0, nextAtRef.current - firstAtRef.current))
    animationRef.current = requestAnimationFrame(animate)
  }, [])

  const start = useCallback(async () => {
    closeAudio('idle')
    const run = runRef.current
    const parts = reportSpeechParts(report)
    if (!parts.length) {
      setError('This report has no readable text.')
      setPhase('error')
      return
    }

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
    const controller = new AbortController()
    abortRef.current = controller
    setError('')
    setPhase('loading')
    streamDoneRef.current = false

    const scheduleSamples = (samples) => {
      if (!samples.length) return
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const startAt = Math.max(nextAtRef.current || 0, context.currentTime + 0.08)
      if (!firstAtRef.current) firstAtRef.current = startAt
      nextAtRef.current = startAt + buffer.duration
      sourcesRef.current.add(source)
      source.onended = () => {
        sourcesRef.current.delete(source)
        if (streamDoneRef.current && sourcesRef.current.size === 0 && run === runRef.current) {
          cancelAnimationFrame(animationRef.current)
          setElapsed(Math.max(0, nextAtRef.current - firstAtRef.current))
          setPhase('finished')
        }
      }
      source.start(startAt)
      setStreamReady(true)
      setPhase((current) => current === 'paused' ? current : 'playing')
    }

    const scheduleSilence = (milliseconds) => {
      const sampleCount = Math.max(0, Math.round(SAMPLE_RATE * milliseconds / 1000))
      if (sampleCount) scheduleSamples(new Float32Array(sampleCount))
    }

    const engine = browserSpeechEngine(appId, token)
    const streamPart = (part) => engine.generate(part.text, {
      signal: controller.signal,
      onChunk: (samples) => {
        if (run === runRef.current) scheduleSamples(samples)
      },
    })

    try {
      const loaded = await engine.load({
        signal: controller.signal,
        onProgress: (percent) => setLoadingProgress(Number.isFinite(percent) ? percent : 0),
      })
      setSpeechBackend(loaded?.backend || '')
      // Let the prepared backend and completed download bar paint before the
      // first model step starts compiling work for the selected device.
      await new Promise((resolve) => requestAnimationFrame(resolve))
      animationRef.current = requestAnimationFrame(animate)
      for (let index = 0; index < parts.length; index += 1) {
        if (run !== runRef.current) return
        await streamPart(parts[index])
        if (index < parts.length - 1) scheduleSilence(parts[index].pauseMs)
      }
      if (run !== runRef.current) return
      streamDoneRef.current = true
      setStreamReady(true)
      releaseBrowserSpeechEngine()
      setDuration(Math.max(0, nextAtRef.current - firstAtRef.current))
      if (sourcesRef.current.size === 0) setPhase('finished')
    } catch (caught) {
      if (caught?.name === 'AbortError' || run !== runRef.current) return
      closeAudio('error')
      setError(caught?.message || 'Speech stopped unexpectedly.')
    }
  }, [appId, token, report, closeAudio, animate])

  const togglePause = async () => {
    const context = contextRef.current
    if (!context) return
    if (phase === 'playing') {
      await context.suspend()
      setPhase('paused')
    } else if (phase === 'paused') {
      await context.resume()
      setPhase('playing')
    }
  }

  const info = languageInfo(preferences.tts.language)
  const progress = streamReady && duration > 0
    ? Math.min(100, (elapsed / duration) * 100)
    : Math.max(0, Math.min(100, loadingProgress))
  const active = ['loading', 'playing', 'paused'].includes(phase)
  const label = phase === 'loading' && loadingProgress > 0 ? 'Downloading voice…'
    : phase === 'loading' ? 'Preparing voice…'
    : phase === 'playing' ? 'Pause'
      : phase === 'paused' ? 'Resume'
        : phase === 'finished' ? 'Listen again'
          : phase === 'error' ? 'Try again'
            : 'Listen to this digest'
  const status = active
    ? streamReady
      ? `${speechBackend === 'webgpu' ? 'WebGPU' : speechBackend === 'wasm' ? 'Wasm' : ''}${speechBackend ? ' · ' : ''}${clock(elapsed)} / ${clock(duration)}`
      : ''
    : `${info.label} · ${info.voice} voice`

  return (
    <div className={`nw-listen-player is-${phase}`}>
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
              className={`nw-listen-track${streamReady || loadingProgress > 0 ? '' : ' is-building'}`}
              role="progressbar"
              aria-label={streamReady ? 'Playback progress' : 'Preparing speech'}
              aria-valuemin="0"
              aria-valuemax="100"
              aria-valuenow={streamReady || loadingProgress > 0 ? String(Math.round(progress)) : undefined}
            >
              <span style={{ width: `${progress}%` }} />
            </span>
          )}
        </span>
      </button>
      {active && (
        <button type="button" className="nw-listen-stop" onClick={() => closeAudio('idle')}>
          <Stop aria-hidden="true" /> Stop
        </button>
      )}
      {error && <div className="nw-listen-error" role="alert">{error}</div>}
    </div>
  )
}
