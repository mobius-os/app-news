import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'

// ===== INLINE-SCHEMA START (canonical source: report-schema.mjs) =====
// The Möbius installer fetches and compiles ONLY the entry file (this
// index.jsx) — a relative `import './report-schema.mjs'` would fail at
// install-time esbuild ("Could not resolve"). So the pure schema helpers
// are inlined here. report-schema.mjs remains the canonical, unit-tested
// copy; __tests__/report-schema.test.mjs asserts this inlined block stays
// in sync. Edit report-schema.mjs, then mirror the change here.
function safeHref(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null
  } catch {
    return null
  }
}
function isReportFilename(name) {
  return typeof name === 'string' && /^\d{4}-\d{2}-\d{2}\.(html|json)$/.test(name)
}
function reportDateFromFilename(name) {
  return isReportFilename(name) ? name.slice(0, 10) : ''
}
function reportExtFromFilename(name) {
  return isReportFilename(name) ? name.slice(-4) === 'html' ? 'html' : 'json' : ''
}
function htmlToText(html) {
  if (typeof html !== 'string') return ''
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
}
function firstMatch(html, re) {
  const m = typeof html === 'string' ? html.match(re) : null
  return m ? htmlToText(m[1]) : ''
}
function normalizeHtmlReport(html, fallbackDate = '') {
  if (typeof html !== 'string') return null
  const article = html.match(/<article\b[\s\S]*?<\/article>/i)
  const body = article ? article[0] : html.trim()
  if (!body) return null
  const attrDate = firstMatch(body, /<article\b[^>]*data-date=["']([^"']+)["'][^>]*>/i)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(attrDate) ? attrDate : fallbackDate
  const summary =
    firstMatch(body, /<details\b[^>]*class=["'][^"']*news-report__summary[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)
    || firstMatch(body, /<p\b[^>]*>([\s\S]*?)<\/p>/i)
    || htmlToText(body).slice(0, 260)
  if (!summary) return null
  const headlines = []
  for (const m of body.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const text = htmlToText(m[1])
    if (text) headlines.push(text)
  }
  return { date, summary, html: body, headlines: headlines.slice(0, 20), sections: [] }
}
function normalizeReport(report, fallbackDate = '') {
  if (!report || typeof report !== 'object') return null
  const summary = typeof report.summary === 'string' ? report.summary.trim() : ''
  if (!summary) return null
  const date = (typeof report.date === 'string' && report.date.trim())
    ? report.date.trim()
    : fallbackDate
  const sections = []
  for (const section of Array.isArray(report.sections) ? report.sections : []) {
    if (!section || typeof section !== 'object') continue
    const title = typeof section.title === 'string' ? section.title.trim() : ''
    const articles = []
    for (const art of Array.isArray(section.articles) ? section.articles : []) {
      if (!art || typeof art !== 'object') continue
      const headline = typeof art.headline === 'string' ? art.headline.trim() : ''
      const artSummary = typeof art.summary === 'string' ? art.summary.trim() : ''
      if (!headline || !artSummary) continue
      const clean = { headline, summary: artSummary }
      const href = safeHref(art.source_url)
      if (href) clean.source_url = href
      articles.push(clean)
    }
    if (articles.length) sections.push({ title, articles })
  }
  return { date, summary, sections }
}
function buildFeedbackRecord(report, feedback = {}, now = new Date()) {
  const text = typeof feedback.text === 'string' ? feedback.text.trim() : ''
  const signal = typeof feedback.signal === 'string' && feedback.signal.trim()
    ? feedback.signal.trim()
    : 'note'
  const createdAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString()
  return {
    app: 'news',
    kind: 'digest_feedback',
    report_date: typeof report?.date === 'string' ? report.date : '',
    signal,
    text,
    created_at: createdAt,
    report_summary: typeof report?.summary === 'string' ? report.summary.slice(0, 500) : '',
    article_headlines: Array.isArray(report?.headlines)
      ? report.headlines.slice(0, 20)
      : (report?.sections || [])
        .flatMap(section => section?.articles || [])
        .map(article => (typeof article?.headline === 'string' ? article.headline.trim() : ''))
        .filter(Boolean)
        .slice(0, 20),
  }
}
// ===== INLINE-SCHEMA END =====

// New reports are agent-authored HTML fragments, rendered in a sandboxed
// iframe after a small client-side sanitizer removes scripts, event attrs,
// and non-http(s) links. Older JSON reports still render through the legacy
// React card path so historical digests do not disappear.

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

const DEFAULT_SCHEDULE = { hour: 10, minute: 0 }

function buildCron(hour, minute = 0) {
  return `${minute} ${hour} * * *`
}

function parseSchedule(data) {
  if (!data || typeof data !== 'object') return DEFAULT_SCHEDULE
  if (typeof data.cron === 'string') {
    const parts = data.cron.trim().split(/\s+/)
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      const minute = Number(parts[0])
      const hour = Number(parts[1])
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute }
      }
    }
  }
  const hour = Number(data.hour)
  const minute = Number(data.minute || 0)
  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute }
  return DEFAULT_SCHEDULE
}

function timeValue(schedule) {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
}

// Default editorial brief. Kept in sync with the bundled `topics.txt`
// so "Reset to default" writes the same text the installer seeded.
// Multi-paragraph by design: this is an editorial brief, not a search
// query — the user is expected to rewrite it in their own voice.
const LEGACY_DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The
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

const DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The text below is what the curator reads each morning to decide what to write and how. Be opinionated; the more specific you are, the better the report.

Coverage: I want a broad picture of the day across world news, business and markets, technology, science, sports, and culture. Lean into the stories that actually moved the needle in the last 24 hours rather than evergreen think-pieces.

Sources & framing: stick to reputable primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, and similar). Keep framing neutral and surface multiple viewpoints when a story is divisive — no editorialising, no speculation.

Voice: write it as one flowing morning briefing, like a journalist would — conversational but substantive. Weave the citations into the prose. If a story is unfamiliar or has been building over several days, drop in a short "what this is about" sentence so I'm not lost.

What to downweight: celebrity gossip, lifestyle filler, and press-release-shaped tech announcements with no real news behind them. Skip them unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

function normalizeSeededTopics(text) {
  return String(text || '').trim() === LEGACY_DEFAULT_TOPICS.trim()
    ? DEFAULT_TOPICS
    : text
}

const S = {
  root: {
    height: '100%', display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', color: 'var(--text)',
    fontFamily: 'var(--font)',
    // The whole app pins to the viewport — no body-level horizontal scroll.
    maxWidth: '100%', overflowX: 'hidden', position: 'relative',
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

  // Reading column for the report feed. We centre a comfortable width so
  // long summaries don't stretch edge-to-edge on web; on mobile it just
  // fills the viewport.
  reportContainer: {
    maxWidth: '640px', margin: '0 auto',
    wordBreak: 'break-word', overflowWrap: 'anywhere',
  },

  // ---- Report card (tap-to-expand accordion) ----
  card: { marginBottom: '12px' },
  // Header is a real <button> so it's keyboard- and screen-reader-
  // operable. minHeight 44px keeps it above the mobile touch floor.
  cardHeader: (expanded) => ({
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    width: '100%', textAlign: 'left', gap: '12px',
    minHeight: '44px', padding: '12px 16px',
    cursor: 'pointer', userSelect: 'none',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: expanded ? '10px 10px 0 0' : '10px',
    transition: 'border-radius 0.15s',
  }),
  cardDate: {
    display: 'block',
    fontSize: '17px', fontWeight: 700, letterSpacing: '-0.2px',
    color: 'var(--accent)',
  },
  cardPreview: {
    marginTop: '6px',
    fontSize: '12.5px', lineHeight: 1.5, color: 'var(--muted)',
    // Clamp the collapsed preview to two lines so the list stays tidy.
    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
  },
  chevron: (expanded) => ({
    flexShrink: 0, fontSize: '14px', color: 'var(--muted)',
    transition: 'transform 0.2s',
    transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
  }),
  cardBody: {
    border: '1px solid var(--border)', borderTop: 'none',
    borderRadius: '0 0 10px 10px', padding: '4px 18px 16px',
    background: 'var(--surface)',
  },
  // "Today at a glance" tl;dr strip — accent-tinted, the report's lede.
  glance: {
    fontSize: '14px', lineHeight: 1.6, color: 'var(--text)',
    margin: '14px 0 16px', padding: '12px 14px',
    background: 'var(--accent-dim)', borderRadius: '8px',
    borderLeft: '3px solid var(--accent)',
  },
  sectionGap: { marginTop: '10px' },
  sectionTitle: {
    display: 'inline-block',
    fontSize: '15px', fontWeight: 700, color: 'var(--text)',
    margin: '18px 0 10px', paddingBottom: '5px',
    borderBottom: '2px solid var(--accent)',
  },
  article: {
    marginBottom: '14px', paddingLeft: '12px',
    borderLeft: '3px solid var(--border-light, var(--border))',
  },
  headline: {
    fontSize: '14px', fontWeight: 600, lineHeight: 1.4, margin: '0 0 4px',
  },
  headlineLink: { color: 'var(--accent)', textDecoration: 'none' },
  articleSummary: {
    fontSize: '13px', lineHeight: 1.55, color: 'var(--muted)', margin: 0,
  },
  cardEmpty: {
    fontSize: '13px', lineHeight: 1.5, color: 'var(--muted)', margin: '6px 0 0',
  },
  htmlFrame: {
    width: '100%', height: '680px',
    border: '1px solid var(--border)', borderRadius: '10px',
    background: 'var(--bg)', display: 'block',
  },
  reader: {
    position: 'absolute', inset: 0, zIndex: 5,
    display: 'flex', flexDirection: 'column',
    background: 'var(--bg)', color: 'var(--text)',
  },
  readerBar: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '11px 14px', borderBottom: '1px solid var(--border)',
    background: 'var(--surface)', flexShrink: 0,
  },
  readerBack: {
    padding: '7px 12px', borderRadius: '9px',
    border: '1px solid var(--border)', background: 'var(--bg)',
    color: 'var(--text)', fontSize: '13px', fontWeight: 650,
    cursor: 'pointer', fontFamily: 'var(--font)',
  },
  readerTitle: {
    flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 750,
    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  },
  readerBody: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' },
  readerFrame: {
    width: '100%', minHeight: '100%', border: 0, background: 'var(--bg)',
    display: 'block',
  },
  readerFooter: {
    padding: '12px 14px', borderTop: '1px solid var(--border)',
    background: 'var(--surface)', flexShrink: 0,
  },
  feedList: { maxWidth: '760px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '8px' },
  feedItem: {
    width: '100%', textAlign: 'left', padding: '13px 15px',
    borderRadius: '10px', border: '1px solid var(--border)',
    background: 'var(--surface)', color: 'var(--text)',
    cursor: 'pointer', fontFamily: 'var(--font)',
  },
  feedDate: { fontSize: '14px', fontWeight: 750, color: 'var(--accent)', marginBottom: '5px' },
  feedSummary: { fontSize: '13px', lineHeight: 1.45, color: 'var(--muted)' },
  // Per-card body states (lazy load on first expand).
  cardBodyLoading: {
    fontSize: '12.5px', color: 'var(--muted)', padding: '14px 2px 6px',
  },
  cardBodyError: {
    fontSize: '12.5px', color: 'var(--muted)', padding: '14px 2px 6px',
    lineHeight: 1.5,
  },
  // Feedback affordance — opens the main chat with a concise draft.
  askRow: {
    marginTop: '18px', paddingTop: '14px',
    borderTop: '1px solid var(--border)',
  },
  askBtn: {
    display: 'inline-flex', alignItems: 'center', gap: '8px',
    padding: '8px 14px', borderRadius: '10px',
    border: '1px solid var(--accent)',
    background: 'var(--accent-dim)', color: 'var(--accent)',
    fontSize: '13px', fontWeight: 600, cursor: 'pointer',
  },
  askHint: {
    fontSize: '11.5px', color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.5,
  },
  feedbackBox: {
    marginTop: '18px', paddingTop: '14px',
    borderTop: '1px solid var(--border)',
  },
  // The mount the nested chat iframe is appended into. Fixed comfortable
  // height — ChatView owns its own scroll, so we give it a panel, not a
  // grow-to-content box.
  chatMount: {
    marginTop: '12px', width: '100%', height: '460px',
    border: '1px solid var(--border)', borderRadius: '10px',
    overflow: 'hidden', background: 'var(--bg)',
  },
  chatResolving: {
    display: 'flex', alignItems: 'center', gap: '8px', marginTop: '12px',
    color: 'var(--muted)', fontSize: '12.5px',
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
  errorToast: { fontSize: '12px', color: 'var(--danger, #ef4444)' },
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
  // Agent / Model section — compact optgroup picker. The backend
  // already filters hidden model prefs, matching the chat picker list.
  modelList: {
    display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '6px',
  },
  modelSelect: {
    width: '100%', minHeight: '42px', padding: '9px 12px',
    border: '1px solid var(--border)', borderRadius: '10px',
    background: 'var(--surface)', color: 'var(--text)',
    fontSize: '13.5px', fontFamily: 'var(--font)', fontWeight: 600,
    outline: 'none',
  },
  modelMeta: {
    marginTop: '8px', fontSize: '12px', color: 'var(--muted)',
    lineHeight: 1.5,
  },
  modelButton: {
    width: '100%', minHeight: '46px', padding: '9px 12px',
    border: '1px solid var(--border)', borderRadius: '10px',
    background: 'var(--surface)', color: 'var(--text)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '12px', cursor: 'pointer', fontFamily: 'var(--font)', textAlign: 'left',
  },
  pickerBackdrop: {
    position: 'fixed', inset: 0, zIndex: 20,
    background: 'rgba(0,0,0,0.35)', display: 'flex',
    alignItems: 'flex-end', justifyContent: 'center', padding: '16px',
  },
  pickerSheet: {
    width: 'min(560px, 100%)', maxHeight: '72vh', overflowY: 'auto',
    background: 'var(--bg)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: '14px',
    boxShadow: '0 18px 60px rgba(0,0,0,0.38)', padding: '14px',
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

// normalizeReport + safeHref live in ./report-schema.js (pure, React-
// free) so they can be unit-tested without a JSX/React loader. They're
// the single source of truth for the shape the renderer below trusts.

// ----------------------------------------------------------------------
// Storage helpers — route through the Möbius offline runtime when it's
// loaded, fall back to direct fetch otherwise.
//
// The runtime (window.mobius.storage) queues writes in IndexedDB while
// offline and drains them on reconnect. Without it, a save in the
// Settings tab while offline silently throws and the user thinks the
// change persisted. Probing on every call (rather than caching at
// module load) matches what atlas/gym/dreaming/latex do — the
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
// .html/.json reports newest-first as {date, ext, mtime}. HTML is the
// preferred format; JSON is kept for older digests already on disk. mtime is the
// listing's modified_at — used to detect a SAME-DAY regeneration:
// fetch.sh overwrites reports/<today>.html, so no new filename appears;
// completion shows up as today's modified_at advancing. The body for a
// picked date is fetched lazily by loadReportBody. Returns null on
// network failure so the caller falls back to its cached snapshot; []
// means "listed fine, no reports yet".
async function loadReportEntries(appId, token) {
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
      if (!r.ok) return null
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
      if (cursor && cursor === prevCursor) return null
      if (!cursor) break
    }
  } catch {
    return null
  }
  const byDate = new Map()
  for (const entry of out) {
    const prev = byDate.get(entry.date)
    if (!prev || (entry.ext === 'html' && prev.ext !== 'html')) byDate.set(entry.date, entry)
  }
  // Newest first (ISO date names sort lexicographically = chronologically).
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// Fetch one day's report and normalize it to the render shape. New reports
// are raw HTML fragments on .html storage paths. Legacy reports are bare JSON
// objects on .json paths.
async function loadReportBody(appId, token, entryOrDate) {
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
  const res = await getText(`/api/storage/apps/${appId}/reports/${dateStr}.html`, token)
  return res.ok ? normalizeHtmlReport(res.data, dateStr) : null
}

async function loadReportMeta(appId, token, dateStr) {
  const res = await getJSON(
    `/api/storage/apps/${appId}/reports/${dateStr}.meta.json`,
    token,
    appId,
  )
  if (!res.ok || !res.data) return { chatId: null }
  const id = res.data.chat_id ?? res.data.chatId ?? res.data.report_chat
  return { chatId: typeof id === 'string' && id.trim() ? id.trim() : null }
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
const RECENT_REPORT_LIMIT = 7
// v3: reports are normalized OBJECTS again, but may carry an html body.
// Bump from v2 so old JSON-only cached entries don't mask fresh HTML files.
const CACHE_VERSION = 3

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
    // (each report is a few KB of JSON). The dates array can stay
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

function FeedbackLauncher({ report, chatId }) {
  const openFeedbackChat = () => {
    const draft = buildFeedbackDraft(report)
    window.parent.postMessage(
      chatId
        ? { type: 'moebius:open-chat', chatId, draft }
        : { type: 'moebius:new-chat', draft },
      window.location.origin,
    )
  }
  return (
    <div style={S.feedbackBox}>
      <button type="button" style={S.askBtn} onClick={openFeedbackChat}>
        Give feedback on this digest
      </button>
    </div>
  )
}

function buildFeedbackDraft(report) {
  return [
    `Feedback on the News digest for ${report.date}:`,
    '',
    'My feedback:',
  ].join('\n')
}

function sanitizeReportHtml(html) {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return ''
  const parser = new DOMParser()
  const doc = parser.parseFromString(`<main>${html || ''}</main>`, 'text/html')
  const root = doc.body.querySelector('main')
  if (!root) return ''
  const allowed = new Set([
    'ARTICLE', 'DETAILS', 'SUMMARY', 'SECTION', 'P', 'H2', 'H3', 'H4',
    'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'STRONG', 'EM', 'B', 'I',
    'SPAN', 'TIME', 'BR', 'DIV', 'FIGURE', 'FIGCAPTION', 'TABLE',
    'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'SVG', 'G', 'PATH', 'CIRCLE',
    'RECT', 'LINE', 'POLYLINE', 'TEXT',
  ])
  const walk = (node) => {
    for (const child of [...node.children]) {
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE') {
        child.remove()
        continue
      }
      if (!allowed.has(child.tagName)) {
        child.replaceWith(...child.childNodes)
        walk(node)
        return
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on') || name === 'style') child.removeAttribute(attr.name)
      }
      if (child.tagName === 'A') {
        const href = safeHref(child.getAttribute('href'))
        if (href) {
          child.setAttribute('href', href)
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noopener noreferrer')
        } else {
          child.removeAttribute('href')
          child.removeAttribute('target')
          child.removeAttribute('rel')
        }
      } else {
        for (const attr of [...child.attributes]) {
          if (!['class', 'data-date', 'open', 'viewbox', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'x', 'y', 'cx', 'cy', 'r', 'd', 'points', 'role', 'aria-label'].includes(attr.name.toLowerCase())) {
            child.removeAttribute(attr.name)
          }
        }
      }
      walk(child)
    }
  }
  walk(root)
  return root.innerHTML
}

// Read the active theme tokens off the host document so the iframe'd
// report follows light AND dark mode instead of being a hardcoded dark
// slab. Each token falls back to a sane dark default if the host hasn't
// defined it (or we're rendering outside a browser), preserving the
// original look when no theme is available.
function readReportTheme() {
  const fallback = {
    bg: '#0c0f14', surface: 'rgba(255,255,255,.045)', text: '#e4e4e7',
    muted: '#a1a1aa', border: 'rgba(255,255,255,.12)', accent: '#a78bfa',
  }
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback
  }
  try {
    const cs = getComputedStyle(document.documentElement)
    const pick = (name, dflt) => {
      const v = cs.getPropertyValue(name).trim()
      return v || dflt
    }
    return {
      bg: pick('--bg', fallback.bg),
      surface: pick('--surface', fallback.surface),
      text: pick('--text', fallback.text),
      muted: pick('--muted', fallback.muted),
      border: pick('--border', fallback.border),
      accent: pick('--accent', fallback.accent),
    }
  } catch {
    return fallback
  }
}

function buildHtmlSrcDoc(report) {
  const safe = sanitizeReportHtml(report.html)
  const t = readReportTheme()
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root {
    --bg: ${t.bg};
    --surface: ${t.surface};
    --text: ${t.text};
    --muted: ${t.muted};
    --border: ${t.border};
    --accent: ${t.accent};
  }
  body {
    margin: 0;
    padding: clamp(18px, 4vw, 46px);
    background: var(--bg);
    color: var(--text);
    font: 16px/1.68 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  article { max-width: 860px; margin: 0 auto; }
  .news-report__body > p:first-child {
    font-size: clamp(20px, 4vw, 30px);
    line-height: 1.22;
    font-weight: 760;
    letter-spacing: 0;
    color: var(--text);
    margin-bottom: 24px;
  }
  details.news-report__summary {
    margin: 0 0 22px;
    padding: 14px 16px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    background: var(--surface);
  }
  details.news-report__summary summary {
    cursor: default;
    color: var(--accent);
    font-weight: 750;
    margin-bottom: 8px;
  }
  h2 {
    margin: 26px 0 10px;
    color: var(--text);
    font-size: 20px;
    line-height: 1.25;
  }
  h3 { margin: 20px 0 8px; color: var(--text); font-size: 16px; }
  p { margin: 0 0 14px; }
  a { color: var(--accent); text-decoration-thickness: .08em; text-underline-offset: .18em; }
  blockquote {
    margin: 18px 0;
    padding: 12px 16px;
    border-left: 3px solid var(--border);
    background: var(--surface);
    color: var(--muted);
  }
  figure, .callout {
    margin: 22px 0;
    padding: 14px 16px;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--surface);
  }
  figcaption { margin-top: 8px; color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
  th, td { border-bottom: 1px solid var(--border); padding: 9px 8px; text-align: left; vertical-align: top; }
  th { color: var(--text); font-weight: 750; }
  svg { max-width: 100%; height: auto; display: block; margin: 8px auto; }
  ul, ol { padding-left: 22px; }
  li { margin: 7px 0; }
</style>
</head>
<body>${safe}</body>
</html>`
}

function ReportReader({ entry, appId, token, cachedReport, onBodyLoaded, onBack }) {
  const [report, setReport] = useState(cachedReport || null)
  const [chatId, setChatId] = useState(null)
  const [phase, setPhase] = useState(cachedReport ? 'ready' : 'loading')

  useEffect(() => {
    let cancelled = false
    setChatId(null)
    setReport(cachedReport || null)
    setPhase(cachedReport ? 'ready' : 'loading')
    ;(async () => {
      const body = await loadReportBody(appId, token, entry)
      if (cancelled) return
      if (body) {
        setReport(body)
        setPhase('ready')
        onBodyLoaded?.(entry.date, body)
      } else if (!cachedReport) {
        setPhase('error')
      }
    })()
    ;(async () => {
      const meta = await loadReportMeta(appId, token, entry.date)
      if (!cancelled) setChatId(meta.chatId)
    })()
    return () => { cancelled = true }
  }, [appId, token, entry.date, entry.ext, cachedReport, onBodyLoaded])

  return (
    <div style={S.reader}>
      <div style={S.readerBar}>
        <button type="button" style={S.readerBack} onClick={onBack}>← Back</button>
        <div style={S.readerTitle}>{formatDate(entry.date)}</div>
      </div>
      <div style={S.readerBody}>
        {phase === 'loading' && <div style={S.loading}>Loading report…</div>}
        {phase === 'error' && <div style={S.empty}>This report could not be loaded.</div>}
        {report && report.html && (
          <iframe
            title={`News digest for ${report.date}`}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            srcDoc={buildHtmlSrcDoc(report)}
            style={S.readerFrame}
          />
        )}
        {report && !report.html && (
          <div style={{ ...S.reportContainer, padding: '20px' }}>
            {report.summary && <div style={S.glance}>{report.summary}</div>}
            {(report.sections || []).map((section, si) => (
              <div key={si}>
                {section.title && <div style={S.sectionTitle}>{section.title}</div>}
                {(section.articles || []).map((art, ai) => (
                  <div key={ai} style={S.article}>
                    <p style={S.headline}>{art.headline}</p>
                    <p style={S.articleSummary}>{art.summary}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      {report && (
        <div style={S.readerFooter}>
          <FeedbackLauncher report={report} chatId={chatId} />
        </div>
      )}
    </div>
  )
}

function ReportsTab({ appId, token, online }) {
  const [entries, setEntries] = useState([])
  const [cachedReports, setCachedReports] = useState(() => {
    const c = readCache(appId)
    return c ? c.reports : {}
  })
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
      if (listed === null) {
        const cache = readCache(appId)
        setEntries((cache?.dates || []).map((d) => ({
          date: d,
          ext: cache?.reports?.[d]?.html ? 'html' : 'json',
          mtime: '',
        })))
      } else {
        setEntries(listed)
      }
      setLoading(false)
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
        if (cancelled || cachedReports[entry.date]) continue
        const body = await loadReportBody(appId, token, entry)
        if (cancelled) return
        if (body) cacheBody(entry.date, body)
      }
    })()
    return () => { cancelled = true }
  }, [entries, cachedReports, appId, token, cacheBody])

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
        return
      }
      started = Date.now()
    } catch (e) {
      setStatusMsg('')
      setErrorMsg('Could not reach the server.')
      generatingRef.current = false
      return
    }
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

  if (loading) return <div style={S.loading}>Loading reports…</div>

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

      {entries.length === 0 ? (
        <div style={S.empty}>
          Your first digest will land here after the next scheduled run.
          Press “Generate report now” to start one immediately.
        </div>
      ) : (
        <div style={S.feedList}>
          {entries.map((entry) => (
            <button
              key={`${entry.date}:${entry.mtime || ''}`}
              type="button"
              style={S.feedItem}
              onClick={() => openDetail(entry)}
            >
              <div style={S.feedDate}>{formatDate(entry.date)}</div>
              <div style={S.feedSummary}>
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
  return groups
}

function ModelPicker({
  provider, model, groups, connectedProviders, onChange,
}) {
  const [open, setOpen] = useState(false)
  const activeGroup = groups?.find((g) => g.key === provider)
  const activeModel = activeGroup?.models.find((m) => m.id === model)
  const label = activeModel
    ? `${activeGroup.label} · ${activeModel.name}`
    : model || 'Choose model'

  return (
    <>
      <button type="button" style={S.modelButton} onClick={() => setOpen(true)}>
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: '13.5px', fontWeight: 750 }}>{label}</span>
          <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--muted)', marginTop: '2px' }}>
            {model}
          </span>
        </span>
        <span aria-hidden="true" style={{ color: 'var(--muted)' }}>▾</span>
      </button>
      {open && (
        <div style={S.pickerBackdrop} onClick={() => setOpen(false)}>
          <div style={S.pickerSheet} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '12px', gap: '10px' }}>
              <div style={{ flex: 1, fontSize: '14px', fontWeight: 800 }}>Model</div>
              <button type="button" style={S.linkBtn} onClick={() => setOpen(false)}>Close</button>
            </div>
            {!groups || groups.length === 0 ? (
              <div style={S.note}>No visible models. Adjust model visibility from chat settings.</div>
            ) : groups.map((group) => {
              const connected = !connectedProviders || connectedProviders.has(group.key)
              return (
                <div key={group.key} style={S.modelGroup}>
                  <div style={S.modelGroupHeader}>
                    <span>{group.label}</span>
                    {!connected && <span style={S.modelGroupHint}>not connected</span>}
                  </div>
                  {group.models.map((m) => {
                    const on = provider === group.key && model === m.id
                    const disabled = !connected && !on
                    return (
                      <button
                        key={`${group.key}-${m.id}`}
                        type="button"
                        style={{ ...S.modelRow(on, disabled), width: '100%', textAlign: 'left' }}
                        disabled={disabled}
                        onClick={() => {
                          onChange(group.key, m.id)
                          setOpen(false)
                        }}
                      >
                        <div style={S.modelRowMain}>
                          <span style={S.modelRowTitle}>{m.name}</span>
                          <span style={S.modelRowSub}>{m.id}</span>
                        </div>
                        {on && <span aria-hidden="true">✓</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
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
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE)
  const [loading, setLoading] = useState(true)
  const [topicsToast, setTopicsToast] = useState('')
  const [agentToast, setAgentToast] = useState('')
  const [scheduleToast, setScheduleToast] = useState('')
  const [scheduleError, setScheduleError] = useState('')
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

  useEffect(() => {
    (async () => {
      const [tRes, aRes, pRes, mRes, sRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/topics.txt`, token),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token, appId),
        getJSON(`/api/auth/providers/status`, token),
        getJSON(`/api/auth/providers/models`, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token, appId),
      ])
      setTopics(tRes.ok ? normalizeSeededTopics(tRes.data) : DEFAULT_TOPICS)
      setSchedule(sRes.ok ? parseSchedule(sRes.data) : DEFAULT_SCHEDULE)
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
        if (chosen) {
          setProvider(chosen.key)
          setModel(chosen.models[0].id)
        }
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

  const onScheduleChange = useCallback((e) => {
    const [h, m] = e.target.value.split(':').map(Number)
    if (Number.isFinite(h) && Number.isFinite(m)) {
      setSchedule({ hour: h, minute: m })
      setScheduleToast('')
      setScheduleError('')
    }
  }, [])

  const saveSchedule = useCallback(async () => {
    setScheduleToast('')
    setScheduleError('')
    const cron = buildCron(schedule.hour, schedule.minute)
    try {
      await putJSON(
        `/api/storage/apps/${appId}/schedule.json`,
        token,
        { ...schedule, cron },
        appId,
      )
      const r = await fetch(`/api/apps/${appId}/schedule`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cron, job: 'fetch.sh' }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setScheduleToast('Schedule saved ✓')
      setTimeout(() => setScheduleToast(''), 2600)
    } catch (e) {
      setScheduleError(online ? 'Could not update cron.' : 'You’re offline — reconnect to save.')
    }
  }, [appId, token, schedule, online])

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
          Tell the agent what you want in your daily digest — topics,
          regions, beats, sources, framing, voice. Plain English; the
          output formatting is handled separately.
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
        <div style={S.btnRow}>
          <button style={S.btn} onClick={saveTopics}>Save</button>
          <button style={S.linkBtn} onClick={resetTopics}>Reset to default</button>
          {topicsToast && <span style={S.toast}>{topicsToast}</span>}
        </div>
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Agent / Model</label>
        <p style={S.note}>
          Which model generates your daily digest. The list follows your
          chat model visibility settings.
        </p>
        {providerGroups === null ? (
          <div style={S.note}>Loading models…</div>
        ) : (
          <>
            <ModelPicker
              provider={provider}
              model={model}
              groups={providerGroups}
              connectedProviders={connectedProviders}
              onChange={saveAgent}
            />
            <div style={S.modelMeta}>
              {providerGroups.find((group) => group.key === provider)?.label || provider}
              {' · '}
              {model}
            </div>
          </>
        )}
        {agentToast && (
          <div style={{ ...S.btnRow, marginTop: '8px' }}>
            <span style={S.toast}>{agentToast}</span>
          </div>
        )}
      </div>

      <div style={S.settingsSection}>
        <label style={S.label}>Schedule</label>
        <p style={S.note}>
          Pick when the digest job should run each day.
        </p>
        <div style={S.btnRow}>
          <input
            type="time"
            value={timeValue(schedule)}
            onChange={onScheduleChange}
            style={{ ...S.modelSelect, width: '150px' }}
            aria-label="Daily digest time"
          />
          <button style={S.btnSecondary} onClick={saveSchedule}>Save schedule</button>
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
          {scheduleError && <span style={S.errorToast}>{scheduleError}</span>}
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
