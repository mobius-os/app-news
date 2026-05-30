import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'

const DEFAULT_CATEGORIES = [
  { key: 'world', label: 'World' },
  { key: 'business', label: 'Business' },
  { key: 'tech', label: 'Tech' },
  { key: 'science', label: 'Science' },
  { key: 'sports', label: 'Sports' },
  { key: 'culture', label: 'Culture' },
]

const CATEGORY_LABEL = Object.fromEntries(
  DEFAULT_CATEGORIES.map((c) => [c.key, c.label]),
)

const PROVIDERS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
]

// Inlined copy of prompt.md — used for "Reset to default" in Settings.
const DEFAULT_PROMPT = `# Daily News Curator

You are a news curator producing a structured digest of the most important stories from the last 24 hours.

Fetch top stories across these sections: **world**, **business**, **tech**, **science**, **sports**, and **culture**. Use reputable, primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, etc.). Pull direct article URLs from publisher RSS feeds — never fabricate or reconstruct links; omit an article rather than guess its URL.

Output a single JSON object:

\`\`\`json
{
  "date": "YYYY-MM-DD",
  "summary": "2-3 sentence overview of the day across all sections.",
  "sections": [
    {
      "key": "world",
      "title": "World",
      "articles": [
        { "title": "...", "summary": "...", "url": "https://...", "source": "Reuters" }
      ]
    }
  ]
}
\`\`\`

Constraints: 3-5 articles per section. Each summary is 2-3 sentences answering what happened and why it matters. Use neutral framing; surface multiple viewpoints when a story is divisive. No editorializing, no speculation. Cite the publisher in \`source\`.
`

const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font)',
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
  scroll: { flex: 1, overflow: 'auto', padding: '14px 20px 32px' },

  // Reports — top control row
  topRow: {
    display: 'flex', alignItems: 'center', gap: '10px',
    marginBottom: '14px', flexWrap: 'wrap',
  },
  datePicker: {
    padding: '7px 10px', fontSize: '13px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    outline: 'none', minWidth: '180px',
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

  // Article list
  reportSummary: {
    fontSize: '13px', lineHeight: 1.55, color: 'var(--text)',
    margin: '6px 0 14px', padding: '10px 12px',
    background: 'var(--accent-dim)', borderRadius: '6px',
    borderLeft: '3px solid var(--accent)',
  },
  article: {
    marginBottom: '10px', padding: '12px 14px',
    background: 'var(--surface)', borderRadius: '10px',
    border: '1px solid var(--border)',
  },
  headline: {
    fontSize: '14px', fontWeight: 600, margin: '0 0 6px',
    lineHeight: 1.4,
  },
  headlineLink: {
    color: 'var(--accent)', textDecoration: 'none',
  },
  articleSummary: {
    fontSize: '12.5px', lineHeight: 1.55, color: 'var(--text)',
    margin: '0 0 8px',
  },
  pillRow: { display: 'flex', gap: '6px', flexWrap: 'wrap' },
  sourcePill: {
    display: 'inline-block', fontSize: '11px', padding: '2px 8px',
    borderRadius: '999px', background: 'var(--bg)',
    border: '1px solid var(--border)', color: 'var(--muted)',
  },
  categoryPill: {
    display: 'inline-block', fontSize: '10.5px', padding: '2px 8px',
    borderRadius: '999px', background: 'var(--surface2)',
    border: '1px solid var(--border)', color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '0.4px',
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
  promptCard: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: '8px', padding: '14px 16px',
    fontSize: '13px', lineHeight: 1.55, color: 'var(--text)',
    maxHeight: '380px', overflow: 'auto',
  },
  textarea: {
    width: '100%', minHeight: '320px', fontFamily: 'var(--mono, monospace)',
    fontSize: '12px', lineHeight: 1.5, padding: '12px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '8px',
    resize: 'vertical', outline: 'none', boxSizing: 'border-box',
  },
  btnRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px' },
  btn: {
    padding: '7px 16px', border: 'none', borderRadius: '10px',
    background: 'var(--accent)', color: '#fff',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  btnGhost: {
    padding: '7px 14px', border: '1px solid var(--border)', borderRadius: '10px',
    background: 'var(--surface)', color: 'var(--text)',
    fontSize: '13px', fontWeight: 500, cursor: 'pointer',
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
  localHint: { fontSize: '12px', color: 'var(--muted)' },
  tzRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    marginTop: '8px', fontSize: '12.5px', color: 'var(--muted)',
  },
  catGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
    gap: '6px', marginTop: '8px',
  },
  catChip: (on) => ({
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '7px 10px', borderRadius: '8px', cursor: 'pointer',
    background: on ? 'var(--accent-dim)' : 'var(--surface)',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    fontSize: '13px', userSelect: 'none',
  }),
  radioRow: {
    display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap',
  },
  radioChip: (on) => ({
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '8px 14px', borderRadius: '10px', cursor: 'pointer',
    background: on ? 'var(--accent-dim)' : 'var(--surface)',
    border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
    fontSize: '13px', fontWeight: 500, userSelect: 'none',
  }),
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

async function loadAllReports(appId, token) {
  const reports = []
  const today = new Date()
  let misses = 0
  for (let i = 0; i < 30; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const res = await getJSON(`/api/storage/apps/${appId}/reports/${dateStr}.json`, token)
    if (res.ok && res.data && res.data.date) {
      reports.push(res.data)
      misses = 0
    } else {
      misses++
    }
    if (misses >= 5) break
  }
  return reports
}

function flattenArticles(report) {
  // Each section's articles → flat list with category context attached.
  if (!report || !Array.isArray(report.sections)) return []
  const out = []
  for (const sec of report.sections) {
    const catKey = sec.key || ''
    const catLabel = sec.title || CATEGORY_LABEL[catKey] || catKey
    for (const art of (sec.articles || [])) {
      out.push({ ...art, _catKey: catKey, _catLabel: catLabel })
    }
  }
  return out
}

function Article({ art }) {
  return (
    <div style={S.article}>
      <p style={S.headline}>
        {art.url ? (
          <a
            href={art.url}
            target="_blank"
            rel="noopener noreferrer"
            style={S.headlineLink}
          >
            {art.title}
          </a>
        ) : (
          <span>{art.title}</span>
        )}
      </p>
      {art.summary && <p style={S.articleSummary}>{art.summary}</p>}
      <div style={S.pillRow}>
        {art.source && <span style={S.sourcePill}>{art.source}</span>}
        {art._catLabel && <span style={S.categoryPill}>{art._catLabel}</span>}
      </div>
    </div>
  )
}

function ReportsTab({ appId, token }) {
  const [reports, setReports] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState(null)
  // generating: null = idle, {since: Date, knownDates: Set} when polling.
  const [generating, setGenerating] = useState(null)
  const [statusMsg, setStatusMsg] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const pollRef = useRef(null)

  const refresh = useCallback(async () => {
    const list = await loadAllReports(appId, token)
    setReports(list)
    return list
  }, [appId, token])

  useEffect(() => {
    (async () => {
      const list = await refresh()
      if (list.length > 0 && selectedDate === null) {
        setSelectedDate(list[0].date)
      }
      setLoading(false)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

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
    const knownDates = new Set(reports.map((r) => r.date))
    setGenerating({ since: started, knownDates })
    // Poll every 5s; give up after 90s.
    pollRef.current = setInterval(async () => {
      const elapsed = Date.now() - started
      const list = await loadAllReports(appId, token)
      const fresh = list.find((r) => !knownDates.has(r.date))
      if (fresh) {
        clearInterval(pollRef.current)
        pollRef.current = null
        setReports(list)
        setSelectedDate(fresh.date)
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
  }, [appId, token, reports])

  if (loading) return <div style={S.loading}>Loading reports…</div>

  const selected = reports.find((r) => r.date === selectedDate) || reports[0]
  const articles = flattenArticles(selected)

  return (
    <div>
      <div style={S.topRow}>
        <select
          style={S.datePicker}
          value={selected ? selected.date : ''}
          onChange={(e) => setSelectedDate(e.target.value)}
          disabled={reports.length === 0}
        >
          {reports.length === 0 && <option value="">No reports yet</option>}
          {reports.map((r) => (
            <option key={r.date} value={r.date}>{formatDate(r.date)}</option>
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

      {!selected ? (
        <div style={S.empty}>
          No reports yet. Press “Generate report now” or wait for the next
          scheduled run.
        </div>
      ) : (
        <>
          {selected.summary && (
            <div style={S.reportSummary}>{selected.summary}</div>
          )}
          {articles.length === 0 ? (
            <div style={S.empty}>This report has no articles.</div>
          ) : (
            articles.map((art, i) => (
              <Article key={`${art.url || art.title}-${i}`} art={art} />
            ))
          )}
        </>
      )}
    </div>
  )
}

function SettingsTab({ appId, token }) {
  const [prompt, setPrompt] = useState('')
  const [editing, setEditing] = useState(false)
  const [renderedHtml, setRenderedHtml] = useState('')
  const [hour, setHour] = useState(10)
  const [minute, setMinute] = useState(0)
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES.map((c) => c.key))
  const [useLocalTz, setUseLocalTz] = useState(false)
  const [provider, setProvider] = useState('claude')
  const [loading, setLoading] = useState(true)
  const [promptToast, setPromptToast] = useState('')
  const [scheduleToast, setScheduleToast] = useState('')
  const [agentToast, setAgentToast] = useState('')

  const localTz = useMemo(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' }
    catch { return 'UTC' }
  }, [])

  // Lazy-load marked + render on demand
  const renderMarkdown = useCallback(async (md) => {
    try {
      const mod = await import('https://esm.sh/marked@12')
      const marked = mod.marked || mod.default
      setRenderedHtml(marked.parse(md || ''))
    } catch {
      // Fallback: render plain text in a <pre>
      setRenderedHtml(`<pre>${(md || '').replace(/[<>&]/g, (c) =>
        c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;')}</pre>`)
    }
  }, [])

  useEffect(() => {
    (async () => {
      const [pRes, sRes, aRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/prompt.md`, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token),
      ])
      const p = pRes.ok ? pRes.data : DEFAULT_PROMPT
      setPrompt(p)
      await renderMarkdown(p)
      if (sRes.ok && sRes.data) {
        setHour(sRes.data.hour ?? 10)
        setMinute(sRes.data.minute ?? 0)
        if (Array.isArray(sRes.data.categories)) setCategories(sRes.data.categories)
        setUseLocalTz(!!sRes.data.timezone)
      }
      if (aRes.ok && aRes.data && typeof aRes.data.provider === 'string') {
        if (aRes.data.provider === 'claude' || aRes.data.provider === 'codex') {
          setProvider(aRes.data.provider)
        }
      }
      setLoading(false)
    })()
  }, [appId, token, renderMarkdown])

  const savePrompt = useCallback(async () => {
    await putText(`/api/storage/apps/${appId}/prompt.md`, token, prompt)
    await renderMarkdown(prompt)
    setEditing(false)
    setPromptToast('Saved ✓')
    setTimeout(() => setPromptToast(''), 2000)
  }, [appId, token, prompt, renderMarkdown])

  const resetPrompt = useCallback(async () => {
    setPrompt(DEFAULT_PROMPT)
    await putText(`/api/storage/apps/${appId}/prompt.md`, token, DEFAULT_PROMPT)
    await renderMarkdown(DEFAULT_PROMPT)
    setEditing(false)
    setPromptToast('Reset to default ✓')
    setTimeout(() => setPromptToast(''), 2000)
  }, [appId, token, renderMarkdown])

  const saveSchedule = useCallback(async () => {
    const payload = { hour, minute, categories }
    if (useLocalTz) payload.timezone = localTz
    await putJSON(`/api/storage/apps/${appId}/schedule.json`, token, payload)
    setScheduleToast('Saved ✓')
    setTimeout(() => setScheduleToast(''), 2000)
  }, [appId, token, hour, minute, categories, useLocalTz, localTz])

  const saveAgent = useCallback(async (next) => {
    setProvider(next)
    await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token, { provider: next },
    )
    setAgentToast('Saved ✓')
    setTimeout(() => setAgentToast(''), 2000)
  }, [appId, token])

  const onTimeChange = useCallback((e) => {
    const [h, m] = e.target.value.split(':').map(Number)
    setHour(h); setMinute(m)
  }, [])

  const toggleCategory = useCallback((key) => {
    setCategories((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])
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
        <label style={S.label}>Agent</label>
        <p style={S.note}>
          Which model generates your daily digest. Both work; pick the one
          you have credentials for.
        </p>
        <div style={S.radioRow}>
          {PROVIDERS.map((p) => {
            const on = provider === p.key
            return (
              <div
                key={p.key}
                style={S.radioChip(on)}
                onClick={() => saveAgent(p.key)}
              >
                <input
                  type="radio"
                  checked={on}
                  readOnly
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span>{p.label}</span>
              </div>
            )
          })}
          {agentToast && <span style={S.toast}>{agentToast}</span>}
        </div>
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

        <label style={{ ...S.label, marginTop: '18px' }}>Categories</label>
        <p style={S.note}>Which sections the curator should pull stories from.</p>
        <div style={S.catGrid}>
          {DEFAULT_CATEGORIES.map((c) => {
            const on = categories.includes(c.key)
            return (
              <div
                key={c.key}
                style={S.catChip(on)}
                onClick={() => toggleCategory(c.key)}
              >
                <input
                  type="checkbox"
                  checked={on}
                  readOnly
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span>{c.label}</span>
              </div>
            )
          })}
        </div>

        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveSchedule}>Save schedule</button>
          {scheduleToast && <span style={S.toast}>{scheduleToast}</span>}
        </div>
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Curator prompt</label>
        <p style={S.note}>
          The instructions sent to the AI curator each day. Edit to focus on
          specific topics, adjust tone, or change the output structure.
        </p>

        {editing ? (
          <textarea
            style={S.textarea}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            spellCheck={false}
          />
        ) : (
          // Trusted content: prompt.md is written only by the app owner
          // through the textarea above (single-user PWA, no cross-user input,
          // no untrusted source). marked's output is rendered as-is by design.
          <div
            style={S.promptCard}
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        )}

        <div style={S.btnRow}>
          {editing ? (
            <>
              <button style={S.btn} onClick={savePrompt}>Save</button>
              <button style={S.btnGhost} onClick={() => {
                setEditing(false)
                renderMarkdown(prompt)
              }}>Cancel</button>
            </>
          ) : (
            <button style={S.btn} onClick={() => setEditing(true)}>Edit</button>
          )}
          <button style={S.btnGhost} onClick={resetPrompt}>Reset to default</button>
          {promptToast && <span style={S.toast}>{promptToast}</span>}
        </div>
      </div>
    </div>
  )
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')

  return (
    <div style={S.root}>
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
