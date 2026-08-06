import React, { useState, useEffect, useCallback, useRef } from 'react'
import { ArrowLeft } from '@openai/apps-sdk-ui/components/Icon'
import { CHAT_PANE_MIN_PX } from '../constants.js'
import {
  formatDate,
  clampChatRatio,
  buildHtmlSrcDoc,
  reportImageSources,
  isProxyableReportImageMime,
  isSafeReportImageDataUrl,
  safeImgSrc,
} from '../domain.js'
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
import { ListenControls } from './ListenControls.jsx'

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('image conversion failed'))
    reader.readAsDataURL(blob)
  })
}

export function ReportReader({ entry, appId, token, preferences, cachedReport, onBodyLoaded, onBack }) {
  const [report, setReport] = useState(cachedReport || null)
  // The app-scoped chat split's open/closed state + divider ratio. The chat
  // itself (see ChatPanel) is durable and app-scoped — window.mobius.chat
  // creates it once and persists its id under chat_id.json — so it's not tied
  // to any one digest's meta the way the old per-report launcher was.
  const [chatOpen, setChatOpen] = useState(() => readChatOpen(appId))
  const [chatRatio, setChatRatio] = useState(() => readChatRatio(appId))
  const [phase, setPhase] = useState(cachedReport ? 'ready' : 'loading')
  // Building the sandboxed report document sanitizes and themes a sizeable
  // HTML fragment. Prepare it only after the opaque reader shell has painted,
  // so that work can never hold the old report list on screen.
  const [reportSrcDoc, setReportSrcDoc] = useState('')
  // Height reported by the iframe's injected height-reporter script via
  // postMessage. The initial value is only an invisible measurement bootstrap;
  // the frame is revealed after its first real height arrives.
  const [iframeHeight, setIframeHeight] = useState(500)
  const [reportMeasured, setReportMeasured] = useState(false)
  // The report mounts immediately; proxied images arrive progressively by
  // postMessage so a slow publisher image never delays readable text or
  // navigates the iframe by replacing srcdoc. Keep the delivered URLs in a
  // ref so the iframe's load event can replay anything that arrived early.
  const deliveredImagesRef = useRef({})
  const [activeImage, setActiveImage] = useState(null)
  // Identifies OUR report iframe in the message listener: the sandboxed
  // frame has a null origin so ev.origin can't be checked — ev.source
  // against this ref's contentWindow is the only way to reject spoofed
  // news:report-height messages from other windows.
  const iframeRef = useRef(null)
  const imageNavRef = useRef(null)
  const imageCloseRef = useRef(null)
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

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    deliveredImagesRef.current = {}
    const sources = reportImageSources(report?.html)
    void Promise.allSettled(sources.map(async (src) => {
      const response = await fetch(`/api/proxy?url=${encodeURIComponent(src)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`image proxy returned ${response.status}`)
      const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim()
      if (!isProxyableReportImageMime(mime)) throw new Error('unsupported image type')
      const blob = await response.blob()
      if (blob.size > 2_097_152) throw new Error('image exceeds proxy size limit')
      const dataUrl = await blobToDataUrl(blob)
      if (cancelled || !isSafeReportImageDataUrl(dataUrl)) return
      deliveredImagesRef.current = {
        ...deliveredImagesRef.current,
        [src]: dataUrl,
      }
      iframeRef.current?.contentWindow?.postMessage({
        type: 'news:report-images',
        images: { [src]: dataUrl },
      }, '*')
      setActiveImage((current) => (
        current?.originalSrc === src ? { ...current, src: dataUrl } : current
      ))
    }))

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [report?.html, token])

  const closeImageSheet = useCallback(() => {
    const handle = imageNavRef.current
    imageNavRef.current = null
    handle?.close()
    setActiveImage(null)
  }, [])

  const openImageSheet = useCallback(async (image) => {
    imageNavRef.current?.close()
    imageNavRef.current = null
    setActiveImage(null)
    const nav = window.mobius?.nav
    if (!nav?.open) {
      setActiveImage(image)
      return
    }
    let handle = null
    handle = nav.open('news-image', {
      onBack: () => {
        if (imageNavRef.current === handle) imageNavRef.current = null
        setActiveImage(null)
      },
      onForward: () => {
        imageNavRef.current = handle
        setActiveImage(image)
      },
    })
    imageNavRef.current = handle
    const { status } = await handle.outcome
    if (imageNavRef.current !== handle) {
      handle.close()
      return
    }
    if (status === 'owned' || status === 'standalone') {
      setActiveImage(image)
    } else {
      imageNavRef.current = null
    }
  }, [])

  // Size the report iframe from postMessage events sent by the injected
  // height-reporter script (see buildHtmlSrcDoc + NEWS_REPORT_HEIGHT_SCRIPT).
  // The iframe runs with allow-scripts but WITHOUT allow-same-origin, so
  // contentDocument is NOT readable from the parent — height is received
  // passively via postMessage instead.
  useEffect(() => {
    const onMessage = (ev) => {
      if (ev.source !== iframeRef.current?.contentWindow) return
      if (!ev.data) return
      if (ev.data.type === 'news:report-height') {
        const h = Number(ev.data.height)
        if (!Number.isFinite(h) || h <= 0) return
        // No buffer: the reporter sends Math.ceil of the documentElement's
        // border-box height, which is already exact — adding padding here
        // would just re-introduce creep. Clamp to a sane ceiling so a
        // runaway report can't grow the page unboundedly (matches
        // dreaming's 16000px ceiling).
        setIframeHeight(Math.min(Math.max(h, 200), 16000))
        // Keep the bootstrap-height frame and native question cards behind
        // the loader until this first real measurement can place the whole
        // report atomically.
        setReportMeasured(true)
        return
      }
      if (ev.data.type !== 'news:open-image') return
      const originalSrc = safeImgSrc(ev.data.originalSrc)
      if (!originalSrc) return
      const delivered = deliveredImagesRef.current[originalSrc]
      const text = (value, max) => (
        typeof value === 'string' ? value.trim().slice(0, max) : ''
      )
      void openImageSheet({
        originalSrc,
        src: isSafeReportImageDataUrl(delivered) ? delivered : originalSrc,
        alt: text(ev.data.alt, 500),
        caption: text(ev.data.caption, 1000),
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [openImageSheet])

  useEffect(() => {
    if (!activeImage) return undefined
    imageCloseRef.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') closeImageSheet()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activeImage, closeImageSheet])

  useEffect(() => () => {
    imageNavRef.current?.close()
    imageNavRef.current = null
  }, [])

  const reportHtml = report?.html || ''
  useEffect(() => {
    setIframeHeight(500)
    setReportMeasured(false)
    setReportSrcDoc('')
    if (!reportHtml) return undefined
    let paintFrame = 0
    let buildFrame = 0
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0
      buildFrame = requestAnimationFrame(() => {
        buildFrame = 0
        setReportSrcDoc(buildHtmlSrcDoc({ html: reportHtml }))
      })
    })
    return () => {
      if (paintFrame) cancelAnimationFrame(paintFrame)
      if (buildFrame) cancelAnimationFrame(buildFrame)
    }
  }, [reportHtml])

  const htmlReportReady = !!reportSrcDoc && reportMeasured
  const reportReady = phase === 'ready' && (!reportHtml || htmlReportReady)
  const preparingReport = phase === 'ready' && !!reportHtml && !htmlReportReady

  return (
    <div className="nw-reader">
      <div className="nw-reader-bar">
        <button type="button" className="nw-reader-back" onClick={onBack}>
          <ArrowLeft width="1em" height="1em" aria-hidden="true" />
          Back
        </button>
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
      {reportReady && report && preferences?.tts?.enabled && (
        <ListenControls report={report} />
      )}
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
          {(phase === 'loading' || preparingReport) && (
            <div className="nw-reader-loading" role="status">
              <span className="nw-spinner" aria-hidden="true" />
              <span>{preparingReport ? 'Opening report…' : 'Loading report…'}</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="nw-empty">
              <div className="nw-empty__mark" aria-hidden="true">!</div>
              <h2 className="nw-empty__title">Report could not load</h2>
              <p className="nw-empty__subtitle">Try again when the storage service is reachable.</p>
            </div>
          )}
          {report && reportHtml && reportSrcDoc && (
            <iframe
              title={`News digest for ${report.date}`}
              // allow-scripts lets the injected height-reporter run.
              // allow-same-origin is intentionally absent: without it the
              // iframe gets a null origin, so its scripts cannot reach the
              // parent's DOM, localStorage, or owner JWT regardless of what
              // the report HTML contains. allow-popups lets external links
              // open in a new tab.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              srcDoc={reportSrcDoc}
              className={`nw-reader-frame${reportMeasured ? '' : ' is-measuring'}`}
              aria-hidden={!reportMeasured}
              ref={iframeRef}
              onLoad={() => {
                const images = deliveredImagesRef.current
                if (Object.keys(images).length > 0) {
                  iframeRef.current?.contentWindow?.postMessage({
                    type: 'news:report-images',
                    images,
                  }, '*')
                }
              }}
              style={{ height: `${iframeHeight}px` }}
            />
          )}
          {reportReady && report && !reportHtml && (
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
          {reportReady && report?.questions?.length > 0 && (
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
      {activeImage && (
        <div
          className="nw-image-scrim"
          role="dialog"
          aria-modal="true"
          aria-label="Report image"
          onClick={closeImageSheet}
        >
          <div className="nw-image-sheet" onClick={(event) => event.stopPropagation()}>
            <div className="nw-image-sheet__head">
              <div className="nw-image-sheet__title">Report image</div>
              <button
                ref={imageCloseRef}
                type="button"
                className="nw-image-sheet__close"
                onClick={closeImageSheet}
              >
                Close
              </button>
            </div>
            <div className="nw-image-sheet__media">
              <img src={activeImage.src} alt={activeImage.alt || activeImage.caption || ''} />
            </div>
            {(activeImage.caption || activeImage.alt) && (
              <p className="nw-image-sheet__caption">
                {activeImage.caption || activeImage.alt}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
