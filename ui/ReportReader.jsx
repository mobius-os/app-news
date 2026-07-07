import React, { useState, useEffect, useCallback, useRef } from 'react'
import { CHAT_PANE_MIN_PX } from '../constants.js'
import { formatDate, clampChatRatio, buildHtmlSrcDoc } from '../domain.js'
import { isErrorReport } from '../report-schema.mjs'
import {
  readChatOpen,
  readChatRatio,
  chatOpenKey,
  chatRatioKey,
  loadReportBody,
  saveQuestionAnswers,
} from '../storage.js'
import { signal, signalError } from '../signals.js'
import { ChatBubbleIcon } from './Icons.jsx'
import { ChatPanel } from './ChatPanel.jsx'
import { ReportQuestions } from './ReportQuestions.jsx'

export function ReportReader({ entry, appId, token, cachedReport, onBodyLoaded, onBack }) {
  const [report, setReport] = useState(cachedReport || null)
  // The app-scoped chat split's open/closed state + divider ratio. The chat
  // itself (see ChatPanel) is durable and app-scoped — window.mobius.chat
  // creates it once and persists its id under chat_id.json — so it's not tied
  // to any one digest's meta the way the old per-report launcher was.
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(appId))
  const [chatRatio, setChatRatio] = useState(() => readChatRatio(appId))
  const [phase, setPhase] = useState(cachedReport ? 'ready' : 'loading')
  // Height reported by the iframe's injected height-reporter script via
  // postMessage. Starts at a sane minimum (~70vh in px equivalent so
  // the iframe never looks tiny before the first message arrives).
  const [iframeHeight, setIframeHeight] = useState(500)
  // Identifies OUR report iframe in the message listener: the sandboxed
  // frame has a null origin so ev.origin can't be checked — ev.source
  // against this ref's contentWindow is the only way to reject spoofed
  // news:report-height messages from other windows.
  const iframeRef = useRef(null)
  // The reader body — the resize math measures its height to convert a pointer
  // drag into a 0..1 ratio.
  const bodyRef = useRef(null)
  const errorViewedRef = useRef(new Set())

  // Persist chat open + split ratio per app (mirrors app-latex).
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatOpenKey(appId), String(chatOpen)) } catch {}
  }, [appId, chatOpen])
  useEffect(() => {
    if (typeof localStorage === 'undefined') return
    try { localStorage.setItem(chatRatioKey(appId), String(chatRatio)) } catch {}
  }, [appId, chatRatio])

  // Open always spawns a fresh 50/50 split, regardless of where a prior drag
  // left the divider (owner spec, app-latex parity).
  const toggleChat = useCallback(() => {
    setChatOpen((open) => {
      if (!open) setChatRatio(0.5)
      return !open
    })
  }, [])

  // Drag the divider: convert vertical pointer movement into a chat ratio,
  // px-bounded so the chat collapses to exactly the composer pill and no
  // smaller, and the read keeps at least one pill visible. Ported from
  // app-latex (same pointer-capture teardown for an interrupted drag —
  // pointercancel / lostpointercapture, not just pointerup).
  const beginChatResize = useCallback((event) => {
    event.preventDefault()
    const body = bodyRef.current
    if (!body) return
    const total = body.getBoundingClientRect().height
    if (!total) return
    const startY = event.clientY
    const startRatioPx = total * chatRatio
    const divider = event.currentTarget
    const pointerId = event.pointerId
    divider.setPointerCapture?.(pointerId)
    const onMove = (moveEvent) => {
      const desiredPx = startRatioPx + startY - moveEvent.clientY
      setChatRatio(clampChatRatio(desiredPx, total, CHAT_PANE_MIN_PX))
    }
    const endDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      divider.removeEventListener('lostpointercapture', endDrag)
      try { divider.releasePointerCapture?.(pointerId) } catch {}
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', endDrag)
    window.addEventListener('pointercancel', endDrag)
    divider.addEventListener('lostpointercapture', endDrag)
  }, [chatRatio])

  // Keyboard resize on the focused divider: Arrows step ~6%, Home collapses the
  // chat to the pill, End leaves one pill of read — all clamped by the same
  // floors as the drag path.
  const handleResizeKey = useCallback((event) => {
    const total = bodyRef.current?.getBoundingClientRect().height || 0
    if (!total) return
    const step = total * 0.06
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total + step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setChatRatio((r) => clampChatRatio(r * total - step, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setChatRatio(clampChatRatio(0, total, CHAT_PANE_MIN_PX))
    } else if (event.key === 'End') {
      event.preventDefault()
      setChatRatio(clampChatRatio(total, total, CHAT_PANE_MIN_PX))
    }
  }, [])

  // Keep the body-cache callback and the cached fallback in refs so they
  // stay OUT of the load effect's dependency list. They used to be deps,
  // which created a feedback loop: the effect loads the body → calls
  // onBodyLoaded → the parent caches it → `cachedReport` (and sometimes
  // `onBodyLoaded`) get a fresh identity → the effect re-runs → loads
  // again. That was a 100+ fetch storm per open. The load must fire once
  // per report date.
  const onBodyLoadedRef = useRef(onBodyLoaded)
  onBodyLoadedRef.current = onBodyLoaded
  const cachedReportRef = useRef(cachedReport)
  cachedReportRef.current = cachedReport

  useEffect(() => {
    let cancelled = false
    const cached = cachedReportRef.current
    setReport(cached || null)
    setPhase(cached ? 'ready' : 'loading')
    ;(async () => {
      const body = await loadReportBody(appId, token, entry)
      if (cancelled) return
      if (body) {
        setReport(body)
        setPhase('ready')
        onBodyLoadedRef.current?.(entry.date, body)
      } else if (!cachedReportRef.current) {
        setPhase('error')
        signalError('report body failed', 'report_reader')
      }
    })()
    return () => { cancelled = true }
  }, [appId, token, entry.date, entry.ext])

  // Reset iframe height when a new report is loaded so we never show
  // the previous report's height before the first postMessage arrives.
  useEffect(() => {
    setIframeHeight(500)
  }, [entry.date])

  useEffect(() => {
    if (!report?.html || errorViewedRef.current.has(report.date)) return
    // Same detection the manual-generate gating uses (report-schema.isErrorReport)
    // so "an error report was viewed" and "a generate landed an error report"
    // can never disagree.
    if (isErrorReport(report)) {
      errorViewedRef.current.add(report.date)
      signal('report_error_viewed', { date: report.date })
    }
  }, [report])

  // Size the report iframe from postMessage events sent by the injected
  // height-reporter script (see buildHtmlSrcDoc + NEWS_REPORT_HEIGHT_SCRIPT).
  // The iframe runs with allow-scripts but WITHOUT allow-same-origin, so
  // contentDocument is NOT readable from the parent — height is received
  // passively via postMessage instead.
  useEffect(() => {
    const onMessage = (ev) => {
      if (!ev.data || ev.data.type !== 'news:report-height') return
      if (ev.source !== iframeRef.current?.contentWindow) return
      const h = Number(ev.data.height)
      if (Number.isFinite(h) && h > 0) {
        // No buffer: the reporter sends Math.ceil of the documentElement's
        // border-box height, which is already exact — adding padding here
        // would just re-introduce creep. Clamp to a sane ceiling so a
        // runaway report can't grow the page unboundedly (matches
        // dreaming's 16000px ceiling).
        setIframeHeight(Math.min(Math.max(h, 200), 16000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="nw-reader">
      <div className="nw-reader-bar">
        <button type="button" className="nw-reader-back" onClick={onBack}>← Back</button>
        <div className="nw-reader-title">{formatDate(entry.date)}</div>
        <button
          type="button"
          className="nw-chat-toggle"
          aria-label="Chat about your digests"
          aria-pressed={chatOpen}
          title="Chat"
          onClick={() => {
            // Engagement signal on the closed→open edge only (once per open),
            // restoring the signal the removed per-digest launcher used to emit.
            if (!chatOpen) {
              signal('feedback_given', { date: entry.date, signal: 'chat' })
              signal('chat_opened', { type: 'digest' })
            }
            toggleChat()
          }}
        >
          <ChatBubbleIcon size={20} />
        </button>
      </div>
      {/* The reader body. When the chat is open it becomes a vertical split:
          the digest read scrolls in the top pane, a draggable divider sits in
          the middle, and the app-scoped chat fills the bottom --chat-ratio
          share (the same layout app-latex / app-webstudio use). When closed it
          is just the scrolling read. */}
      <div
        ref={bodyRef}
        className="nw-reader-split"
        style={chatOpen ? { '--chat-ratio': chatRatio, '--chat-pane-min': `${CHAT_PANE_MIN_PX}px` } : undefined}
      >
        <div className="nw-reader-body">
          {phase === 'loading' && <div className="nw-loading">Loading report…</div>}
          {phase === 'error' && (
            <div className="nw-empty">
              <div className="nw-empty__mark" aria-hidden="true">!</div>
              <h2 className="nw-empty__title">Report could not load</h2>
              <p className="nw-empty__subtitle">Try again when the storage service is reachable.</p>
            </div>
          )}
          {report && report.html && (
            <iframe
              title={`News digest for ${report.date}`}
              // allow-scripts lets the injected height-reporter run.
              // allow-same-origin is intentionally absent: without it the
              // iframe gets a null origin, so its scripts cannot reach the
              // parent's DOM, localStorage, or owner JWT regardless of what
              // the report HTML contains. allow-popups lets external links
              // open in a new tab.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              srcDoc={buildHtmlSrcDoc(report)}
              className="nw-reader-frame"
              ref={iframeRef}
              style={{ height: `${iframeHeight}px` }}
            />
          )}
          {report && !report.html && (
            <div className="nw-report-container is-reader">
              {report.summary && <div className="nw-glance">{report.summary}</div>}
              {(report.sections || []).map((section, si) => (
                <div key={si}>
                  {section.title && <div className="nw-section-title">{section.title}</div>}
                  {(section.articles || []).map((art, ai) => (
                    <div key={ai} className="nw-article">
                      <p className="nw-headline">{art.headline}</p>
                      <p className="nw-article-summary">{art.summary}</p>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
          {/* Native question cards render inline below the read — the carrier
              was extracted from the raw HTML and stripped before srcDoc, so
              these taps are the only interactive surface. Answers persist for
              the NEXT run; no live agent waits. */}
          {report && report.questions && report.questions.length > 0 && (
            <ReportQuestions
              questions={report.questions}
              onAnswer={async (answers) => {
                // Report durability back to the card: it only locks to
                // "answered" when the write actually landed (synced) or was
                // queued offline. {ok:false} is a lost write — return false so
                // the card stays interactive and offers a retry.
                const res = await saveQuestionAnswers(
                  appId, token, report.date, answers, report.questions,
                )
                const durable = !!(res && (res.synced || res.queued))
                if (durable) {
                  signal('feedback_given', { signal: 'questions' })
                }
                return durable
              }}
            />
          )}
        </div>

        {chatOpen && (
          <>
            <div
              className="nw-chat-divider"
              role="separator"
              aria-label="Resize digest and chat areas"
              aria-orientation="horizontal"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(chatRatio * 100)}
              tabIndex={0}
              onPointerDown={beginChatResize}
              onKeyDown={handleResizeKey}
            >
              <span className="nw-chat-divider-bar" aria-hidden="true" />
            </div>
            <ChatPanel getContext={() => ({ app: 'news', report_date: entry.date })} />
          </>
        )}
      </div>
    </div>
  )
}
