import React, { useState, useEffect, useCallback, useRef } from 'react'
import { formatDate } from '../domain.js'
import { readCache, writeCache, loadReportEntries, loadReportBody } from '../storage.js'
import { ReportReader } from './ReportReader.jsx'

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
  const pollRef = useRef(null)
  const generatingRef = useRef(false)
  const navRef = useRef(null)

  const cacheBody = useCallback((date, body) => {
    setCachedReports((prev) => {
      const next = { ...prev, [date]: body }
      writeCache(appId, entries.map((e) => e.date), next)
      return next
    })
  }, [appId, entries])

  useEffect(() => {
    (async () => {
      const listed = await loadReportEntries(appId, token)
      let finalEntries
      if (listed === null) {
        const cache = readCache(appId)
        finalEntries = (cache?.dates || []).map((d) => ({
          date: d,
          ext: cache?.reports?.[d]?.html ? 'html' : 'json',
          mtime: '',
        }))
        setEntries(finalEntries)
      } else {
        finalEntries = listed
        setEntries(listed)
      }
      setLoading(false)
      // Emit app_ready once data resolves. item_count = report count.
      window.mobius?.signal?.('app_ready', { item_count: finalEntries.length })
    })()
  }, [appId, token])

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
    // Defensive: if a prior poll loop is somehow still around (e.g.
    // a future bug in the cleanup path), clear it before installing
    // a new one so we never double-poll.
    if (pollRef.current) clearInterval(pollRef.current)
    // Poll every 5s; give up after 90s.
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started
      const listed = await loadReportEntries(appId, token)
      // Done when a brand-new date appears OR an existing date's
      // modified_at changed (today's report was regenerated in place).
      const done = listed && listed.find((e) =>
        !knownFiles.has(`${e.date}.${e.ext || 'html'}`)
        || (e.mtime && e.mtime !== beforeMtime[e.date]))
      if (done) {
        clearInterval(pollRef.current)
        pollRef.current = null
        const freshBody = await loadReportBody(appId, token, done)
        setCachedReports((prev) => {
          const next = { ...prev }
          if (freshBody) next[done.date] = freshBody
          else delete next[done.date]
          writeCache(appId, listed.map((e) => e.date), next)
          return next
        })
        setEntries(listed)
        setGenerating(null)
        generatingRef.current = false
        setStatusMsg('Report ready.')
        setTimeout(() => setStatusMsg(''), 3500)
        return
      }
      if (elapsed > 90_000) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setGenerating(null)
        generatingRef.current = false
        setStatusMsg('')
        setErrorMsg('Report taking longer than expected. Check back soon.')
      }
    }, 5000)
  }, [appId, token, entries])

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
        <div className="nw-empty">
          Your first digest will land here after the next scheduled run.
          Press “Generate report now” to start one immediately.
        </div>
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
                {cachedReports[entry.date]?.summary || 'Loading summary…'}
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
