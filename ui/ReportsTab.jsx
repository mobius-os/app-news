import React, { useState, useEffect, useCallback, useRef } from 'react'
import { formatDate } from '../domain.js'
import { readCache, writeCache, loadReportEntries, loadReportBody } from '../storage.js'
import { ReportReader } from './ReportReader.jsx'

function todayStorageDate() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function ageDays(dateStr) {
  const then = Date.parse(`${dateStr}T12:00:00`)
  if (!Number.isFinite(then)) return 0
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000))
}

export function ReportsTab({ appId, token, online }) {
  const [entries, setEntries] = useState([])
  const [cachedReports, setCachedReports] = useState(() => {
    const c = readCache(appId)
    return c ? c.reports : {}
  })
  // Live mirror of cachedReports for the prefetch loop's already-cached
  // guard. Keeping cachedReports itself out of the prefetch effect's deps
  // stops the same feedback loop the reader had: caching a body changes
  // cachedReports, which would re-run the effect, cancel the in-flight
  // load, and restart — N runs for N reports. Read the ref instead so the
  // prefetch fires once per entries change.
  const cachedReportsRef = useRef(cachedReports)
  cachedReportsRef.current = cachedReports
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [generating, setGenerating] = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [listError, setListError] = useState(null)
  const pollRef = useRef(null)
  const generatingRef = useRef(false)
  const activeGenerationRef = useRef(null)
  const onlineRef = useRef(online)
  onlineRef.current = online
  const navRef = useRef(null)

  const cacheBody = useCallback((date, body) => {
    setCachedReports((prev) => {
      const next = { ...prev, [date]: body }
      writeCache(appId, entries.map((e) => e.date), next)
      return next
    })
  }, [appId, entries])

  const refreshReports = useCallback(async ({ signalReady = false } = {}) => {
    const listed = await loadReportEntries(appId, token)
    let finalEntries = []
    if (!listed.ok) {
      const cache = readCache(appId)
      finalEntries = (cache?.dates || []).map((d) => ({
        date: d,
        ext: cache?.reports?.[d]?.html ? 'html' : 'json',
        mtime: '',
      }))
      setEntries(finalEntries)
      if (finalEntries.length === 0 && onlineRef.current) {
        setListError(listed.status || 0)
        window.mobius?.signal?.('error', { message: 'report listing failed', source: 'reports_list' })
      } else {
        setListError(null)
      }
      setLoading(false)
      if (signalReady) window.mobius?.signal?.('app_ready', { item_count: finalEntries.length })
      return finalEntries
    }

    finalEntries = listed.entries
    setListError(null)
    setEntries(finalEntries)
    setLoading(false)
    if (signalReady) window.mobius?.signal?.('app_ready', { item_count: finalEntries.length })

    const active = activeGenerationRef.current
    if (active) {
      const done = finalEntries.find((e) =>
        !active.knownFiles.has(`${e.date}.${e.ext || 'html'}`)
        || (e.mtime && e.mtime !== active.beforeMtime[e.date]))
      if (done) {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
        activeGenerationRef.current = null
        const freshBody = await loadReportBody(appId, token, done)
        setCachedReports((prev) => {
          const next = { ...prev }
          if (freshBody) next[done.date] = freshBody
          else delete next[done.date]
          writeCache(appId, finalEntries.map((e) => e.date), next)
          return next
        })
        setGenerating(null)
        generatingRef.current = false
        setStatusMsg('Report ready.')
        setTimeout(() => setStatusMsg(''), 3500)
        window.mobius?.signal?.('generate_completed', {
          status: 'ok',
          seconds: Math.max(0, Math.round((Date.now() - active.started) / 1000)),
        })
      }
    }
    return finalEntries
  }, [appId, token])

  useEffect(() => {
    refreshReports({ signalReady: true })
  }, [refreshReports])

  useEffect(() => {
    if (online) refreshReports()
  }, [online, refreshReports])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const storage = window.mobius?.storage
    let unsubReport = null
    if (storage && typeof storage.subscribeText === 'function') {
      try {
        unsubReport = storage.subscribeText(`reports/${todayStorageDate()}.html`, () => {
          refreshReports()
        })
      } catch {}
    } else if (storage && typeof storage.subscribe === 'function') {
      try {
        unsubReport = storage.subscribe(`reports/${todayStorageDate()}.html`, () => {
          refreshReports()
        })
      } catch {}
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshReports()
    }
    document.addEventListener('visibilitychange', onVisible)
    let unsubOnline = null
    if (typeof window.mobius?.onOnlineChange === 'function') {
      unsubOnline = window.mobius.onOnlineChange((isOnline) => {
        if (isOnline) refreshReports()
      })
    }
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      try { unsubReport?.() } catch {}
      try { unsubOnline?.() } catch {}
    }
  }, [refreshReports])

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
    try { navRef.current?.close?.() } catch {}
  }, [])

  useEffect(() => {
    if (!entries.length) return undefined
    let cancelled = false
    ;(async () => {
      for (const entry of entries.slice(0, 6)) {
        if (cancelled || cachedReportsRef.current[entry.date]) continue
        const body = await loadReportBody(appId, token, entry)
        if (cancelled) return
        if (body) cacheBody(entry.date, body)
      }
    })()
    return () => { cancelled = true }
  }, [entries, appId, token])

  const openDetail = useCallback(async (entry) => {
    if (window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('news-report', () => {
        navRef.current = null
        setDetail(null)
      })
      navRef.current = handle
      await handle.ready?.catch(() => false)
      if (navRef.current !== handle) return
    }
    // Count how many articles are in the cached report (if available) so
    // Dreaming knows roughly how much content the user consumed. HTML reports
    // (the current format) normalize to sections:[] + a populated headlines[],
    // so test sections.LENGTH, not its truthiness — an empty-but-present array
    // is truthy and would otherwise pin every HTML report's count to 0.
    const cached = cachedReportsRef.current[entry.date]
    const articleCount = cached?.sections?.length
      ? cached.sections.reduce((n, s) => n + (s.articles?.length || 0), 0)
      : (cached?.headlines?.length ?? 0)
    window.mobius?.signal?.('digest_read', { article_count: articleCount })
    window.mobius?.signal?.('item_opened', {
      type: 'digest',
      item_age_days: ageDays(entry.date),
      article_count: articleCount,
    })
    setDetail(entry)
  }, [])

  const closeDetail = useCallback(() => {
    try { navRef.current?.close?.() } catch {}
    navRef.current = null
    setDetail(null)
  }, [])

  const handleGenerate = useCallback(async () => {
    if (generatingRef.current) return
    generatingRef.current = true
    setErrorMsg('')
    setStatusMsg('Generating report…')
    const knownFiles = new Set(entries.map((e) => `${e.date}.${e.ext || 'html'}`))
    const beforeMtime = {}
    // fetch.sh overwrites reports/<today>.html, so a same-day
    // regeneration shows up as today's modified_at advancing, not as a
    // new date. Snapshot the baseline before starting so a fast job
    // landing mid-call can't poison the poll's change-detection.
    for (const e of entries) beforeMtime[e.date] = e.mtime
    let started
    try {
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        setStatusMsg('')
        setErrorMsg(`Could not start job (HTTP ${r.status}).`)
        generatingRef.current = false
        window.mobius?.signal?.('error', {
          message: `run-job failed: HTTP ${r.status}`,
          source: 'generate',
        })
        return
      }
      started = Date.now()
    } catch (e) {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      generatingRef.current = false
      window.mobius?.signal?.('error', {
        message: e?.message || 'Could not reach the server',
        source: 'generate',
      })
      return
    }
    window.mobius?.signal?.('generate_started')
    setGenerating({ since: started })
    activeGenerationRef.current = { started, knownFiles, beforeMtime }
    // Defensive: if a prior poll loop is somehow still around (e.g.
    // a future bug in the cleanup path), clear it before installing
    // a new one so we never double-poll.
    if (pollRef.current) clearInterval(pollRef.current)
    // Runtime storage subscriptions and visibility/online relists handle the
    // fast path. This quiet fallback stays active for long NEWS_TIMEOUT runs
    // instead of declaring a false timeout after 90 seconds.
    pollRef.current = setInterval(async () => {
      refreshReports()
    }, 15_000)
  }, [appId, token, entries, refreshReports])

  if (loading) return <div className="nw-loading">Loading reports…</div>

  const generateDisabled = !!generating || !online

  return (
    <div>
      {!online && (
        <div className="nw-offline-banner">
          Offline — showing last cached reports. New digests resume once
          you’re back online.
        </div>
      )}
      <div className="nw-top-row">
        <button
          className="nw-generate-btn"
          onClick={handleGenerate}
          disabled={generateDisabled}
          title={!online ? 'Online required to trigger a fetch' : undefined}
        >
          {generating ? 'Generating…' : 'Generate report now'}
        </button>
        {statusMsg && <span className="nw-status-hint">{statusMsg}</span>}
        {errorMsg && <span className="nw-error-toast">{errorMsg}</span>}
      </div>

      {entries.length === 0 ? (
        listError ? (
          <div className="nw-empty">
            <div className="nw-empty__mark" aria-hidden="true">!</div>
            <h2 className="nw-empty__title">Reports could not load</h2>
            <p className="nw-empty__subtitle">Check your connection and try again.</p>
            <button type="button" className="nw-btn-secondary" onClick={() => refreshReports()}>
              Retry
            </button>
          </div>
        ) : (
          <div className="nw-empty">
            <div className="nw-empty__mark" aria-hidden="true">N</div>
            <h2 className="nw-empty__title">No digests yet</h2>
            <p className="nw-empty__subtitle">Your first digest will land here after the next scheduled run.</p>
          </div>
        )
      ) : (
        <div className="nw-feed-list">
          {entries.map((entry) => (
            <button
              key={`${entry.date}:${entry.mtime || ''}`}
              type="button"
              className="nw-feed-item"
              onClick={() => openDetail(entry)}
            >
              <div className="nw-feed-date">{formatDate(entry.date)}</div>
              <div className="nw-feed-summary">
                {cachedReports[entry.date]?.summary || 'Tap to read'}
              </div>
            </button>
          ))}
        </div>
      )}
      {detail && (
        <ReportReader
          entry={detail}
          appId={appId}
          token={token}
          cachedReport={cachedReports[detail.date]}
          onBodyLoaded={cacheBody}
          onBack={closeDetail}
        />
      )}
    </div>
  )
}
