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

function ReportsTab({ appId, token }) {
  // `dates` is the dropdown's data (newest first). `html` is the
  // currently-rendered report body; we lazily fetch it when the user
  // picks a date so flipping between days doesn't re-download history.
  const [dates, setDates] = useState([])
  const [selectedDate, setSelectedDate] = useState(null)
  const [html, setHtml] = useState('')
  const [loading, setLoading] = useState(true)
  const [bodyLoading, setBodyLoading] = useState(false)
  // generating: null = idle, {since: Date, knownDates: Set} when polling.
  const [generating, setGenerating] = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const pollRef = useRef(null)

  // Initial load: discover available dates, then fetch the newest body.
  useEffect(() => {
    (async () => {
      const list = await loadReportDates(appId, token)
      setDates(list)
      if (list.length > 0) {
        setSelectedDate(list[0])
        const body = await loadReportHtml(appId, token, list[0])
        setHtml(body || '')
      }
      setLoading(false)
    })()
  }, [appId, token])

  // Refetch body when the user picks a different date.
  useEffect(() => {
    if (!selectedDate) return
    let cancelled = false
    setBodyLoading(true)
    ;(async () => {
      const body = await loadReportHtml(appId, token, selectedDate)
      if (!cancelled) {
        setHtml(body || '')
        setBodyLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [appId, token, selectedDate])

  // Stop polling on unmount.
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const handleGenerate = useCallback(async () => {
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
        return
      }
      started = Date.now()
    } catch (e) {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      return
    }
    const knownDates = new Set(dates)
    setGenerating({ since: started, knownDates })
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
        setStatusMsg('New report ready.')
        setTimeout(() => setStatusMsg(''), 3500)
        return
      }
      if (elapsed > 90_000) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setGenerating(null)
        setStatusMsg('')
        setErrorMsg('Report taking longer than expected. Check back soon.')
      }
    }, 5000)
  }, [appId, token, dates])

  if (loading) return <div style={S.loading}>Loading reports…</div>

  const currentDate = selectedDate || (dates.length ? dates[0] : null)

  return (
    <div>
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
          style={S.generateBtn(!!generating)}
          onClick={handleGenerate}
          disabled={!!generating}
        >
          {generating ? 'Generating…' : 'Generate report now'}
        </button>
        {statusMsg && <span style={S.statusHint}>{statusMsg}</span>}
        {errorMsg && <span style={S.errorToast}>{errorMsg}</span>}
      </div>

      {!currentDate ? (
        <div style={S.empty}>
          No reports yet. Press “Generate report now” or wait for the next
          scheduled run.
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

function SettingsTab({ appId, token }) {
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
    const [h, m] = e.target.value.split(':').map(Number)
    setHour(h); setMinute(m)
  }, [])

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
          {scheduleToast && <span style={S.toast}>{scheduleToast}</span>}
        </div>
      </div>
    </div>
  )
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')

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
          ? <ReportsTab appId={appId} token={token} />
          : <SettingsTab appId={appId} token={token} />}
      </div>
    </div>
  )
}
