// News — thin app shell. The module tree is declared in mobius.json's
// source_files; the multi-file installer fetches each path and esbuild bundles
// from this entry, resolving the relative imports below at compile time.
//
//   constants.js  — shared scalar tables + template-literal blocks (CSP,
//                    height-reporter script, editorial-brief defaults)
//   theme.js      — the single app stylesheet (CSS)
//   report-schema.mjs — canonical, unit-tested pure schema validators
//   domain.js     — pure + DOM-level report logic (sanitizer, srcdoc builder,
//                    schedule/date/provider helpers); no React, no network I/O
//   storage.js    — offline storage layer, caches, useOnline + chat-split keys
//   ui/*.jsx      — one React component per file
//
// Only App lives here: it owns the tab state, the online signal, and the
// dead-letter banner, then mounts ReportsTab / SettingsTab.
import React, { useState, useEffect, useRef } from 'react'
import { CSS } from './theme.js'
import { useOnline } from './storage.js'
import { ReportsTab } from './ui/ReportsTab.jsx'
import { SettingsTab } from './ui/SettingsTab.jsx'

// Re-export the write-outcome helpers so the durable-write unit suite can
// import them from the bundled entry (it esbuild-bundles index.jsx and reads
// the named test-only exports); their implementation lives in storage.js.
export { durableWriteOutcome, classifyWriteOutcome } from './storage.js'

const SETUP_COMPLETIONS_KEY = 'mobius:setup-complete:v1'

function markSetupComplete(appId) {
  if (appId == null || typeof window === 'undefined') return
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETUP_COMPLETIONS_KEY) || '{}')
    const data = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    data[String(appId)] = { completedAt: new Date().toISOString() }
    window.localStorage.setItem(SETUP_COMPLETIONS_KEY, JSON.stringify(data))
  } catch {}
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(
      { type: 'moebius:setup-complete', appId },
      window.location.origin,
    )
  }
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')
  const tabRefs = useRef([])
  const online = useOnline()
  const onTabKeyDown = (event, index) => {
    const order = ['reports', 'settings']
    let nextIndex = index
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % order.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + order.length) % order.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = order.length - 1
    else return
    event.preventDefault()
    setTab(order[nextIndex])
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus())
  }
  // A write the user saw confirmed as "Saved offline — will sync" but the
  // server later REFUSED on drain. That dead-letter arrives asynchronously,
  // long after the inline toast is gone, so onDeadLetter is the only honest
  // way to correct the record. Subscribe ONCE on mount (it replays any
  // unconsumed rejection that landed before this listener attached).
  const [deadLetter, setDeadLetter] = useState(null)
  useEffect(() => {
    const onDeadLetter = window.mobius?.onDeadLetter
    if (typeof onDeadLetter !== 'function') return undefined
    return onDeadLetter((rec) => {
      // schedule.json is only a display MIRROR — the cron POST is the
      // authoritative save (see saveSchedule), so a mirror dead-letter is benign
      // (at worst a stale displayed time). Don't alarm over a schedule that saved.
      if (rec.path === 'schedule.json') return
      // rec.path is the storage path; show a human label for the known files.
      const label = rec.path === 'topics.txt' ? 'editorial brief'
        : rec.path === 'agent.json' ? 'agent settings'
        : rec.path?.startsWith?.('question-answers/') ? 'your answers'
        : 'a change'
      setDeadLetter({ label, status: rec.status })
    })
  }, [])

  useEffect(() => {
    function onMessage(e) {
      if (e.origin !== window.location.origin) return
      if (e.data?.type === 'moebius:app-intent' && e.data.intent === 'setup') {
        setTab('settings')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="nw-root">
      <style>{CSS}</style>
      {deadLetter && (
        <div className="nw-deadletter" role="alert">
          <span className="nw-deadletter__msg">
            Your {deadLetter.label} couldn’t be saved — the server rejected it
            {deadLetter.status ? ` (HTTP ${deadLetter.status})` : ''}. Please try again.
          </span>
          <button
            type="button"
            className="nw-deadletter__close"
            aria-label="Dismiss"
            onClick={() => setDeadLetter(null)}
          >
            ×
          </button>
        </div>
      )}
      <div className="nw-header">
        {/* Brand row: the app's own glossy icon (downscaled+cached by the
            backend, ?size=64 → ~6KB) followed by the "News" wordmark — the
            one app in the catalog that pairs its mark with a text label. The
            icon falls back to an accent dot when an install has no custom
            icon (the route 404s). */}
        <div className="nw-brand">
          <img
            src={`/api/apps/${appId}/icon?size=64`}
            alt=""
            width={34}
            height={34}
            className="nw-brand-icon"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
              const f = e.currentTarget.nextElementSibling
              if (f) f.style.display = 'flex'
            }}
          />
          <span className="nw-brand-fallback" style={{ display: 'none' }} aria-hidden="true">·</span>
          <h1 className="nw-title">News</h1>
        </div>
        <div className="nw-tabs" role="tablist" aria-label="View">
          <button
            id="nw-tab-reports"
            ref={(node) => { tabRefs.current[0] = node }}
            type="button"
            role="tab"
            aria-selected={tab === 'reports'}
            aria-controls="nw-panel-reports"
            tabIndex={tab === 'reports' ? 0 : -1}
            className={`nw-tab${tab === 'reports' ? ' is-active' : ''}`}
            onClick={() => setTab('reports')}
            onKeyDown={(event) => onTabKeyDown(event, 0)}
          >
            Reports
          </button>
          <button
            id="nw-tab-settings"
            ref={(node) => { tabRefs.current[1] = node }}
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            aria-controls="nw-panel-settings"
            tabIndex={tab === 'settings' ? 0 : -1}
            className={`nw-tab${tab === 'settings' ? ' is-active' : ''}`}
            onClick={() => setTab('settings')}
            onKeyDown={(event) => onTabKeyDown(event, 1)}
          >
            Settings
          </button>
        </div>
      </div>
      <div className="nw-divider" />
      <div className="nw-scroll">
        {/* Reports stays MOUNTED across tab switches (hidden, not
            unmounted) so an in-flight "Generate report now" poll isn't
            torn down when the user steps over to Settings — the poll
            keeps running, so the completion toast, the fresh-body cache
            write, and the refreshed feed all land when the job finishes.
            Settings stays lazily mounted: it does provider/model/status
            fetches on mount that there's no reason to run until viewed. */}
        <div id="nw-panel-reports" role="tabpanel" aria-labelledby="nw-tab-reports" hidden={tab !== 'reports'}>
          <ReportsTab
            appId={appId}
            token={token}
            online={online}
            onSetup={() => setTab('settings')}
          />
        </div>
        {tab === 'settings' && (
          <div id="nw-panel-settings" role="tabpanel" aria-labelledby="nw-tab-settings">
            <SettingsTab
              appId={appId}
              token={token}
              online={online}
              onSetupComplete={() => markSetupComplete(appId)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
