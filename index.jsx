import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'

const PROVIDERS = [
  { key: 'claude', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
]

const DEFAULT_TOPICS = `Top stories of the day across world, business, technology, science, sports, and culture. Major events, breaking news, significant developments. Prefer neutral framing; cover multiple viewpoints when stories are divisive.
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

  // Article list
  reportSummary: {
    fontSize: '13px', lineHeight: 1.55, color: 'var(--text)',
    margin: '6px 0 14px', padding: '10px 12px',
    background: 'var(--accent-dim)', borderRadius: '6px',
    borderLeft: '3px solid var(--accent)',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
    whiteSpace: 'pre-wrap', maxWidth: '100%',
  },
  article: {
    marginBottom: '10px', padding: '12px 14px',
    background: 'var(--surface)', borderRadius: '10px',
    border: '1px solid var(--border)',
    maxWidth: '100%', overflow: 'hidden',
  },
  headline: {
    fontSize: '14px', fontWeight: 600, margin: '0 0 6px',
    lineHeight: 1.4,
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  headlineLink: {
    color: 'var(--accent)', textDecoration: 'none',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  articleSummary: {
    fontSize: '12.5px', lineHeight: 1.55, color: 'var(--text)',
    margin: '0 0 8px',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },
  pillRow: { display: 'flex', gap: '6px', flexWrap: 'wrap', maxWidth: '100%' },
  sourcePill: {
    display: 'inline-block', fontSize: '11px', padding: '2px 8px',
    borderRadius: '999px', background: 'var(--bg)',
    border: '1px solid var(--border)', color: 'var(--muted)',
    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  categoryPill: {
    display: 'inline-block', fontSize: '10.5px', padding: '2px 8px',
    borderRadius: '999px', background: 'var(--surface2)',
    border: '1px solid var(--border)', color: 'var(--muted)',
    textTransform: 'uppercase', letterSpacing: '0.4px',
    maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
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
  // Each section's articles → flat list with section context attached.
  // Sections are now agent-chosen (no fixed category list), so we trust
  // whatever `title` it emitted; key is just for stable React identity.
  if (!report || !Array.isArray(report.sections)) return []
  const out = []
  for (const sec of report.sections) {
    const catKey = sec.key || ''
    const catLabel = sec.title || sec.key || ''
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
  const [topics, setTopics] = useState('')
  const [hour, setHour] = useState(10)
  const [minute, setMinute] = useState(0)
  const [useLocalTz, setUseLocalTz] = useState(false)
  const [provider, setProvider] = useState('claude')
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
      const [tRes, sRes, aRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/topics.txt`, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token),
      ])
      setTopics(tRes.ok ? tRes.data : DEFAULT_TOPICS)
      if (sRes.ok && sRes.data) {
        setHour(sRes.data.hour ?? 10)
        setMinute(sRes.data.minute ?? 0)
        setUseLocalTz(!!sRes.data.timezone)
      }
      if (aRes.ok && aRes.data && typeof aRes.data.provider === 'string') {
        if (aRes.data.provider === 'claude' || aRes.data.provider === 'codex') {
          setProvider(aRes.data.provider)
        }
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
        <label style={S.label}>What to search for</label>
        <p style={S.note}>
          Describe what stories you want in your daily digest — topics,
          regions, beats, tone. Plain English; no formatting needed.
        </p>
        <textarea
          style={S.topicsTextarea}
          value={topics}
          onChange={(e) => setTopics(e.target.value)}
          rows={6}
          spellCheck={true}
        />
        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveTopics}>Save</button>
          <button style={S.linkBtn} onClick={resetTopics}>Reset to default</button>
          {topicsToast && <span style={S.toast}>{topicsToast}</span>}
        </div>
      </div>

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
