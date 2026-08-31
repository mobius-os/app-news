const PLAYBACK_STATES = new Set(['loading', 'playing', 'paused'])
const PLAYBACK_ACTIONS = new Set(['play', 'pause', 'stop', 'cycle-speed'])

function safePlaybackRate(value) {
  const rate = Number(value)
  return Number.isFinite(rate) && rate >= 0.25 && rate <= 4 ? rate : 1
}

function sessionId() {
  return globalThis.crypto?.randomUUID?.()
    || `news-playback-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Publish News-owned playback to the shell. Audio, timing, and native Media
 * Session integration remain in News; this lease carries metadata and actions.
 */
export function openShellPlayback({ title, playbackRate = 1, onControl, ownWindow = window }) {
  const parent = ownWindow.parent
  if (!parent || parent === ownWindow) {
    return { setState() {}, setPlaybackRate() {}, close() {} }
  }
  const id = sessionId()
  const safeTitle = String(title || 'Daily digest').trim().slice(0, 120) || 'Daily digest'
  let currentState = 'loading'
  let currentRate = safePlaybackRate(playbackRate)
  let closed = false

  const post = (message) => {
    try {
      parent.postMessage(message, ownWindow.location.origin)
      return true
    } catch {
      return false
    }
  }
  const onMessage = (event) => {
    if (closed || event.source !== parent || event.origin !== ownWindow.location.origin) return
    const message = event.data
    if (!message || message.type !== 'moebius:media-control') return
    if (message.sessionId !== id || !PLAYBACK_ACTIONS.has(message.action)) return
    try { Promise.resolve(onControl?.(message.action)).catch(() => {}) } catch {}
  }
  ownWindow.addEventListener('message', onMessage)
  post({
    type: 'moebius:media-session',
    event: 'open',
    sessionId: id,
    title: safeTitle,
    playbackState: currentState,
    playbackRate: currentRate,
  })

  return {
    setState(playbackState) {
      if (closed || !PLAYBACK_STATES.has(playbackState)) return
      currentState = playbackState
      post({
        type: 'moebius:media-session',
        event: 'update',
        sessionId: id,
        title: safeTitle,
        playbackState: currentState,
        playbackRate: currentRate,
      })
    },
    setPlaybackRate(nextRate) {
      if (closed) return
      currentRate = safePlaybackRate(nextRate)
      post({
        type: 'moebius:media-session',
        event: 'update',
        sessionId: id,
        title: safeTitle,
        playbackState: currentState,
        playbackRate: currentRate,
      })
    },
    close() {
      if (closed) return
      closed = true
      ownWindow.removeEventListener('message', onMessage)
      post({ type: 'moebius:media-session', event: 'close', sessionId: id })
    },
  }
}
