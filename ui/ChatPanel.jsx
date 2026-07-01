import React, { useState, useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// Chat-split sizing — mirrors app-latex / app-webstudio / app-reflection so the
// chat reads the same across apps. chatOpen: the chat panel is visible (the
// read takes the top, the chat the bottom). chatRatio: 0..1 fraction of the
// reader-body height the chat panel occupies. Both persist per-app.
// ---------------------------------------------------------------------------
const CHAT_OPEN_VERSION = 1
const CHAT_RATIO_VERSION = 1
// Floor the chat pane at the embedded composer pill (~64px) + the divider
// (10px) so the input is never clipped; the same floor caps the OTHER end so
// the read never fully eats the chat.
const CHAT_PILL_MIN_PX = 64
const CHAT_DIVIDER_PX = 10
const CHAT_PANE_MIN_PX = CHAT_PILL_MIN_PX + CHAT_DIVIDER_PX

// Clamp a desired chat-pane height (px) into [pill, total - pill] and return it
// as a 0..1 ratio of the body. When the body is shorter than two pills, fall
// back to a 50/50 split so neither pane vanishes. Pure — unit-testable.
function clampChatRatio(desiredPx, total, minPx) {
  if (!(total > 0)) return 0.5
  const floor = minPx
  const ceil = total - minPx
  if (ceil <= floor) return 0.5
  const px = Math.max(floor, Math.min(ceil, desiredPx))
  return px / total
}

function chatOpenKey(appId) { return `nw:${appId}:chat-open:v${CHAT_OPEN_VERSION}` }
function chatRatioKey(appId) { return `nw:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}` }

function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(chatOpenKey(appId)) === 'true'
}

function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return 0.5
  return Math.max(0.05, Math.min(0.95, raw))
}

// ---------------------------------------------------------------------------
// App-scoped chat, presented as the bottom half of a 50/50 split — the same
// pattern app-latex / app-webstudio / app-reflection use (a draggable divider
// between the read above and the chat below), so the chat reads the same across
// apps. `window.mobius.chat` mounts the real ChatView (composer + live SSE +
// tappable AskUserQuestion cards) inside a nested same-origin iframe that runs
// in the SHELL origin — so it carries the owner JWT and can read/post chats
// (the app token alone is 403'd on /api/chats; this is the supported path). The
// runtime creates the chat once and persists its id under `chat_id.json`,
// reusing it on later mounts — so the conversation about your digests is
// durable and app-scoped.
//
// Mounted only while the split is open (rendered by ReportReader under
// `chatOpen`); closing the panel unmounts it and the cleanup destroys the
// handle — exactly app-latex's lifecycle. `getContext` is read through a ref
// updated by its own effect, so its identity changing (it closes over the
// report date) never re-fires the mount effect and remounts the iframe.
// ---------------------------------------------------------------------------
export function ChatPanel({ getContext }) {
  const mountRef = useRef(null)
  const [phase, setPhase] = useState('mounting') // mounting | live | unavailable
  // getContext is read through a ref so its identity changing (it closes over
  // the report date) never re-fires the mount effect and remounts the iframe.
  const getContextRef = useRef(getContext)
  useEffect(() => { getContextRef.current = getContext }, [getContext])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined
    if (!window.mobius || typeof window.mobius.chat !== 'function') {
      // Running outside the shell embed (e.g. standalone) — no chat bridge.
      setPhase('unavailable')
      return undefined
    }
    let handle = null
    let disposed = false
    setPhase('mounting')
    Promise.resolve(window.mobius.chat({
      mount,
      persist: 'chat_id.json',
      title: 'News',
      picker: true,
      getContext: () => {
        const fn = getContextRef.current
        return fn ? fn() : null
      },
    }))
      .then((h) => {
        if (disposed) { try { h && h.destroy && h.destroy() } catch {} return }
        handle = h
        setPhase('live')
      })
      .catch(() => { if (!disposed) setPhase('unavailable') })
    return () => {
      disposed = true
      try { handle && handle.destroy && handle.destroy() } catch {}
      // Belt-and-suspenders: the runtime appends one iframe to `mount`; clear
      // any leftover node so we never leak or stack the nested embed.
      if (mount) { try { mount.replaceChildren() } catch {} }
    }
  }, [])

  return (
    <section className="nw-chat-panel" aria-label="Chat about your digests">
      {phase === 'unavailable' ? (
        <div className="nw-no-chat-note">
          <span aria-hidden="true" className="nw-no-chat-glyph">💬</span>
          <span>
            The chat about your digests isn’t available here. Open it from your
            chat list to reply.
          </span>
        </div>
      ) : (
        <>
          {phase === 'mounting' && (
            <div className="nw-chat-resolving">
              <span className="nw-spinner nw-spinner-sm" aria-hidden="true" />
              Opening the conversation…
            </div>
          )}
          <div ref={mountRef} className="nw-chat-embed" style={{ display: phase === 'live' ? 'block' : 'none' }} />
        </>
      )}
    </section>
  )
}
