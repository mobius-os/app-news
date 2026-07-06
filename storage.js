// ---------------------------------------------------------------------------
// Storage + offline layer, plus the two runtime hooks the UI depends on.
//
// WRITES go through window.mobius.durableWrite — the honest save: it RESOLVES
// only when the value is durable ({durability:'synced'} landed, or
// {durability:'queued'} durably outboxed and WILL retry on reconnect — queued
// is SUCCESS), and REJECTS DurableWriteError{code:'dead_letter'} only when the
// server fatally REFUSES the write (413/400/403). putJSON/putText are thin
// shims over it that translate resolve/reject into the file's write shape so
// the classifyWriteOutcome classifier keeps working — a dead-letter flows to
// "Couldn't save", never a false "Saved".
//
// READS stay on window.mobius.storage.get (offline-capable, SWR). Probing
// window.mobius on every call (rather than caching at module load) matches
// atlas/gym/dreaming/latex — the runtime can be injected after the app boots.
//
// Return shapes are intentionally consistent across the file:
//   reads  -> {ok: true, data} | {ok: false, status}
//   writes -> {synced: true} | {queued: true} | {ok: false, status, deadLetter?}
//
// Storage URLs (/api/storage/apps/{appId}/...) can use the runtime; anything
// else (e.g. /api/auth/providers/...) goes straight to fetch — the runtime
// only mediates per-app storage paths. Plain-text reads use
// window.mobius.storage.getText when available; putText keeps using
// durableWrite so queued writes and dead-letter honesty stay consistent.
//
// The offline localStorage caches (reports + editorial brief) and the online
// hook + chat-split persistence keys live here too: all client-side durability
// concerns in one module.
// ---------------------------------------------------------------------------
import { useState, useEffect } from 'react'
import {
  isReportFilename,
  reportDateFromFilename,
  reportExtFromFilename,
  normalizeReport,
  normalizeHtmlReport,
} from './report-schema.mjs'
import {
  RECENT_REPORT_LIMIT,
  CACHE_VERSION,
  CHAT_OPEN_VERSION,
  CHAT_RATIO_VERSION,
} from './constants.js'

export function getRuntimeStorage() {
  return (typeof window !== 'undefined' && window.mobius?.storage) || null
}

// The honest-save entry point. Returns window.mobius.durableWrite (a
// function) when the runtime is loaded, else null so the caller takes the
// direct-fetch path. durableWrite resolves on durable success (synced or
// queued) and rejects DurableWriteError on a fatal server refusal — unlike
// the old storage.set, which queued silently and could mask a refusal.
export function getRuntimeWrite() {
  const w = (typeof window !== 'undefined' && window.mobius?.durableWrite) || null
  return typeof w === 'function' ? w : null
}

export function storagePathFromUrl(url, appId) {
  if (appId == null) return null
  const prefix = `/api/storage/apps/${appId}/`
  return url.startsWith(prefix) ? url.slice(prefix.length) : null
}

export async function getJSON(url, token, appId) {
  const path = storagePathFromUrl(url, appId)
  const native = path ? getRuntimeStorage() : null
  if (native && typeof native.get === 'function') {
    try {
      const data = await native.get(path)
      // Runtime returns null for true 404, offline, AND any read it
      // couldn't parse as JSON. All three collapse to {ok: false} —
      // callers already treat that as "no data, use defaults", which
      // is the right response for every reason the runtime might
      // bail. No fallback fetch: the runtime hit the same endpoint
      // we would, and a retry won't change the answer.
      if (data === null || data === undefined) return { ok: false, status: 404 }
      return { ok: true, data }
    } catch {
      // Runtime threw (unexpected) — fall through to direct fetch so
      // a transient runtime bug can't blank a settings tab.
    }
  }
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { ok: false, status: r.status }
    try { return { ok: true, data: await r.json() } }
    catch { return { ok: false, status: 500 } }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function getText(url, token, appId) {
  const path = storagePathFromUrl(url, appId)
  const native = path ? getRuntimeStorage() : null
  if (native && typeof native.getText === 'function') {
    try {
      const data = await native.getText(path)
      if (data === null || data === undefined) return { ok: false, status: 404 }
      return { ok: true, data }
    } catch {
      // Fall through to direct fetch so a transient runtime issue does not
      // blank the reader/settings view when the network path is still usable.
    }
  }
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, data: await r.text() }
  } catch {
    return { ok: false, status: 0 }
  }
}

// Translate a durableWrite outcome into the file's {synced}|{queued}|
// {ok:false} write shape. A resolved write is durable: 'queued' (offline
// outbox) and 'synced' (landed) are BOTH success. A DurableWriteError
// rejection is a refused write — surface it as failure (carrying the HTTP
// status + a deadLetter flag) so toastFor reports "Couldn't save", never a
// false success. A non-DurableWriteError throw (e.g. runtime absent or a
// transient bug) is re-thrown so putJSON/putText fall through to direct fetch.
// Exported (named) only so the resolve/reject→shape mapping is unit-testable
// with a mocked durableWrite; the app uses the default export.
export async function durableWriteOutcome(durableWrite, path, value) {
  try {
    const r = await durableWrite(path, value)
    return r.durability === 'queued' ? { queued: true } : { synced: true }
  } catch (e) {
    if (e && e.name === 'DurableWriteError') {
      return { ok: false, status: e.status ?? 0, deadLetter: true }
    }
    throw e
  }
}

// Pure classifier for a write-helper result: {durable, msg}. 'queued' and
// 'synced' are durable success; a deadLetter result is a server refusal; any
// other shape is a generic lost write. Kept module-level + exported so the
// honesty contract (a refused write is NEVER durable) is unit-testable; the
// SettingsTab toastFor closure delegates here for the partner-facing copy.
export function classifyWriteOutcome(result, savedLabel = 'Saved ✓') {
  if (result && result.queued) return { durable: true, msg: 'Saved offline — will sync' }
  if (result && result.synced) return { durable: true, msg: savedLabel }
  if (result && result.deadLetter) return { durable: false, msg: 'Server rejected this change — not saved' }
  return { durable: false, msg: 'Couldn’t save — try again' }
}

export async function putJSON(url, token, obj, appId) {
  const path = storagePathFromUrl(url, appId)
  const durableWrite = path ? getRuntimeWrite() : null
  if (durableWrite) {
    try { return await durableWriteOutcome(durableWrite, path, obj) }
    catch { /* runtime threw unexpectedly — fall through to direct PUT */ }
  }
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    })
    if (r.ok) return { synced: true }
    return { ok: false, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function putText(url, token, text, appId) {
  const path = storagePathFromUrl(url, appId)
  const durableWrite = path ? getRuntimeWrite() : null
  if (durableWrite) {
    // durableWrite stores a string value as text/plain (no {content}
    // envelope) — the same bytes the legacy text/plain PUT below writes,
    // so the file on disk is identical. The queue + dead-letter honesty
    // come for free.
    try { return await durableWriteOutcome(durableWrite, path, text) }
    catch { /* runtime threw unexpectedly — fall through to direct PUT */ }
  }
  try {
    const r = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: text,
    })
    if (r.ok) return { synced: true }
    return { ok: false, status: r.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

// List available reports from the storage listing endpoint — one
// paginated call instead of brute-force date-probing. Returns the
// .html/.json reports newest-first as {date, ext, mtime}. HTML is the
// preferred format; JSON is kept for older digests already on disk. mtime is the
// listing's modified_at — used to detect a SAME-DAY regeneration:
// fetch.sh overwrites reports/<today>.html, so no new filename appears;
// completion shows up as today's modified_at advancing. The body for a
// picked date is fetched lazily by loadReportBody. Returns {ok:false} on
// network failure so the caller can fall back to its cached snapshot or show
// an explicit online error; {ok:true, entries:[]} means "listed fine, no
// reports yet".
export async function loadReportEntries(appId, token) {
  const out = []
  let cursor = null
  try {
    for (let guard = 0; guard < 50; guard++) {
      const prevCursor = cursor
      const url = `/api/storage/apps-list/${appId}/reports?limit=500`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) return { ok: false, status: r.status, entries: [] }
      const data = await r.json()
      for (const e of data.entries || []) {
        if (e.type === 'file' && isReportFilename(e.name)) {
          const date = reportDateFromFilename(e.name)
          const ext = reportExtFromFilename(e.name)
          out.push({
            date,
            ext,
            file: e.name,
            mtime: e.modified_at || '',
          })
        }
      }
      cursor = data.next_cursor
      if (cursor && cursor === prevCursor) return { ok: false, status: 500, entries: [] }
      if (!cursor) break
    }
  } catch {
    return { ok: false, status: 0, entries: [] }
  }
  const byDate = new Map()
  for (const entry of out) {
    const prev = byDate.get(entry.date)
    if (!prev || (entry.ext === 'html' && prev.ext !== 'html')) byDate.set(entry.date, entry)
  }
  // Newest first (ISO date names sort lexicographically = chronologically).
  return {
    ok: true,
    entries: [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
  }
}

// Fetch one day's report and normalize it to the render shape. New reports
// are raw HTML fragments on .html storage paths. Legacy reports are bare JSON
// objects on .json paths.
export async function loadReportBody(appId, token, entryOrDate) {
  const entry = typeof entryOrDate === 'string'
    ? { date: entryOrDate, ext: 'html' }
    : entryOrDate
  const dateStr = entry.date
  if (entry.ext === 'json') {
    const res = await getJSON(
      `/api/storage/apps/${appId}/reports/${dateStr}.json`,
      token, appId,
    )
    return res.ok ? normalizeReport(res.data, dateStr) : null
  }
  const res = await getText(`/api/storage/apps/${appId}/reports/${dateStr}.html`, token, appId)
  return res.ok ? normalizeHtmlReport(res.data, dateStr) : null
}

// Persist the partner's in-report answers for the NEXT run. No live agent is
// waiting — fetch.sh reads the newest question-answers/*.json next run and
// folds them into the system prompt next to the feedback. The .json storage
// path stores the BARE object (no {content} envelope), and putJSON routes
// through the offline runtime so an answer tapped offline queues + drains on
// reconnect. Keyed by the REPORT date so a re-open overwrites rather than
// piling duplicates.
export async function saveQuestionAnswers(appId, token, reportDate, answers, questions) {
  const body = {
    report_date: reportDate,
    answered_at: new Date().toISOString(),
    answers,
    questions,
  }
  return putJSON(
    `/api/storage/apps/${appId}/question-answers/${reportDate}.json`,
    token, body, appId,
  )
}

// ----------------------------------------------------------------------
// Offline cache for the reports listing + recently-viewed bodies.
//
// The runtime's `window.mobius.storage.get` deliberately doesn't ship a
// read-cache (it returns null offline). News is read-only from the
// client's perspective, so an offline reload needs SOMETHING locally —
// otherwise the user opens the app on a flaky train and gets a blank
// state even though they read yesterday's digest five minutes ago.
//
// We persist a tiny snapshot in localStorage keyed by app id: the list
// of recent dates and the normalized report objects for up to
// RECENT_REPORT_LIMIT of them. This is NOT a parallel write store —
// only the cron-produced reports flow through it. The server stays the
// source of truth; this cache exists purely so the first paint after an
// offline reload shows the same content the user saw before they lost
// connectivity.
// ----------------------------------------------------------------------
export function cacheKey(appId) {
  return `news:${appId}:reports-cache:v${CACHE_VERSION}`
}

export function readCache(appId) {
  try {
    const raw = localStorage.getItem(cacheKey(appId))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const dates = Array.isArray(parsed.dates) ? parsed.dates.filter(d => typeof d === 'string') : []
    const reports = (parsed.reports && typeof parsed.reports === 'object') ? parsed.reports : {}
    return { dates, reports }
  } catch {
    return null
  }
}

export function writeCache(appId, dates, reports) {
  try {
    // Bound the cache to the most recent N dates and their bodies so
    // localStorage can't grow without limit across every generation.
    const recent = dates.slice(0, RECENT_REPORT_LIMIT)
    const trimmed = {}
    for (const d of recent) {
      if (reports[d]) trimmed[d] = reports[d]
    }
    localStorage.setItem(
      cacheKey(appId),
      JSON.stringify({ dates: recent, reports: trimmed }),
    )
  } catch {
    // Quota errors / disabled storage: just skip — the in-memory
    // state still works for this session.
  }
}

// Editorial-brief offline cache. Runtime getText mirrors plain text for
// current shells, but older shells and direct-fetch fallbacks can still fail
// offline. Keep this guard so an offline Settings open never paints
// DEFAULT_TOPICS over the user's real brief and then queues that default back
// to the server.
export function topicsCacheKey(appId) {
  return `news:${appId}:topics-cache:v1`
}

export function readTopicsCache(appId) {
  try {
    const v = localStorage.getItem(topicsCacheKey(appId))
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

export function writeTopicsCache(appId, text) {
  try {
    if (typeof text === 'string') localStorage.setItem(topicsCacheKey(appId), text)
  } catch {
    // Quota / disabled storage — skip; in-memory state still works.
  }
}

// ----------------------------------------------------------------------
// Online/offline detection. window.mobius.online is the runtime's own
// reachability state; window.mobius.onOnlineChange reports shell health
// changes such as /api/health failures. Browser online/offline events remain
// the fallback outside the shell runtime.
// ----------------------------------------------------------------------
export function useOnline() {
  const initial = (() => {
    if (typeof window === 'undefined') return true
    if (typeof window.mobius?.online === 'boolean') return window.mobius.online
    return navigator.onLine !== false
  })()
  const [online, setOnline] = useState(initial)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onUp = () => setOnline(true)
    const onDown = () => setOnline(false)
    window.addEventListener('online', onUp)
    window.addEventListener('offline', onDown)
    let mobiusUnsub = null
    if (window.mobius && typeof window.mobius.onOnlineChange === 'function') {
      mobiusUnsub = window.mobius.onOnlineChange((isOnline) => {
        setOnline(!!isOnline)
      })
    }
    return () => {
      window.removeEventListener('online', onUp)
      window.removeEventListener('offline', onDown)
      if (mobiusUnsub) mobiusUnsub()
    }
  }, [])
  return online
}

// Chat-split open/ratio persistence keys (versioned) + their readers.
export function chatOpenKey(appId) { return `nw:${appId}:chat-open:v${CHAT_OPEN_VERSION}` }
export function chatRatioKey(appId) { return `nw:${appId}:chat-ratio:v${CHAT_RATIO_VERSION}` }

export function readChatOpen(appId) {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(chatOpenKey(appId)) === 'true'
}

export function readChatRatio(appId) {
  if (typeof localStorage === 'undefined') return 0.5
  const raw = Number(localStorage.getItem(chatRatioKey(appId)))
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1) return 0.5
  return Math.max(0.05, Math.min(0.95, raw))
}
