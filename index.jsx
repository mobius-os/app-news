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
  timeRow: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  timeInput: {
    padding: '7px 10px', fontSize: '14px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    outline: 'none', width: '120px',
  },
  tzRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    marginTop: '8px', fontSize: '12.5px', color: 'var(--muted)',
    flexWrap: 'wrap',
  },
  // "Next run" affordance under the time picker. Slightly more
  // prominent than the tz hint row so the user's eye lands on
  // "when does my next digest fire" before the tz/DST checkbox.
  nextRun: {
    display: 'flex', alignItems: 'baseline', gap: '6px',
    marginTop: '6px', fontSize: '12.5px',
    color: 'var(--text)', flexWrap: 'wrap',
  },
  nextRunClock: { fontWeight: 600 },
  nextRunCountdown: { color: 'var(--muted)' },
  // Secondary button for "Run now" — same shape as the primary
  // Save button but with a surface-coloured fill so the two read
  // as paired actions, not a hierarchy.
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

// Compute the next firing of an hour/minute schedule, returning a
// Date in the user's local zone. When `useLocalTz` is true the
// stored hour/minute are interpreted as local clock time; otherwise
// they're UTC (matches the cron sync's interpretation). Returns the
// next occurrence strictly in the future — if today's time has
// already passed, rolls forward one day.
function nextRunDate(hour, minute, useLocalTz) {
  const now = new Date()
  const next = new Date(now)
  if (useLocalTz) {
    next.setHours(hour, minute, 0, 0)
  } else {
    next.setUTCHours(hour, minute, 0, 0)
  }
  if (next <= now) {
    next.setDate(next.getDate() + 1)
  }
  return next
}

// Human-friendly "in 3h 42m" / "in 12m" / "in 30s" string for a
// future Date. We keep the unit set small so the affordance reads
// as a quick glance, not a stopwatch.
function formatCountdown(next, now) {
  const ms = next.getTime() - now.getTime()
  if (ms <= 0) return 'any moment'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h >= 1) return `in ${h}h ${m}m`
  if (m >= 1) return `in ${m}m`
  return `in ${totalSec}s`
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

async function getJSON(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) return { ok: false, status: r.status }
  try { return { ok: true, data: await r.json() } }
  catch { return { ok: false, status: 500 } }
}

async function getText(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) return { ok: false, status: r.status }
  return { ok: true, data: await r.text() }
}

async function putJSON(url, token, obj) {
  return fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  })
}

async function putText(url, token, text) {
  return fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: text,
  })
}

// Probe the last 30 days for available report dates. We HEAD each
// candidate path; the body is fetched lazily when the user picks a
// date. This keeps the initial load light even with a month of
// history.
async function loadReportDates(appId, token) {
  const dates = []
  const today = new Date()
  let misses = 0
  for (let i = 0; i < 30; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const url = `/api/storage/apps/${appId}/reports/${dateStr}.html`
    let ok = false
    try {
      const r = await fetch(url, {
        method: 'HEAD',
        headers: { Authorization: `Bearer ${token}` },
      })
      ok = r.ok
    } catch {
      ok = false
    }
    if (ok) {
      dates.push(dateStr)
      misses = 0
    } else {
      misses++
    }
    if (misses >= 5) break
  }
  return dates
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
  // Schedule snapshot — only used to fill the empty-state copy with
  // the configured delivery time. Fetched alongside the report list
  // so the empty-state hint never renders with a stale-looking
  // "tomorrow at unknown" placeholder.
  const [schedule, setSchedule] = useState(null)
  const pollRef = useRef(null)
  // Sync in-flight guard. `generating` (state) drives the UI; this
  // ref guarantees a second handleGenerate call within the same tick
  // can't slip past the React-state check and spawn a second
  // setInterval before disabled={!!generating} has propagated.
  const generatingRef = useRef(false)

  // Initial load: discover available dates, then fetch the newest body.
  // The schedule fetch runs in parallel so the empty-state copy
  // (which references the configured delivery time) can render the
  // moment the dates probe comes back empty.
  //
  // Offline behaviour: loadReportDates HEADs ~30 URLs; offline they all
  // reject and it returns []. When the live probe yields nothing, fall
  // back to the cached snapshot from the previous session so the user
  // still has reports to read. We trust the cache only when the live
  // probe came up empty — never replace a fresher server view with a
  // stale one.
  useEffect(() => {
    (async () => {
      const [list, sRes] = await Promise.all([
        loadReportDates(appId, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token),
      ])
      const cache = readCache(appId)
      const effectiveDates = list.length > 0
        ? list
        : (cache?.dates || [])
      setDates(effectiveDates)
      if (sRes.ok && sRes.data) setSchedule(sRes.data)
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
    setGenerating({ since: started, knownDates })
    // Defensive: if a prior poll loop is somehow still around (e.g.
    // a future bug in the cleanup path), clear it before installing
    // a new one so we never double-poll.
    if (pollRef.current) clearInterval(pollRef.current)
    // Poll every 5s; give up after 90s.
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started
      const list = await loadReportDates(appId, token)
      const fresh = list.find((d) => !knownDates.has(d))
      if (fresh) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setDates(list)
        setSelectedDate(fresh)
        setGenerating(null)
        generatingRef.current = false
        setStatusMsg('New report ready.')
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
            // Light copy polish: surface the configured delivery time
            // so the empty state reads as "here's exactly when to
            // expect your first digest" rather than a vague hint. We
            // compute the next firing in the user's local clock from
            // the stored hour/minute (UTC unless `timezone` was set,
            // matching the schedule.json contract).
            if (!schedule) {
              return 'Your first digest will land here soon. Press “Generate report now” to start one immediately.'
            }
            const hour = schedule.hour ?? 10
            const minute = schedule.minute ?? 0
            const useLocalTz = !!schedule.timezone
            const next = nextRunDate(hour, minute, useLocalTz)
            const clock = formatLocalClock(next)
            // "Tomorrow morning at HH:MM" was wrong for late-evening
            // schedules (e.g. 23:00) and even mis-stated the day when
            // the next firing is later TODAY. Branch on the computed
            // next-run date instead: same-day vs. next-day, and
            // morning vs. otherwise. Falls through to a neutral "next
            // at HH:MM" for the awkward cases.
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
  const [hour, setHour] = useState(10)
  const [minute, setMinute] = useState(0)
  const [useLocalTz, setUseLocalTz] = useState(false)
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
  const [scheduleToast, setScheduleToast] = useState('')
  const [agentToast, setAgentToast] = useState('')
  // Run-now affordance state. The button delegates to the same
  // /api/apps/<id>/run-job endpoint the Reports tab uses for
  // "Generate report now" — settings just gets a more compact
  // entry-point that lives next to the schedule editor for users
  // who already opened Settings to tweak the time.
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
  // Re-render tick for the live countdown next to the time picker.
  // We only need minute-resolution accuracy but tick every 30s so
  // crossing a minute boundary doesn't lag visibly.
  const [, setCountdownTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setCountdownTick((t) => t + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const localTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
    catch { return 'UTC' }
  }, [])

  useEffect(() => {
    (async () => {
      const [tRes, sRes, aRes, pRes, mRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/topics.txt`, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token),
        getJSON(`/api/auth/providers/status`, token),
        getJSON(`/api/auth/providers/models`, token),
      ])
      setTopics(tRes.ok ? tRes.data : DEFAULT_TOPICS)
      if (sRes.ok && sRes.data) {
        setHour(sRes.data.hour ?? 10)
        setMinute(sRes.data.minute ?? 0)
        setUseLocalTz(!!sRes.data.timezone)
      }
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

  const saveTopics = useCallback(async () => {
    await putText(`/api/storage/apps/${appId}/topics.txt`, token, topics)
    setTopicsToast('Saved ✓')
    setTimeout(() => setTopicsToast(''), 2000)
  }, [appId, token, topics])

  const resetTopics = useCallback(async () => {
    setTopics(DEFAULT_TOPICS)
    await putText(`/api/storage/apps/${appId}/topics.txt`, token, DEFAULT_TOPICS)
    setTopicsToast('Reset to default ✓')
    setTimeout(() => setTopicsToast(''), 2000)
  }, [appId, token])

  const saveSchedule = useCallback(async () => {
    const payload = { hour, minute }
    if (useLocalTz) payload.timezone = localTz
    await putJSON(`/api/storage/apps/${appId}/schedule.json`, token, payload)
    setScheduleToast('Saved ✓')
    setTimeout(() => setScheduleToast(''), 2000)
  }, [appId, token, hour, minute, useLocalTz, localTz])

  const saveAgent = useCallback(async (nextProvider, nextModel) => {
    setProvider(nextProvider)
    setModel(nextModel)
    await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      { provider: nextProvider, model: nextModel },
    )
    setAgentToast('Saved ✓')
    setTimeout(() => setAgentToast(''), 2000)
  }, [appId, token])

  const onTimeChange = useCallback((e) => {
    // <input type="time"> can yield an empty string in some browsers
    // (clear button, mobile dismiss). Guard against NaN propagating
    // into hour/minute state — Invalid Date would blank the next-run
    // affordance and the saved schedule.
    const value = e.target.value
    if (!value) return
    const [h, m] = value.split(':').map(Number)
    if (Number.isNaN(h) || Number.isNaN(m)) return
    setHour(h); setMinute(m)
  }, [])

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

  const timeValue = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  // What time does the schedule actually fire in the user's local clock?
  // If useLocalTz is on, hour/minute ARE local — display them as-is plus
  // the IANA tz. Otherwise they're UTC; convert to local for the hint.
  const localEquiv = (() => {
    if (useLocalTz) {
      return `${timeValue} ${localTz}`
    }
    const d = new Date()
    d.setUTCHours(hour, minute, 0, 0)
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  })()
  const tzLabel = useLocalTz
    ? `Delivering at ${timeValue} ${localTz} (your local time).`
    : `Delivering at ${timeValue} UTC ≈ ${localEquiv} in your local time (${localTz}).`

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
        <label style={S.label}>Delivery time</label>
        <p style={S.note}>
          When the daily digest is generated. Schedule changes apply within
          10 minutes.
        </p>
        <div style={S.timeRow}>
          <input
            type="time"
            style={S.timeInput}
            value={timeValue}
            onChange={onTimeChange}
            title={tzLabel}
          />
        </div>
        {/* Next-run affordance. Uses the SAVED schedule field values
            via the live state — note this means the line reflects the
            unsaved picker change immediately rather than the last
            stored value. That's intentional: the user is editing the
            schedule and wants to see the consequence of their edit,
            not the stale stored time. Recomputed on each render +
            the 30s tick driving setCountdownTick. */}
        {(() => {
          const next = nextRunDate(hour, minute, useLocalTz)
          const clock = formatLocalClock(next)
          const countdown = formatCountdown(next, new Date())
          return (
            <div style={S.nextRun}>
              <span>Next run:</span>
              <span style={S.nextRunClock}>{clock}</span>
              <span style={S.nextRunCountdown}>({countdown})</span>
            </div>
          )
        })()}
        <div style={S.tzRow}>{tzLabel}</div>
        <label
          style={{
            ...S.tzRow,
            cursor: 'pointer', color: 'var(--text)', marginTop: '6px',
          }}
        >
          <input
            type="checkbox"
            checked={useLocalTz}
            onChange={(e) => setUseLocalTz(e.target.checked)}
            style={{ accentColor: 'var(--accent)' }}
          />
          <span>Use my local time ({localTz}) — handles DST automatically</span>
        </label>

        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveSchedule}>Save schedule</button>
          {/* Run now: kicks off /api/apps/<id>/run-job (same endpoint
              the Reports tab's "Generate report now" uses). Lives in
              Settings because the user is already here adjusting
              schedule; offering the manual trigger inline removes the
              tab-hop. Inline "running..." + success/error toast
              rather than a full poll-and-replace flow — Reports owns
              the freshness signal once the job lands. */}
          {/* Run-now is a server-side job trigger; no outbox semantics,
              so we disable when offline rather than letting the POST
              fail after the click. Same posture as the Reports tab's
              "Generate report now" button. */}
          <button
            style={(runNowBusy || !online) ? S.btnSecondaryBusy : S.btnSecondary}
            onClick={handleRunNow}
            disabled={runNowBusy || !online}
            aria-busy={runNowBusy}
            title={!online ? 'Online required to trigger a fetch' : undefined}
          >
            {runNowBusy ? 'Running…' : 'Run now'}
          </button>
          {scheduleToast && <span style={S.toast}>{scheduleToast}</span>}
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
