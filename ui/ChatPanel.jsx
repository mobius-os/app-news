import React, { useState, useEffect, useRef } from 'react'

// ---------------------------------------------------------------------------
// App-scoped chat, presented as the bottom half of a 50/50 split — the same
// pattern app-latex / app-webstudio / app-reflection use (a draggable divider
// between the read above and the chat below), so the chat reads the same across
// apps. `window.mobius.chat` mounts the real ChatView (composer + live SSE +
// tappable AskUserQuestion cards) inside a nested opaque iframe, authorizes it
// for this exact app chat, and keeps the owner credential out of both frames.
// The runtime creates the chat once and persists its id under `chat_id.json`,
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
      // The helper promise resolves when the iframe is inserted, not when it
      // has painted. Keep the cover until the shared runtime's visually-ready
      // signal so opening never exposes the blank authorization frame.
      onReady: () => { if (!disposed) setPhase('live') },
    }))
      .then((h) => {
        if (disposed) { try { h && h.destroy && h.destroy() } catch {} return }
        handle = h
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
          <div className="nw-chat-hint">
            Share feedback on today’s digest — what’s useful, what’s noise. Your notes steer tomorrow’s run.
          </div>
          <div className="nw-chat-stage">
            <div ref={mountRef} className="nw-chat-embed" />
            {phase === 'mounting' && (
              <div className="nw-chat-resolving">
                <span className="nw-spinner nw-spinner-sm" aria-hidden="true" />
                Opening the conversation…
              </div>
            )}
          </div>
        </>
      )}
    </section>
  )
}
