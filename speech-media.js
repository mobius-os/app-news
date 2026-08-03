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
