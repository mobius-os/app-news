import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, Stop, TextToSpeech } from '@openai/apps-sdk-ui/components/Icon'
import { languageInfo } from '../preferences.js'

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
}

function spokenText(value) {
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
  if (report?.html && typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(report.html, 'text/html')
    const selector = 'header > p, h1, details > summary, h2, h3, p, li, blockquote, .callout'
    const parts = []
    for (const element of document.body.querySelectorAll(selector)) {
      if (element.closest('script, style, template, [aria-hidden="true"]')) continue
      const text = spokenText(element.textContent)
      if (!text || parts.at(-1)?.text === text) continue
      const kind = partKind(element)
      parts.push({ text, pauseMs: PAUSE_AFTER[kind] || PAUSE_AFTER.paragraph, kind })
    }
    if (parts.length) return parts
  }

  const parts = []
  const push = (value, kind) => {
    const text = spokenText(value)
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

function joinBytes(first, second) {
  if (!first?.length) return second
  if (!second?.length) return first
  const joined = new Uint8Array(first.length + second.length)
  joined.set(first, 0)
  joined.set(second, first.length)
  return joined
}

function wavPayloadOffset(bytes) {
  if (bytes.length < 12) return -1
  const ascii = (at) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
  if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('The speech stream was not valid audio.')
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = ascii(offset)
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true)
    if (id === 'data') return offset + 8
    const next = offset + 8 + size + (size % 2)
    if (next > bytes.length) return -1
    offset = next
  }
  return -1
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
  const [prepared, setPrepared] = useState({ current: 0, total: 0 })
  const [streamReady, setStreamReady] = useState(false)
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
    setPrepared({ current: 0, total: 0 })
    setStreamReady(false)
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
    setPrepared({ current: 1, total: parts.length })
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
      setPhase((current) => current === 'paused' ? current : 'playing')
    }

    const scheduleSilence = (milliseconds) => {
      const sampleCount = Math.max(0, Math.round(SAMPLE_RATE * milliseconds / 1000))
      if (sampleCount) scheduleSamples(new Float32Array(sampleCount))
    }

    const streamPart = async (part) => {
      const response = await fetch(`/api/apps/${appId}/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: part.text, language: preferences.tts.language }),
        signal: controller.signal,
      })
      if (!response.ok) {
        let detail = ''
        try { detail = (await response.json())?.detail || '' } catch {}
        throw new Error(detail || `Speech could not start (HTTP ${response.status}).`)
      }
      if (!response.body) throw new Error('This browser did not expose the speech stream.')

      const reader = response.body.getReader()
      let headerBytes = new Uint8Array(0)
      let pcmBytes = new Uint8Array(0)
      let headerRead = false

      const schedulePcm = (bytes, final = false) => {
        pcmBytes = joinBytes(pcmBytes, bytes)
        const usable = pcmBytes.length - (pcmBytes.length % 2)
        // At least 100 ms keeps intermediary fragmentation from creating
        // hundreds of tiny WebAudio nodes.
        if (!final && usable < 4_800) return
        if (usable === 0) return
        const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, usable)
        const samples = new Float32Array(usable / 2)
        for (let index = 0; index < samples.length; index += 1) {
          samples[index] = view.getInt16(index * 2, true) / 32768
        }
        pcmBytes = pcmBytes.slice(usable)
        scheduleSamples(samples)
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (run !== runRef.current) return
        let bytes = value
        if (!headerRead) {
          headerBytes = joinBytes(headerBytes, bytes)
          const payloadAt = wavPayloadOffset(headerBytes)
          if (payloadAt < 0) continue
          bytes = headerBytes.slice(payloadAt)
          headerBytes = new Uint8Array(0)
          headerRead = true
        }
        schedulePcm(bytes)
      }
      schedulePcm(new Uint8Array(0), true)
    }

    try {
      animationRef.current = requestAnimationFrame(animate)
      for (let index = 0; index < parts.length; index += 1) {
        if (run !== runRef.current) return
        setPrepared({ current: index + 1, total: parts.length })
        await streamPart(parts[index])
        if (index < parts.length - 1) scheduleSilence(parts[index].pauseMs)
      }
      if (run !== runRef.current) return
      streamDoneRef.current = true
      setStreamReady(true)
      setDuration(Math.max(0, nextAtRef.current - firstAtRef.current))
      if (sourcesRef.current.size === 0) setPhase('finished')
    } catch (caught) {
      if (caught?.name === 'AbortError' || run !== runRef.current) return
      closeAudio('error')
      setError(caught?.message || 'Speech stopped unexpectedly.')
    }
  }, [appId, token, report, preferences.tts.language, closeAudio, animate])

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
  const progress = streamReady && duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0
  const active = ['loading', 'playing', 'paused'].includes(phase)
  const label = phase === 'loading' ? 'Preparing voice…'
    : phase === 'playing' ? 'Pause'
      : phase === 'paused' ? 'Resume'
        : phase === 'finished' ? 'Listen again'
          : phase === 'error' ? 'Try again'
            : 'Listen to this digest'
  const status = active
    ? streamReady
      ? `${clock(elapsed)} / ${clock(duration)}`
      : `${clock(elapsed)} · preparing ${prepared.current} of ${prepared.total}`
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
          <small>{status}</small>
          {active && (
            <span className={`nw-listen-track${streamReady ? '' : ' is-building'}`} aria-hidden="true">
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
