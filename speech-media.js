const MEDIA_ACTIONS = ['play', 'pause', 'stop']

function setActionHandler(session, action, handler) {
  try {
    session?.setActionHandler?.(action, handler || null)
  } catch {
    // Browsers expose different subsets of Media Session actions. An absent
    // lock-screen button must not prevent ordinary in-app playback.
  }
}

function runAction(handler) {
  if (!handler) return
  try {
    Promise.resolve(handler()).catch(() => {})
  } catch {
    // OS media controls are sidecar input. The visible player owns errors.
  }
}

function mediaMetadata(value, Metadata = globalThis.MediaMetadata) {
  if (!value) return null
  if (typeof Metadata !== 'function') return value
  try { return new Metadata(value) } catch { return null }
}

const PITCH_PROCESSOR = 'soundtouch-processor'
const FINAL_DRAIN_MS = 400

function setParam(parameter, value, at) {
  if (!parameter) throw new Error('The pitch-preserving speech control is unavailable.')
  parameter.cancelScheduledValues?.(at)
  if (typeof parameter.setValueAtTime === 'function') parameter.setValueAtTime(value, at)
  else parameter.value = value
}

/**
 * Load the host-reviewed worklet into the opaque app frame and expose one
 * streaming output. The source and worklet receive the same playback rate:
 * the source supplies audio quickly enough for real-time playback, while the
 * worklet compensates the corresponding pitch shift.
 */
export async function createPitchPreservingSpeechOutput({
  context,
  destination,
  workletUrl,
  fetcher = globalThis.fetch,
  BlobClass = globalThis.Blob,
  urlApi = globalThis.URL,
  WorkletNode = globalThis.AudioWorkletNode,
}) {
  if (!context?.audioWorklet?.addModule || typeof WorkletNode !== 'function') {
    throw new Error('This browser cannot preserve voice pitch while changing speed.')
  }
  if (typeof fetcher !== 'function' || typeof BlobClass !== 'function'
    || typeof urlApi?.createObjectURL !== 'function') {
    throw new Error('The pitch-preserving speech processor could not be loaded.')
  }
  const response = await fetcher(workletUrl, { credentials: 'same-origin' })
  if (!response?.ok) {
    throw new Error(`The pitch-preserving speech processor returned ${response?.status || 'an error'}.`)
  }
  const sourceText = await response.text()
  const moduleUrl = urlApi.createObjectURL(new BlobClass([sourceText], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    urlApi.revokeObjectURL?.(moduleUrl)
  }

  const node = new WorkletNode(context, PITCH_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    processorOptions: { sampleBufferType: 'circular' },
  })
  node.connect(destination)
  // The processor retains a short overlap window. Keep a zero-valued source
  // connected so it can drain that window between semantic sections instead
  // of receiving an empty input bus and clipping the tail.
  const keepAliveBuffer = context.createBuffer(1, 1, context.sampleRate)
  const keepAlive = context.createBufferSource()
  keepAlive.buffer = keepAliveBuffer
  keepAlive.loop = true
  keepAlive.connect(node)
  keepAlive.start()
  const workletRate = node.parameters?.get?.('playbackRate')
  let active = null
  let disposed = false
  let rate = 1

  const elapsedAt = (at = context.currentTime) => {
    if (!active) return 0
    const wallSeconds = Math.max(0, at - active.rateChangedAt)
    return Math.min(
      active.logicalDuration,
      active.consumedSeconds + wallSeconds * active.rate,
    )
  }

  const setRate = (nextRate) => {
    const next = Number(nextRate)
    if (!Number.isFinite(next) || next <= 0) return rate
    const at = context.currentTime
    if (active) {
      active.consumedSeconds = elapsedAt(at)
      active.rateChangedAt = at
      active.rate = next
      setParam(active.source.playbackRate, next, at)
    }
    setParam(workletRate, next, at)
    rate = next
    return rate
  }

  const stop = () => {
    if (!active) return
    const source = active.source
    active = null
    source.onended = null
    try { source.stop() } catch {}
    try { source.disconnect() } catch {}
  }

  return {
    setRate,
    elapsedSeconds: elapsedAt,
    play(samples, {
      sampleRate,
      pauseAfterMs = 0,
      playbackRate = rate,
      final = false,
      onEnded,
    } = {}) {
      if (disposed) throw new Error('Speech playback is closed.')
      if (active) throw new Error('Speech playback already has an active section.')
      if (!(samples instanceof Float32Array) || !samples.length) {
        throw new Error('A readable speech section produced no audio.')
      }
      const sourceRate = Math.max(1, Math.floor(Number(sampleRate) || context.sampleRate || 1))
      const pauseSamples = Math.max(0, Math.round(sourceRate * Number(pauseAfterMs || 0) / 1000))
      const finalDrainSamples = final ? Math.round(sourceRate * FINAL_DRAIN_MS / 1000) : 0
      const buffer = context.createBuffer(
        1,
        samples.length + pauseSamples + finalDrainSamples,
        sourceRate,
      )
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(node)
      const startedAt = context.currentTime
      const logicalDuration = (samples.length + pauseSamples) / sourceRate
      active = {
        source,
        startedAt,
        rateChangedAt: startedAt,
        consumedSeconds: 0,
        logicalDuration,
        rate: Number(playbackRate) || rate,
      }
      setRate(active.rate)
      source.onended = () => {
        if (active?.source !== source) return
        const completed = active.logicalDuration
        active = null
        onEnded?.(completed)
      }
      source.start(startedAt)
      return { logicalDuration }
    },
    stop,
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      try { keepAlive.stop() } catch {}
      try { keepAlive.disconnect() } catch {}
      try { node.disconnect() } catch {}
    },
  }
}

/**
 * Route the Web Audio graph through a real HTMLAudioElement. Mobile browsers
 * grant native media focus and lock-screen controls to media elements, while
 * a bare AudioContext may be suspended as soon as the page is backgrounded.
 */
export function createSpeechMediaBridge({
  context,
  element,
  metadata,
  onPlay,
  onPause,
  onStop,
  navigatorObject = globalThis.navigator,
  Metadata = globalThis.MediaMetadata,
}) {
  if (!context?.createMediaStreamDestination) {
    throw new Error('This browser cannot stream speech through native media playback.')
  }
  if (!element || !('srcObject' in element)) {
    throw new Error('This browser cannot attach streamed speech to its media player.')
  }

  const destination = context.createMediaStreamDestination()
  const stream = destination.stream
  const session = navigatorObject?.mediaSession
  const audioSession = navigatorObject?.audioSession
  let disposed = false
  const ownedMetadata = mediaMetadata(metadata, Metadata)

  element.autoplay = true
  element.playsInline = true
  element.preload = 'none'
  element.srcObject = stream

  // Safari 17+ can classify Web Audio as long-form playback. Feature-detect:
  // other engines either omit AudioSession or may reject an unknown type.
  try { if (audioSession) audioSession.type = 'playback' } catch {}

  if (session) {
    session.metadata = ownedMetadata
    setActionHandler(session, 'play', () => runAction(onPlay))
    setActionHandler(session, 'pause', () => runAction(onPause))
    setActionHandler(session, 'stop', () => runAction(onStop))
  }

  const setPlaybackState = (state) => {
    try {
      if (session && session.metadata === ownedMetadata) session.playbackState = state
    } catch {}
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    element.pause()
    element.srcObject = null
    for (const track of stream?.getTracks?.() || []) {
      try { track.stop() } catch {}
    }
    // Media Session is shared browser state. A cached News frame can unmount
    // after another player has taken focus, so only undo handlers while our
    // exact metadata object still identifies us as the owner.
    if (session && session.metadata === ownedMetadata) {
      setPlaybackState('none')
      session.metadata = null
      for (const action of MEDIA_ACTIONS) setActionHandler(session, action, null)
    }
    try { if (audioSession) audioSession.type = 'auto' } catch {}
  }

  return {
    destination,
    async start() {
      if (disposed) return
      await element.play()
      setPlaybackState('playing')
    },
    async pause() {
      if (disposed) return
      element.pause()
      if (context.state !== 'closed') await context.suspend()
      setPlaybackState('paused')
    },
    async resume() {
      if (disposed) return
      if (context.state !== 'closed') await context.resume()
      await element.play()
      setPlaybackState('playing')
    },
    finish() {
      dispose()
    },
    dispose,
  }
}
