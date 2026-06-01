import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import DOMPurify from 'https://esm.sh/dompurify@3'

// Sanitization profile for agent-produced report HTML. The agent web-
// searches and inlines source citations — a poisoned page could
// otherwise inject <script>/onerror=/javascript: URIs into the HTML
// the agent quotes, which renders verbatim under the owner's JWT.
// DOMPurify with the strict profile below blocks every common XSS
// shape (script/style/iframe/object/embed/form/event handlers,
// non-http(s) hrefs). Anchors keep target="_blank" + rel handled
// elsewhere; we ALLOW `details`/`summary` because the report shell
// uses them, and the standard semantic tags the agent emits.
const SANITIZE_CONFIG = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['details', 'summary'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onsubmit', 'formaction', 'srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?):/i,
}

function sanitizeReportHtml(raw) {
  if (!raw) return ''
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG)
}

// Provider display order + UI labels. The model list inside each
// group is fetched at runtime from `GET /api/auth/providers/models`
// (the backend asks Anthropic's /v1/models + the Codex SDK and
// falls back to KNOWN_MODELS on transient failure). One source of
// truth lives in mobius's `app.providers` — mini-apps no longer
// carry their own copy. The only thing hard-coded here is the
// group order + the human label per provider; the `id`s and
// per-model display names come from the backend.
const PROVIDER_ORDER = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'OpenAI Codex' },
]

// Tiny fallback the picker falls back to when the fetch fails —
// older mobius without the endpoint, offline, etc. Just one model
// per provider so the user can still pick *something* and save;
// fetch.sh passes --model through verbatim, so the CLI is the
// ultimate authority on what actually resolves at job time.
const FALLBACK_GROUPS = [
  {
    key: 'claude',
    label: 'Claude Code',
    models: [{ id: 'claude-opus-4-7', name: 'Opus 4.7' }],
  },
  {
    key: 'codex',
    label: 'OpenAI Codex',
    models: [{ id: 'gpt-5.5', name: 'gpt-5.5' }],
  },
]

const DEFAULT_PROVIDER = FALLBACK_GROUPS[0].key
const DEFAULT_MODEL = FALLBACK_GROUPS[0].models[0].id

// When the daily digest actually fires. This is the cron schedule the
// installer registers from the manifest's `schedule.default`
// ("0 10 * * *") — 10:00 UTC, every day. It is FIXED at install time:
// the crontab is restored from init-cron.sh on every container boot and
// no platform reconciler re-reads a saved time to change it. So every
// "when does it run" surface (the empty state, the Settings schedule
// block) reads this constant — the source of truth for the fire time.
// To move the fire time, the owner asks the agent to edit the cron
// (see the Settings note). Keep this in sync with mobius.json
// `schedule.default` if that ever changes.
const INSTALLED_RUN_UTC = { hour: 10, minute: 0 }

// Default editorial brief. Kept in sync with the bundled `topics.txt`
// so "Reset to default" writes the same text the installer seeded.
// Multi-paragraph by design: this is an editorial brief, not a search
// query — the user is expected to rewrite it in their own voice.
const DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The
text below is what the curator reads each morning to decide what to
write and how. Be opinionated; the more specific you are, the better
the report.

Coverage: I want a broad picture of the day across world news,
business and markets, technology, science, sports, and culture. Lean
into the stories that actually moved the needle in the last 24 hours
rather than evergreen think-pieces.

Sources & framing: stick to reputable primary publishers (Reuters,
AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT
Arts, and similar). Keep framing neutral and surface multiple
viewpoints when a story is divisive — no editorialising, no
speculation.

Voice: write it as one flowing morning briefing, like a journalist
would — conversational but substantive. Weave the citations into the
prose. If a story is unfamiliar or has been building over several
days, drop in a short "what this is about" sentence so I'm not lost.

What to downweight: celebrity gossip, lifestyle filler, and
press-release-shaped tech announcements with no real news behind
them. Skip them unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font)',
    // The whole app pins to the viewport — no body-level horizontal scroll.
    maxWidth: '100%', overflowX: 'hidden',
  },
  header: {
    padding: '18px 20px 0', display: 'flex', alignItems: 'center',
    justifyContent: 'space-between', flexShrink: 0, gap: '12px',
  },
  title: {
    fontSize: '22px', fontWeight: 700, letterSpacing: '-0.3px',
    margin: 0,
  },
  tabs: {
    display: 'flex', gap: '2px', background: 'var(--surface)',
    borderRadius: '8px', padding: '3px', border: '1px solid var(--border)',
  },
  tab: (active) => ({
    padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer',
    fontSize: '13px', fontWeight: 500,
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--muted)',
    transition: 'all 0.15s',
  }),
  divider: { height: '1px', background: 'var(--border)', margin: '14px 20px 0' },
  scroll: {
    flex: 1, overflowY: 'auto', overflowX: 'hidden',
    padding: '14px 20px 32px',
    // Belt-and-braces wrapping for any descendant that didn't opt in.
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },

  // Reports — top control row
  topRow: {
    display: 'flex', alignItems: 'center', gap: '10px',
    marginBottom: '14px', flexWrap: 'wrap',
  },
  datePicker: {
    padding: '7px 10px', fontSize: '13px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    outline: 'none', minWidth: '180px', maxWidth: '100%',
  },
  generateBtn: (busy) => ({
    padding: '7px 14px', borderRadius: '8px',
    border: '1px solid var(--border)',
    background: busy ? 'var(--surface)' : 'var(--accent)',
    color: busy ? 'var(--muted)' : '#fff',
    cursor: busy ? 'default' : 'pointer',
    fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap',
  }),
  statusHint: { fontSize: '12px', color: 'var(--muted)' },
  // Inline offline banner. Sits at the top of the Reports tab when
  // navigator.onLine is false. Subtle accent-tinted strip — loud
  // enough to be noticed, quiet enough not to dominate the report
  // itself. We deliberately keep the rest of the UI rendered (cached
  // reports remain visible) rather than swapping to a full-screen
  // disconnect splash; the brief is explicit that apps should "keep
  // working with what they have".
  offlineBanner: {
    margin: '0 0 12px',
    padding: '8px 12px',
    borderRadius: '8px',
    background: 'var(--accent-dim, rgba(99,102,241,0.12))',
    border: '1px solid var(--border)',
    color: 'var(--text)',
    fontSize: '12.5px',
    lineHeight: 1.45,
  },

  // Long-form HTML report container. We centre a comfortable reading
  // column and let the agent's own <h2>/<p>/<a>/<ul> elements flow.
  // Per-element styling lives in the injected <style> tag below so
  // `dangerouslySetInnerHTML` content picks it up without us walking
  // the tree.
  reportContainer: {
    maxWidth: '640px', margin: '0 auto',
    fontSize: '15px', lineHeight: 1.65, color: 'var(--text)',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  empty: {
    textAlign: 'center', padding: '50px 20px', color: 'var(--muted)',
    fontSize: '13px', lineHeight: 1.6,
  },
  loading: {
    textAlign: 'center', padding: '50px 20px', color: 'var(--muted)',
    fontSize: '13px',
  },

  // Settings
  settingsWrap: { maxWidth: '720px' },
  settingsSection: { marginBottom: '24px' },
  label: { fontSize: '13px', fontWeight: 600, margin: '0 0 4px', display: 'block' },
  note: { fontSize: '12px', color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 },
  topicsTextarea: {
    width: '100%', minHeight: '140px',
    // Plain prose textarea (not monospace) — this is freeform English now.
    fontFamily: 'var(--font)',
    fontSize: '13px', lineHeight: 1.55, padding: '12px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    resize: 'vertical', outline: 'none', boxSizing: 'border-box',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    overflowWrap: 'anywhere', maxWidth: '100%',
  },
  btnRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', flexWrap: 'wrap' },
  btn: {
    padding: '7px 16px', border: 'none', borderRadius: '10px',
    background: 'var(--accent)', color: '#fff',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  linkBtn: {
    background: 'none', border: 'none', padding: 0,
    color: 'var(--accent)', fontSize: '12px', cursor: 'pointer',
    textDecoration: 'underline',
  },
  toast: { fontSize: '12px', color: 'var(--green, #4caf50)' },
  errorToast: { fontSize: '12px', color: 'var(--red, #ef4444)' },
  // Secondary button for "Run now" — surface-coloured fill so it reads
  // as a quieter action than the accent-filled primary buttons.
  btnSecondary: {
    padding: '7px 14px', borderRadius: '10px',
    border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--text)',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  btnSecondaryBusy: {
    padding: '7px 14px', borderRadius: '10px',
    border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--muted)',
    fontSize: '13px', fontWeight: 600, cursor: 'default',
  },
  // Agent / Model section — grouped list with provider section
  // headers, mirroring the shell's ChatSettingsPanel rhythm.
  modelList: {
    display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '6px',
  },
  modelGroup: { display: 'flex', flexDirection: 'column', gap: '6px' },
  modelGroupHeader: {
    display: 'flex', alignItems: 'center', gap: '8px',
    fontSize: '11px', fontWeight: 600,
    textTransform: 'uppercase', letterSpacing: '0.6px',
    color: 'var(--muted)',
    margin: '2px 4px 4px',
  },
  modelGroupHint: {
    fontSize: '10.5px', fontWeight: 500,
    textTransform: 'none', letterSpacing: 0,
    color: 'var(--muted)',
    opacity: 0.85,
  },
  modelRow: (on, disabled) => ({
    display: 'flex', alignItems: 'center', gap: '10px',
    padding: '10px 12px', borderRadius: '10px',
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: on ? 'var(--accent-dim)' : 'var(--surface)',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    opacity: disabled && !on ? 0.55 : 1,
    fontSize: '13px', fontWeight: 500, userSelect: 'none',
  }),
  modelRowMain: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 },
  modelRowTitle: { fontWeight: 600 },
  modelRowSub: { fontSize: '11.5px', color: 'var(--muted)', fontWeight: 400 },
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

// Next firing of the fixed installed schedule (INSTALLED_RUN_UTC),
// as a Date. The cron runs in UTC daily, so we set today's UTC
// hour/minute and roll forward a day if that instant has already
// passed. Returned as a plain Date the caller renders in local time.
function nextInstalledRun() {
  const now = new Date()
  const next = new Date(now)
  next.setUTCHours(INSTALLED_RUN_UTC.hour, INSTALLED_RUN_UTC.minute, 0, 0)
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

// Format the next-run time using the user's local clock via
// Intl.DateTimeFormat. Keeps it terse — HH:MM, 24h or 12h depending
// on locale. Returns the formatted string only; callers compose the
// surrounding sentence.
function formatLocalClock(date) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit', minute: '2-digit',
    }).format(date)
  } catch {
    // Defensive fallback for environments without a working Intl —
    // pad manually rather than throwing through the render path.
    const h = String(date.getHours()).padStart(2, '0')
    const m = String(date.getMinutes()).padStart(2, '0')
    return `${h}:${m}`
  }
}

// ----------------------------------------------------------------------
// Storage helpers — route through the Möbius offline runtime when it's
// loaded, fall back to direct fetch otherwise.
//
// The runtime (window.mobius.storage) queues writes in IndexedDB while
// offline and drains them on reconnect. Without it, a save in the
// Settings tab while offline silently throws and the user thinks the
// change persisted. Probing on every call (rather than caching at
// module load) matches what countries/gym/dreaming/latex do — the
// runtime can be injected after the app boots.
//
// Return shapes are intentionally consistent with the rest of the file:
//   reads  -> {ok: true, data} | {ok: false, status}
//   writes -> {synced: true} | {queued: true} | {ok: false, status}
//
// Two routing notes:
//   • Storage URLs (/api/storage/apps/{appId}/...) can use the runtime.
//     Anything else (e.g. /api/auth/providers/...) goes straight to
//     fetch — the runtime only mediates per-app storage paths.
//   • The runtime ALWAYS serializes via JSON (`res.json()` on read,
//     `application/json` on write). Plain-text paths like topics.txt
//     can't survive a JSON-parse read, so getText skips the runtime;
//     putText still routes through the runtime using the backend's
//     `{content: "<text>"}` envelope so the queue works while offline.
// ----------------------------------------------------------------------

function getRuntimeStorage() {
  return (typeof window !== 'undefined' && window.mobius?.storage) || null
}

function storagePathFromUrl(url, appId) {
  if (appId == null) return null
  const prefix = `/api/storage/apps/${appId}/`
  return url.startsWith(prefix) ? url.slice(prefix.length) : null
}

async function getJSON(url, token, appId) {
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

async function getText(url, token) {
  // The runtime parses every read as JSON, so it can't return plain
  // text — going straight to fetch. Offline this throws, the caller
  // gets {ok: false}, and the existing default-text fallback paints.
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) return { ok: false, status: r.status }
    return { ok: true, data: await r.text() }
  } catch {
    return { ok: false, status: 0 }
  }
}

async function putJSON(url, token, obj, appId) {
  const path = storagePathFromUrl(url, appId)
  const native = path ? getRuntimeStorage() : null
  if (native && typeof native.set === 'function') {
    try { return await native.set(path, obj) }
    catch { /* fall through to direct PUT */ }
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

async function putText(url, token, text, appId) {
  const path = storagePathFromUrl(url, appId)
  const native = path ? getRuntimeStorage() : null
  if (native && typeof native.set === 'function') {
    // The backend's non-JSON storage path expects the `{content}`
    // envelope when the request is JSON-typed; the runtime always
    // sends JSON, so we wrap here. The file on disk ends up as plain
    // text (envelope stripped server-side), matching the legacy
    // text/plain PUT below.
    try { return await native.set(path, { content: text }) }
    catch { /* fall through to direct PUT */ }
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
// .html reports newest-first as {date, mtime}, where mtime is the
// listing's modified_at — used to detect a SAME-DAY regeneration:
// fetch.sh overwrites reports/<today>.html, so no new filename appears;
// completion shows up as today's modified_at advancing. The body for a
// picked date is fetched lazily by loadReportHtml. Returns null on
// network failure so the caller falls back to its cached snapshot; []
// means "listed fine, no reports yet".
async function loadReportEntries(appId, token) {
  const out = []
  let cursor = null
  try {
    for (let guard = 0; guard < 50; guard++) {
      const url = `/api/storage/apps-list/${appId}/reports?limit=500`
        + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) return null
      const data = await r.json()
      for (const e of data.entries || []) {
        if (e.type === 'file' && e.name.endsWith('.html')) {
          out.push({
            date: e.name.slice(0, -'.html'.length),
            mtime: e.modified_at || '',
          })
        }
      }
      cursor = data.next_cursor
      if (!cursor) break
    }
  } catch {
    return null
  }
  // Newest first (ISO date names sort lexicographically = chronologically).
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

async function loadReportHtml(appId, token, dateStr) {
  const res = await getText(
    `/api/storage/apps/${appId}/reports/${dateStr}.html`,
    token,
  )
  return res.ok ? res.data : null
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
// of recent dates and the HTML bodies for up to RECENT_REPORT_LIMIT of
// them. This is NOT a parallel write store — only the cron-produced
// reports flow through it. The server stays the source of truth; this
// cache exists purely so the first paint after an offline reload shows
// the same content the user saw before they lost connectivity.
// ----------------------------------------------------------------------
const RECENT_REPORT_LIMIT = 7
const CACHE_VERSION = 1

function cacheKey(appId) {
  return `news:${appId}:reports-cache:v${CACHE_VERSION}`
}

function readCache(appId) {
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

function writeCache(appId, dates, reports) {
  try {
    // Trim bodies to the most recent N dates so the cache stays small
    // (each report is ~10-30KB of HTML). The dates array can stay
    // longer-tailed because it's tiny; the bodies are the heavy part.
    const trimmed = {}
    for (const d of dates.slice(0, RECENT_REPORT_LIMIT)) {
      if (reports[d]) trimmed[d] = reports[d]
    }
    localStorage.setItem(
      cacheKey(appId),
      JSON.stringify({ dates, reports: trimmed }),
    )
  } catch {
    // Quota errors / disabled storage: just skip — the in-memory
    // state still works for this session.
  }
}

// ----------------------------------------------------------------------
// Online/offline detection. Mirrors the canonical hook used by other
// curated apps (latex, etc.). window.mobius.online is the runtime's
// own signal when present; navigator.onLine is the browser-level
// fallback. Both fire 'online'/'offline' DOM events.
// ----------------------------------------------------------------------
function useOnline() {
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
    if (window.mobius && typeof window.mobius.onChange === 'function') {
      mobiusUnsub = window.mobius.onChange((s) => {
        if (typeof s?.online === 'boolean') setOnline(s.online)
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

// Stylesheet for the agent-emitted HTML. Injected once at app mount
// (rather than inline-styling each <p>) because the agent writes the
// markup and we'd otherwise have no hook into it. Scoped to
// `.news-report` so nothing else on the page is affected.
const REPORT_CSS = `
.news-report__summary {
  margin: 0 0 18px;
  padding: 10px 14px;
  background: var(--accent-dim, rgba(99,102,241,0.12));
  border-left: 3px solid var(--accent);
  border-radius: 6px;
}
.news-report__summary > summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  color: var(--accent);
  letter-spacing: 0.2px;
  text-transform: uppercase;
  list-style: none;
}
.news-report__summary > summary::-webkit-details-marker { display: none; }
.news-report__summary > summary::after {
  content: ' ▾';
  font-size: 11px;
  color: var(--muted);
}
.news-report__summary[open] > summary::after { content: ' ▴'; }
.news-report__summary > p {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}
.news-report__body { margin-top: 8px; }
.news-report__body h2 {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.2px;
  margin: 22px 0 8px;
  color: var(--text);
}
.news-report__body h3 {
  font-size: 15px;
  font-weight: 600;
  margin: 16px 0 6px;
  color: var(--text);
}
.news-report__body p {
  margin: 0 0 12px;
}
.news-report__body a {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 2px;
}
.news-report__body blockquote {
  margin: 12px 0;
  padding: 6px 14px;
  border-left: 3px solid var(--border);
  color: var(--muted);
  font-style: italic;
}
.news-report__body ul, .news-report__body ol {
  margin: 0 0 12px;
  padding-left: 22px;
}
.news-report__body li { margin-bottom: 4px; }
`

function ReportsTab({ appId, token, online }) {
  // `dates` is the dropdown's data (newest first). `html` is the
  // currently-rendered report body; we lazily fetch it when the user
  // picks a date so flipping between days doesn't re-download history.
  // `cachedReports` mirrors successful body fetches so a date the user
  // already viewed survives an offline reload (and so flipping back to
  // it offline doesn't blank). Seeded from localStorage on first
  // render; written through on every successful body load.
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [html, setHtml] = useState('')
  const [cachedReports, setCachedReports] = useState(() => {
    const c = readCache(appId)
    return c ? c.reports : {}
  })
  const [loading, setLoading] = useState(true)
  const [bodyLoading, setBodyLoading] = useState(false)
  // generating: null = idle, {since: Date, knownDates: Set} when polling.
  const [generating, setGenerating] = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const pollRef = useRef(null)
  // Sync in-flight guard. `generating` (state) drives the UI; this
  // ref guarantees a second handleGenerate call within the same tick
  // can't slip past the React-state check and spawn a second
  // setInterval before disabled={!!generating} has propagated.
  const generatingRef = useRef(false)

  // Initial load: discover available dates, then fetch the newest body.
  // The empty-state copy references the fixed installed run time
  // (INSTALLED_RUN_UTC), not the saved schedule.json, so there's no
  // schedule fetch to do here.
  //
  // Offline behaviour: loadReportEntries returns null when it can't reach
  // the server. On null we fall back to the cached snapshot from the
  // previous session so the user still has reports to read; on [] (a
  // successful but empty listing) we trust the server and do NOT fall
  // back, so reports deleted server-side don't reappear from the cache.
  useEffect(() => {
    (async () => {
      const entries = await loadReportEntries(appId, token)
      const cache = readCache(appId)
      const effectiveDates = entries === null
        ? (cache?.dates || [])
        : entries.map((e) => e.date)
      setDates(effectiveDates)
      if (effectiveDates.length > 0) {
        // Setting selectedDate triggers the per-selection effect below,
        // which handles body fetch + cache-write in one place. No need
        // to duplicate the fetch here.
        setSelectedDate(effectiveDates[0])
      }
      setLoading(false)
    })()
  }, [appId, token])

  // Refetch body when the user picks a different date. Offline path:
  // the network fetch returns null and we fall back to the cached
  // copy (if any). When we DO get a fresh body, write it through to
  // the cache so the next offline reload still sees it.
  useEffect(() => {
    if (!selectedDate) return
    let cancelled = false
    setBodyLoading(true)
    ;(async () => {
      const body = await loadReportHtml(appId, token, selectedDate)
      if (cancelled) return
      if (body) {
        setHtml(body)
        // Persist through the closure's view of `dates`. The closure
        // captures the dates list at the moment the effect ran; any
        // intervening dates update would have triggered its own effect
        // run (so the cache write always uses a coherent (dates, body)
        // pair).
        setCachedReports((prev) => {
          const next = { ...prev, [selectedDate]: body }
          writeCache(appId, dates, next)
          return next
        })
      } else if (cachedReports[selectedDate]) {
        // Offline (or transient server hiccup) — show the cached copy
        // rather than a "could not be loaded" sentinel. Don't touch
        // the cache.
        setHtml(cachedReports[selectedDate])
      } else {
        setHtml('')
      }
      setBodyLoading(false)
    })()
    return () => { cancelled = true }
  }, [appId, token, selectedDate, dates])

  // Stop polling on unmount.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const handleGenerate = useCallback(async () => {
    // Sync guard: setState is async, so two rapid clicks could both
    // see `generating === null` in their closures and spawn parallel
    // setIntervals. The ref flips immediately, before the first
    // await, so the second invocation bails before the network call.
    if (generatingRef.current) return
    generatingRef.current = true
    setErrorMsg('')
    setStatusMsg('Generating report…')
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
        return
      }
      started = Date.now()
    } catch (e) {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      generatingRef.current = false
      return
    }
    const knownDates = new Set(dates)
    // Snapshot each report's modified_at so the poll can detect a
    // SAME-DAY regeneration: fetch.sh overwrites reports/<today>.html,
    // so no new filename appears — completion shows up as today's
    // modified_at advancing, not as a new date.
    const beforeMtime = {}
    for (const e of (await loadReportEntries(appId, token)) || []) {
      beforeMtime[e.date] = e.mtime
    }
    setGenerating({ since: started, knownDates })
    // Defensive: if a prior poll loop is somehow still around (e.g.
    // a future bug in the cleanup path), clear it before installing
    // a new one so we never double-poll.
    if (pollRef.current) clearInterval(pollRef.current)
    // Poll every 5s; give up after 90s.
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started
      const entries = await loadReportEntries(appId, token)
      // Done when a brand-new date appears OR an existing date's
      // modified_at changed (today's report was regenerated in place).
      const done = entries && entries.find((e) =>
        !knownDates.has(e.date) || (e.mtime && e.mtime !== beforeMtime[e.date]))
      if (done) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setDates(entries.map((e) => e.date))
        setSelectedDate(done.date)
        // Force a body refetch: a same-day regeneration leaves
        // selectedDate unchanged, so the per-date effect won't re-run.
        const body = await loadReportHtml(appId, token, done.date)
        if (body) {
          setHtml(body)
          setCachedReports((prev) => {
            const next = { ...prev, [done.date]: body }
            writeCache(appId, entries.map((e) => e.date), next)
            return next
          })
        }
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
  }, [appId, token, dates])

  if (loading) return <div style={S.loading}>Loading reports…</div>

  const currentDate = selectedDate || (dates.length ? dates[0] : null)

  // "Generate report now" hits a server-side job endpoint that has no
  // outbox semantics — it must reach the network or fail. Disable when
  // offline (with a tooltip) rather than letting the click error out
  // after the fact.
  const generateDisabled = !!generating || !online

  return (
    <div>
      {!online && (
        <div style={S.offlineBanner}>
          Offline — showing last cached reports. New digests resume once
          you’re back online.
        </div>
      )}
      <div style={S.topRow}>
        <select
          style={S.datePicker}
          value={currentDate || ''}
          onChange={(e) => setSelectedDate(e.target.value)}
          disabled={dates.length === 0}
        >
          {dates.length === 0 && <option value="">No reports yet</option>}
          {dates.map((d) => (
            <option key={d} value={d}>{formatDate(d)}</option>
          ))}
        </select>
        <button
          style={S.generateBtn(generateDisabled)}
          onClick={handleGenerate}
          disabled={generateDisabled}
          title={!online ? 'Online required to trigger a fetch' : undefined}
        >
          {generating ? 'Generating…' : 'Generate report now'}
        </button>
        {statusMsg && <span style={S.statusHint}>{statusMsg}</span>}
        {errorMsg && <span style={S.errorToast}>{errorMsg}</span>}
      </div>

      {!currentDate ? (
        <div style={S.empty}>
          {(() => {
            // Tell the user when the next scheduled digest actually
            // fires, in their local clock. The fire time is the FIXED
            // installed cron (INSTALLED_RUN_UTC, 10:00 UTC daily) — not
            // the saved schedule.json, which the platform doesn't act
            // on.
            const next = nextInstalledRun()
            const clock = formatLocalClock(next)
            // Branch on the computed next-run date: same-day vs.
            // next-day, and morning vs. otherwise, so the sentence reads
            // naturally whatever the user's offset from UTC is.
            const now = new Date()
            const sameDay = next.getDate() === now.getDate()
              && next.getMonth() === now.getMonth()
              && next.getFullYear() === now.getFullYear()
            const hourLocal = next.getHours()
            const isMorning = hourLocal >= 5 && hourLocal < 12
            let when
            if (sameDay) {
              when = isMorning
                ? `later this morning at ${clock}`
                : `later today at ${clock}`
            } else {
              when = isMorning
                ? `tomorrow morning at ${clock}`
                : `tomorrow at ${clock}`
            }
            return `Your first digest will land here ${when}. Press “Generate report now” to start one immediately.`
          })()}
        </div>
      ) : bodyLoading ? (
        <div style={S.loading}>Loading report…</div>
      ) : !html ? (
        <div style={S.empty}>This report could not be loaded.</div>
      ) : (
        <div
          style={S.reportContainer}
          // HTML comes from the agent's web-searched + composed report.
          // Even though the agent and the Möbius instance share the
          // single-owner trust boundary, the agent QUOTES untrusted
          // web content inline (source citations, blockquotes). A
          // poisoned source could inject <script>/onerror=/javascript:
          // URIs that, rendered verbatim, would run in the same-origin
          // DOM with the owner's JWT in localStorage. DOMPurify strips
          // every common XSS shape before injection — see SANITIZE_CONFIG.
          dangerouslySetInnerHTML={{ __html: sanitizeReportHtml(html) }}
        />
      )}
    </div>
  )
}

// Stitch the backend's `{claude: [...], codex: [...]}` payload onto
// the PROVIDER_ORDER scaffold, dropping providers the backend didn't
// return and ignoring any unknown keys. Returns a list shaped like
// FALLBACK_GROUPS so the picker render path doesn't care where the
// data came from.
function buildProviderGroups(payload) {
  if (!payload || typeof payload !== 'object') return FALLBACK_GROUPS
  const groups = []
  for (const meta of PROVIDER_ORDER) {
    const rows = Array.isArray(payload[meta.key]) ? payload[meta.key] : null
    if (!rows || rows.length === 0) continue
    // Defensive normalize: tolerate missing `name` (fall back to id)
    // so a half-shaped row from a future backend never blanks a row.
    groups.push({
      key: meta.key,
      label: meta.label,
      models: rows
        .filter((r) => r && typeof r.id === 'string')
        .map((r) => ({ id: r.id, name: r.name || r.id })),
    })
  }
  return groups.length > 0 ? groups : FALLBACK_GROUPS
}

function SettingsTab({ appId, token, online }) {
  const [topics, setTopics] = useState('')
  // agent state: provider + model picked together.
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const [model, setModel] = useState(DEFAULT_MODEL)
  // Provider groups (shape: { key, label, models: [{id, name}] }).
  // Populated from `GET /api/auth/providers/models` on mount; falls
  // back to FALLBACK_GROUPS when the endpoint is missing (older
  // mobius) or unreachable. We initialise to null (rather than the
  // fallback) so the picker can show a "Loading models…" hint
  // distinct from the fallback render.
  const [providerGroups, setProviderGroups] = useState(null)
  // null = still loading; otherwise a Set of provider ids that
  // are authenticated. Null is treated as "show everything as
  // connected" so the picker isn't blocked if the status endpoint
  // errors. Same fallback as the shell's ChatSettingsPanel.
  const [connectedProviders, setConnectedProviders] = useState(null)
  const [loading, setLoading] = useState(true)
  const [topicsToast, setTopicsToast] = useState('')
  const [agentToast, setAgentToast] = useState('')
  // Run-now affordance state. The button delegates to the same
  // /api/apps/<id>/run-job endpoint the Reports tab uses for
  // "Generate report now" — Settings just gets a compact entry-point
  // next to the schedule info so the owner can pull a digest on demand.
  const [runNowBusy, setRunNowBusy] = useState(false)
  const [runNowToast, setRunNowToast] = useState('')
  const [runNowError, setRunNowError] = useState('')
  // Sync in-flight guard for Run-now. `runNowBusy` (state) drives
  // both the button label and `disabled`, but setState is async —
  // two rapid clicks can both clear the runNowBusy check from their
  // closures before disabled propagates to the DOM. The ref flips
  // synchronously, before the first `await`, so the second click's
  // POST never fires.
  const runNowRef = useRef(false)

  const localTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
    catch { return 'UTC' }
  }, [])

  useEffect(() => {
    (async () => {
      const [tRes, aRes, pRes, mRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/topics.txt`, token),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token, appId),
        getJSON(`/api/auth/providers/status`, token),
        getJSON(`/api/auth/providers/models`, token),
      ])
      setTopics(tRes.ok ? tRes.data : DEFAULT_TOPICS)
      // Stitch the model list into PROVIDER_ORDER, or fall back if
      // the endpoint isn't there (older mobius / offline).
      const groups = mRes.ok ? buildProviderGroups(mRes.data) : FALLBACK_GROUPS
      setProviderGroups(groups)
      // Build the connected set FIRST so we can compute a sensible
      // default for an un-seeded agent.json (first model of the
      // first connected provider).
      let connected = null
      if (pRes.ok && pRes.data && typeof pRes.data === 'object') {
        connected = new Set(
          Object.entries(pRes.data)
            .filter(([, v]) => v && v.authenticated)
            .map(([k]) => k),
        )
        setConnectedProviders(connected)
      }
      // Resolve provider + model from the stored agent.json, falling
      // back to the first model of the first connected provider, then
      // to the bundled defaults.
      const stored = aRes.ok && aRes.data ? aRes.data : null
      const storedProvider = stored && typeof stored.provider === 'string'
        ? stored.provider : null
      const storedModel = stored && typeof stored.model === 'string'
        ? stored.model : null
      const knownProvider = groups.find(g => g.key === storedProvider)
      if (knownProvider) {
        setProvider(knownProvider.key)
        // Trust the persisted model id even if it isn't in the fetched
        // list — the user (or a future shell update) may know about a
        // model we haven't surfaced yet. fetch.sh just passes --model
        // through; the CLI is the source of truth.
        setModel(storedModel || knownProvider.models[0].id)
      } else {
        // No (valid) saved agent.json — pick the first model of the
        // first CONNECTED provider so the user lands on something
        // that will actually run. Falls back to the first model of
        // the first group when nothing is connected.
        let chosen = null
        if (connected) {
          for (const g of groups) {
            if (connected.has(g.key)) { chosen = g; break }
          }
        }
        if (!chosen) chosen = groups[0]
        setProvider(chosen.key)
        setModel(chosen.models[0].id)
      }
      setLoading(false)
    })()
  }, [appId, token])

  // The shim returns {synced} (write landed online) or {queued} (offline,
  // queued in IndexedDB; will drain on reconnect). We surface the
  // difference in the toast so the user knows a save while offline isn't
  // lost — it'll sync later.
  const toastFor = (result, savedLabel = 'Saved ✓') => {
    if (result && result.queued) return 'Saved offline — will sync'
    return savedLabel
  }

  const saveTopics = useCallback(async () => {
    const res = await putText(
      `/api/storage/apps/${appId}/topics.txt`, token, topics, appId,
    )
    setTopicsToast(toastFor(res))
    setTimeout(() => setTopicsToast(''), 2000)
  }, [appId, token, topics])

  const resetTopics = useCallback(async () => {
    setTopics(DEFAULT_TOPICS)
    const res = await putText(
      `/api/storage/apps/${appId}/topics.txt`, token, DEFAULT_TOPICS, appId,
    )
    setTopicsToast(toastFor(res, 'Reset to default ✓'))
    setTimeout(() => setTopicsToast(''), 2000)
  }, [appId, token])

  const saveAgent = useCallback(async (nextProvider, nextModel) => {
    setProvider(nextProvider)
    setModel(nextModel)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      { provider: nextProvider, model: nextModel },
      appId,
    )
    setAgentToast(toastFor(res))
    setTimeout(() => setAgentToast(''), 2000)
  }, [appId, token])

  const handleRunNow = useCallback(async () => {
    // POST /api/apps/<id>/run-job spawns fetch.sh as a detached
    // subprocess and returns 202 with {started_at}. We don't poll
    // for completion here — the job lands in storage and the
    // Reports tab will pick it up on next mount. The toast just
    // confirms "we kicked it off" so the user knows the click took
    // effect; the actual report shows up wherever Reports already
    // surfaces new dates (no extra plumbing needed).
    //
    // Use the ref (not the state) as the sync guard — two clicks in
    // the same tick read the same closure, so the state-based check
    // can race past itself before disabled propagates to the DOM.
    if (runNowRef.current) return
    runNowRef.current = true
    setRunNowBusy(true)
    setRunNowError('')
    setRunNowToast('')
    try {
      const r = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) {
        setRunNowError(`Could not start job (HTTP ${r.status}).`)
      } else {
        setRunNowToast('Started — your digest will appear in Reports shortly.')
        setTimeout(() => setRunNowToast(''), 4000)
      }
    } catch {
      setRunNowError('Could not reach the server.')
    } finally {
      setRunNowBusy(false)
      runNowRef.current = false
    }
  }, [appId, token])

  if (loading) return <div style={S.loading}>Loading settings…</div>

  // Human label for the FIXED installed run time: "10:00 UTC (≈ 11:00
  // your local time)". The cron fires in UTC, so we render the UTC
  // clock plus the local equivalent for the reader's own offset.
  const installedRunLabel = (() => {
    const utc = `${String(INSTALLED_RUN_UTC.hour).padStart(2, '0')}:`
      + `${String(INSTALLED_RUN_UTC.minute).padStart(2, '0')} UTC`
    const d = new Date()
    d.setUTCHours(INSTALLED_RUN_UTC.hour, INSTALLED_RUN_UTC.minute, 0, 0)
    const local = formatLocalClock(d)
    return `${utc} (≈ ${local} ${localTz})`
  })()

  return (
    <div style={S.settingsWrap}>
      <div style={S.settingsSection}>
        {/* Label: "Editorial brief" rather than the old "What to search
            for". The textarea now carries most of the editorial intent
            (topics, sources, voice, framing), while system-prompt.md is
            kept as a thin technical schema. "Editorial brief" sets the
            expectation that this is prose, not a keyword list. */}
        <label style={S.label}>Editorial brief</label>
        <p style={S.note}>
          Describe what stories you want in your daily digest — topics,
          regions, beats, tone. Plain English; no formatting needed.
        </p>
        <textarea
          style={S.topicsTextarea}
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          // 12 rows by default so the editorial brief has room to
          // breathe; the user can still drag the resize handle.
          rows={12}
          spellCheck={true}
        />
        <p style={{ ...S.note, marginTop: '6px', marginBottom: 0 }}>
          This is your editorial brief. Tell the agent what you want —
          topics, sources, framing, voice. The technical formatting is
          handled separately.
        </p>
        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveTopics}>Save</button>
          <button style={S.linkBtn} onClick={resetTopics}>Reset to default</button>
          {topicsToast && <span style={S.toast}>{topicsToast}</span>}
        </div>
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Agent / Model</label>
        <p style={S.note}>
          Which model generates your daily digest. Pick any model from a
          connected provider — disconnected providers stay visible but
          their rows are inert; connect them from the shell’s Settings.
        </p>
        <div style={S.modelList}>
          {providerGroups === null ? (
            // Initial fetch still in flight. Brief loading line keeps
            // the section's vertical rhythm so the rest of Settings
            // doesn't reflow when the rows land.
            <div style={S.note}>Loading models…</div>
          ) : providerGroups.map((group) => {
            // A provider is "connected" if the status endpoint listed
            // it as authenticated. When we couldn't fetch the status
            // (connectedProviders === null) we fall back to "treat all
            // as connected" — same posture as ChatSettingsPanel.
            const isConnected = !connectedProviders
              || connectedProviders.has(group.key)
            // Always render the group that owns the currently-selected
            // model, even if disconnected, so the user can see what's
            // active and switch away. Other disconnected groups still
            // render — just inert + hinted.
            return (
              <div key={group.key} style={S.modelGroup}>
                <div style={S.modelGroupHeader}>
                  <span>{group.label}</span>
                  {!isConnected && (
                    <span style={S.modelGroupHint}>
                      · Not connected
                    </span>
                  )}
                </div>
                {group.models.map((m) => {
                  const on = provider === group.key && model === m.id
                  // Allow re-selecting the currently-active row even
                  // when its provider is disconnected (no-op write —
                  // matches the shell's "selected is always
                  // interactive" stance). Other rows in a disconnected
                  // group are inert.
                  const disabled = !isConnected && !on
                  return (
                    <div
                      key={`${group.key}-${m.id}`}
                      style={S.modelRow(on, disabled)}
                      onClick={() => {
                        if (disabled) return
                        saveAgent(group.key, m.id)
                      }}
                      role="radio"
                      aria-checked={on}
                      aria-disabled={disabled}
                    >
                      <input
                        type="radio"
                        checked={on}
                        readOnly
                        disabled={disabled}
                        style={{ accentColor: 'var(--accent)' }}
                      />
                      <div style={S.modelRowMain}>
                        <span style={S.modelRowTitle}>{m.name}</span>
                        <span style={S.modelRowSub}>{m.id}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
        {agentToast && (
          <div style={{ ...S.btnRow, marginTop: '8px' }}>
            <span style={S.toast}>{agentToast}</span>
          </div>
        )}
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Schedule</label>
        {/* Honest schedule block. The daily cron is fixed at install
            (INSTALLED_RUN_UTC) and no platform reconciler reads a
            saved time back, so we don't offer a picker that silently
            does nothing. We state the real fire time and point the
            owner at the one lever that does change it: ask the agent
            to edit the cron. That's the app's whole "extend it
            yourself" contract made explicit. */}
        <p style={S.note}>
          Your digest runs once a day at <strong>{installedRunLabel}</strong>.
        </p>
        <p style={S.note}>
          To change when it runs, ask the Möbius agent — e.g. “reschedule
          the News digest to 7am my time.” The agent edits the cron entry
          directly; there’s no in-app time picker because nothing in the
          platform would act on a saved time today.
        </p>
        <div style={S.btnRow}>
          {/* Run now: kicks off /api/apps/<id>/run-job (the same
              endpoint the Reports tab's "Generate report now" uses) so
              the owner can pull a digest immediately instead of waiting
              for the daily run. Inline "running…" + success/error toast
              rather than a poll-and-replace flow — the Reports tab owns
              the freshness signal once the job lands. Server-side job
              trigger with no outbox semantics, so it's disabled offline
              rather than letting the POST fail after the click. */}
          <button
            style={(runNowBusy || !online) ? S.btnSecondaryBusy : S.btnSecondary}
            onClick={handleRunNow}
            disabled={runNowBusy || !online}
            aria-busy={runNowBusy}
            title={!online ? 'Online required to trigger a fetch' : undefined}
          >
            {runNowBusy ? 'Running…' : 'Run now'}
          </button>
          {runNowToast && <span style={S.toast}>{runNowToast}</span>}
          {runNowError && <span style={S.errorToast}>{runNowError}</span>}
        </div>
      </div>
    </div>
  )
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')
  const online = useOnline()

  return (
    <div style={S.root}>
      {/* Scoped stylesheet for the agent-emitted .news-report markup.
          Injected once here so dangerouslySetInnerHTML content picks
          up styling without us walking the DOM. */}
      <style>{REPORT_CSS}</style>
      <div style={S.header}>
        <h1 style={S.title}>News</h1>
        <div style={S.tabs}>
          <button style={S.tab(tab === 'reports')} onClick={() => setTab('reports')}>
            Reports
          </button>
          <button style={S.tab(tab === 'settings')} onClick={() => setTab('settings')}>
            Settings
          </button>
        </div>
      </div>
      <div style={S.divider} />
      <div style={S.scroll}>
        {tab === 'reports'
          ? <ReportsTab appId={appId} token={token} online={online} />
          : <SettingsTab appId={appId} token={token} online={online} />}
      </div>
    </div>
  )
}
