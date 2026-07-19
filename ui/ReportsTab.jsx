import React, { useState, useEffect, useCallback, useRef } from 'react'
import { formatDate, decideGenerateOutcome, selectRefreshTriggers } from '../domain.js'
import { isErrorReport } from '../report-schema.mjs'
import { readCache, writeCache, loadReportEntries, loadReportBody, loadRunStatus } from '../storage.js'
import { signal, signalError } from '../signals.js'
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

export function ReportsTab({ appId, token, online, onSetup }) {
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

  // Terminate a manual generation honestly: stop the poll, cache the landed
  // body, clear the busy state, and surface the outcome. `status` is 'ok' or
  // 'error'; on 'error' the banner is honest and the existing feed (which may
  // hold a preserved good digest) is left intact.
  const settleGeneration = useCallback((active, finalEntries, status, freshBody) => {
    // Idempotency guard: two relists (the 15s poll and a visibility/online
    // relist) can both observe the same terminal after their awaits. Only the
    // first settles — a stale caller finds the ref already cleared and bails, so
    // generate_completed can't fire twice.
    if (activeGenerationRef.current !== active) return
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
    activeGenerationRef.current = null
    if (freshBody && freshBody.date) {
      setCachedReports((prev) => {
        const next = { ...prev, [freshBody.date]: freshBody }
        writeCache(appId, finalEntries.map((e) => e.date), next)
        return next
      })
    }
    setGenerating(null)
    generatingRef.current = false
    const seconds = Math.max(0, Math.round((Date.now() - active.started) / 1000))
    if (status === 'ok') {
      setErrorMsg('')
      setStatusMsg('Report ready.')
      setTimeout(() => setStatusMsg(''), 3500)
    } else {
      setStatusMsg('')
      setErrorMsg('That run didn’t finish — your last digest is unchanged. Open today for details.')
      setTimeout(() => setErrorMsg(''), 6000)
    }
    // Gated on the real run outcome (should-fix): the completed signal + the
    // "Report ready." toast no longer fire for a landed ERROR report, so
    // Reflection's success counts stay honest.
    signal('generate_completed', { status, seconds })
  }, [appId])

  // Decide whether the in-flight manual generation has finished and, if so,
  // settle it. PRIMARY signal is the run-status side file
  // (reports/<date>.run.json) fetch.sh writes on every terminal — it fires even
  // when the overwrite guard leaves today's report untouched (a failed rerun
  // that preserves a good digest), the exact case the mtime heuristic below
  // cannot see (the blocker this closes). When run.json is ABSENT (pre-upgrade
  // fetch.sh, or a timezone-mismatched report date) we fall back to the legacy
  // new-file/mtime detection and gate its success on the landed report's kind.
  const evaluateGeneration = useCallback(async (active, finalEntries) => {
    const runStatus = await loadRunStatus(appId, token, todayStorageDate())
    const outcome = decideGenerateOutcome(runStatus, { finishedAt: active.beforeRunFinishedAt })
    if (outcome.kind === 'running') return
    if (outcome.kind === 'done') {
      // run.json is keyed to today; today's stored report is the source of
      // truth for the body (the good digest on a preserved failure, the error
      // report on a first-run failure, the fresh digest on success).
      const todayEntry = finalEntries.find((e) => e.date === todayStorageDate())
      const freshBody = todayEntry ? await loadReportBody(appId, token, todayEntry) : null
      settleGeneration(active, finalEntries, outcome.status, freshBody)
      return
    }
    // outcome.kind === 'no-run-json' — legacy mtime / new-file heuristic.
    const done = finalEntries.find((e) =>
      !active.knownFiles.has(`${e.date}.${e.ext || 'html'}`)
      || (e.mtime && e.mtime !== active.beforeMtime[e.date]))
    if (!done) return
    const freshBody = await loadReportBody(appId, token, done)
    const status = isErrorReport(freshBody) ? 'error' : 'ok'
    settleGeneration(active, finalEntries, status, freshBody)
  }, [appId, token, settleGeneration])

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
        // Deduped at the emitter (should-fix): the active-generation poll (15s)
        // and the while-visible poll (60s) both call refreshReports, so an
        // outage would otherwise emit this every tick. signalError collapses
        // identical rows to one per 60s window.
        signalError('report listing failed', 'reports_list')
      } else {
        setListError(null)
      }
      setLoading(false)
      if (signalReady) signal('app_ready', { item_count: finalEntries.length })
      return finalEntries
    }

    finalEntries = listed.entries
    setListError(null)
    setEntries(finalEntries)
    setLoading(false)
    if (signalReady) signal('app_ready', { item_count: finalEntries.length })

    const active = activeGenerationRef.current
    if (active) await evaluateGeneration(active, finalEntries)
    return finalEntries
  }, [appId, token, evaluateGeneration])

  useEffect(() => {
    refreshReports({ signalReady: true })
  }, [refreshReports])

  useEffect(() => {
    if (online) refreshReports()
  }, [online, refreshReports])

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    // Live-refresh for OUT-OF-BAND (cron) writes. We deliberately do NOT wire
    // window.mobius.storage.subscribe/subscribeText: runtime subscribe only
    // re-notifies on THIS tab's own writes/reads, so a cron PUT from fetch.sh
    // never fires it — subscribing would imply a live-update path that does not
    // exist. Do not "upgrade" this back to subscribe (see selectRefreshTriggers).
    // Instead we relist on the events that actually signal the world may have
    // changed under us: foreground, reconnect, and a quiet while-visible poll.
    const triggers = new Set(selectRefreshTriggers(window.mobius))
    const cleanups = []

    if (triggers.has('visibility')) {
      const onVisible = () => {
        if (document.visibilityState === 'visible') refreshReports()
      }
      document.addEventListener('visibilitychange', onVisible)
      cleanups.push(() => document.removeEventListener('visibilitychange', onVisible))
    }

    if (triggers.has('online') && typeof window.mobius?.onOnlineChange === 'function') {
      const unsub = window.mobius.onOnlineChange((isOnline) => {
        if (isOnline) refreshReports()
      })
      cleanups.push(() => { try { unsub?.() } catch {} })
    }

    if (triggers.has('poll')) {
      // Modest 60s relist while the tab is foregrounded so a scheduled digest
      // that lands while the app is open appears without a manual reopen. Skips
      // ticks while hidden or offline so a backgrounded tab isn't kept awake and
      // an offline tab doesn't spin failing requests.
      const id = setInterval(() => {
        if (document.visibilityState === 'visible' && onlineRef.current) refreshReports()
      }, 60_000)
      cleanups.push(() => clearInterval(id))
    }

    return () => { for (const c of cleanups) c() }
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
    if (typeof window !== 'undefined' && window.mobius?.nav?.open) {
      let handle = null
      handle = window.mobius.nav.open('news-report', {
        onBack: () => {
          navRef.current = null
          setDetail(null)
        },
        onForward: () => {
          navRef.current = handle
          setDetail(entry)
        },
      })
      navRef.current = handle
      const ready = handle.ready ? await handle.ready.catch(() => false) : true
      if (navRef.current !== handle) return
      if (ready === false) {
        navRef.current = null
        try { handle.close?.() } catch {}
        return
      }
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
    signal('digest_read', { article_count: articleCount })
    signal('item_opened', {
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
    // Baseline for run-status completion detection: run.json.finished_at as it
    // stands BEFORE we trigger this run. Captured before the POST on purpose —
    // fetch.sh can write its terminal within a second (e.g. CLI-not-installed),
    // so reading after the POST could snapshot THIS run's own terminal and make
    // the poll wait forever for a change that already happened. A later,
    // DIFFERENT finished_at is how the poll knows this run finished, even when
    // the overwrite guard leaves today's report (and its mtime) untouched
    // because a good digest was preserved (see decideGenerateOutcome).
    let beforeRunFinishedAt = null
    try {
      const prior = await loadRunStatus(appId, token, todayStorageDate())
      beforeRunFinishedAt = prior?.finished_at ?? null
    } catch { beforeRunFinishedAt = null }
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
        signalError(`run-job failed: HTTP ${r.status}`, 'generate')
        return
      }
      started = Date.now()
    } catch (e) {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      generatingRef.current = false
      signalError(e?.message || 'Could not reach the server', 'generate')
      return
    }
    signal('generate_started')
    setGenerating({ since: started })
    activeGenerationRef.current = { started, knownFiles, beforeMtime, beforeRunFinishedAt }
    // Defensive: if a prior poll loop is somehow still around (e.g.
    // a future bug in the cleanup path), clear it before installing
    // a new one so we never double-poll.
    if (pollRef.current) clearInterval(pollRef.current)
    // The run.json poll (evaluateGeneration) plus visibility/online relists
    // handle completion. This quiet fallback stays active for long NEWS_TIMEOUT
    // runs instead of declaring a false timeout after 90 seconds.
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
            <p className="nw-empty__subtitle">
              Choose a brief, schedule, and model before relying on scheduled reports.
            </p>
            <button type="button" className="nw-btn-secondary" onClick={onSetup}>
              Open Settings
            </button>
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
