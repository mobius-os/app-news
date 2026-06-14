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

// Images are held to a stricter bar than links: https only. The digest
// is curated content, so a mixed-content (http) or unparseable image
// url is dropped rather than rendered as a broken box.
function safeImgSrc(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'https:' ? parsed.href : null
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
  for (const m of body.matchAll(/<h[123]\b[^>]*>([\s\S]*?)<\/h[123]>/gi)) {
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

// CSP injected into every report's <head>. Locks down the null-origin
// srcdoc context: no external fetches, no same-origin storage access,
// only inline scripts (needed for the height-reporter below).
const NEWS_REPORT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src https: data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

// Injected into every report's <head>. Reports scrollHeight to the parent
// via postMessage so the parent can size the iframe to content height without
// needing allow-same-origin (which would give the iframe the shell origin and
// its owner JWT). The sandbox is allow-scripts WITHOUT allow-same-origin, so
// the iframe has a null origin and cannot reach the parent's DOM or storage.
// Measurement: documentElement.getBoundingClientRect().height is the html
// element's border-box height, which tracks content (body has margin:0 in
// the srcdoc CSS). Unlike scrollHeight it is NOT floored at the iframe's
// own viewport height, so a transient over-measurement taken mid-reflow
// (e.g. classic scrollbars appearing shrink the layout width and re-wrap
// text taller for a frame) shrinks back on the next emit instead of
// ratcheting the iframe height up forever.
const NEWS_REPORT_HEIGHT_SCRIPT = `<script>
(function(){
  function emit(){
    var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
    if(h>0)parent.postMessage({type:'news:report-height',height:h},'*');
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',emit);
  } else { emit(); }
  if(typeof ResizeObserver!=='undefined'){
    var ro=new ResizeObserver(emit);
    ro.observe(document.documentElement);
  } else {
    window.addEventListener('resize',emit);
  }
})();
</script>`

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

// The very first default the installer ever seeded (hard-wrapped). Kept
// verbatim only so a never-edited install carrying this exact text gets
// upgraded to the current DEFAULT_TOPICS by normalizeSeededTopics. The
// canonical default the app seeds and "Reset to default" writes is
// DEFAULT_TOPICS below, kept in sync with the bundled `topics.txt`.
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

const DEFAULT_TOPICS = `Coverage: give me a broad read on the day — world news, business and markets, tech, science, sports, culture. Chase what actually moved in the last 24 hours, not evergreen think-pieces.

Sources: lean on reputable primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, and the like). Keep it neutral, and when a story is divisive show both sides — no editorialising or speculation.

Voice: one flowing morning briefing, the way a journalist would write it — conversational but substantive, with the sources woven into the prose. If a story is unfamiliar or has been building for days, drop in a quick line on what it's about so I'm not lost.

Downweight: celebrity gossip, lifestyle filler, and press-release tech announcements with nothing real behind them. Skip unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

// The default that shipped before the brief was shortened (1.10.19 and
// earlier): same un-wrapped paragraphs but with the "This is your
// editorial brief …" preamble that now lives as fixed helper text above
// the textarea. Kept verbatim so a never-edited install upgrades to the
// new default instead of carrying the stale preamble inside the brief.
const PRE_SHORTENED_DEFAULT_TOPICS = `This is your editorial brief — edit it to make the digest yours. The text below is what the curator reads each morning to decide what to write and how. Be opinionated; the more specific you are, the better the report.

Coverage: I want a broad picture of the day across world news, business and markets, technology, science, sports, and culture. Lean into the stories that actually moved the needle in the last 24 hours rather than evergreen think-pieces.

Sources & framing: stick to reputable primary publishers (Reuters, AP, BBC, FT, Bloomberg, Nature, Ars Technica, The Verge, ESPN, NYT Arts, and similar). Keep framing neutral and surface multiple viewpoints when a story is divisive — no editorialising, no speculation.

Voice: write it as one flowing morning briefing, like a journalist would — conversational but substantive. Weave the citations into the prose. If a story is unfamiliar or has been building over several days, drop in a short "what this is about" sentence so I'm not lost.

What to downweight: celebrity gossip, lifestyle filler, and press-release-shaped tech announcements with no real news behind them. Skip them unless they're genuinely newsworthy.

Tell me what changed today, what it means, and what to watch next.
`

// Every default the app has ever seeded. A stored brief matching any of
// them means the user never edited it, so we upgrade it to the current
// DEFAULT_TOPICS rather than leaving stale seed text in their editor.
const PRIOR_DEFAULT_TOPICS = [LEGACY_DEFAULT_TOPICS, PRE_SHORTENED_DEFAULT_TOPICS]

function normalizeSeededTopics(text) {
  const trimmed = String(text || '').trim()
  return PRIOR_DEFAULT_TOPICS.some((d) => trimmed === d.trim())
    ? DEFAULT_TOPICS
    : text
}

// One stylesheet, rendered once at the app root as <style>{CSS}</style>.
// Class prefix `nw-`. State-style helpers that used to return inline
// objects (tab, generateBtn, modelRow, cardHeader) are now modifier
// classes; only render-time dynamic values stay inline. The nested
// report iframe builds its OWN themed HTML via buildHtmlSrcDoc/
// readReportTheme — that srcdoc CSS is untouched by this stylesheet.
const CSS = `
/* mobius-ui:Root v1 — keep in sync; library candidate. Diverge below the marker only. */
.nw-root {
  position: relative;        /* anchor for scrims / sheets / readers (they're absolute, not fixed) */
  display: flex; flex-direction: column;
  height: 100%; width: 100%; max-width: 100%;
  overflow: hidden;          /* the whole app pins to the viewport — no body-level horizontal scroll */
  background: var(--bg); color: var(--text); font-family: var(--font);
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
.nw-scroll {
  flex: 1; min-height: 0;    /* the flexbox-overflow fix — REQUIRED so children scroll */
  overflow-y: auto; overflow-x: hidden;
  word-break: break-word; overflow-wrap: anywhere;  /* belt-and-braces for descendants that didn't opt in */
  overscroll-behavior: contain;
}
/* /mobius-ui:Root */
/* App-specific: News uses a wider horizontal pad than the canonical 16px. */
.nw-scroll { padding: 14px 20px 32px; }

/* mobius-ui:Focus v1 -- shared keyboard focus ring (WCAG 2.4.7); never bare outline:none */
:where(button,a,input,textarea,select,summary,[role="button"],[tabindex]:not([tabindex="-1"])):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
/* /mobius-ui:Focus */

/* App header — title + tab cluster (diverges from the canonical brand Header). */
.nw-header {
  /* Top-pinned header: clear the notch / status bar on a full-bleed phone. */
  padding: max(18px, env(safe-area-inset-top)) 20px 0;
  display: flex; align-items: center;
  justify-content: space-between; flex-shrink: 0; gap: 12px;
}
/* Brand row: glossy app icon + the one app-name text label in the catalog.
   The icon and "News" wordmark share a vertically-centered flex row. */
.nw-brand {
  display: flex; align-items: center; gap: 9px; min-width: 0; flex-shrink: 0;
}
.nw-brand-icon {
  width: 34px; height: 34px; border-radius: 8px;
  object-fit: cover; flex-shrink: 0; display: block; user-select: none;
}
.nw-brand-fallback {
  width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0;
  align-items: center; justify-content: center;
  color: var(--accent); font-size: 28px; font-weight: 700; line-height: 1;
  background: var(--accent-dim); user-select: none;
}
.nw-title {
  font-size: 19px; font-weight: 700; line-height: 1;
  color: var(--text); letter-spacing: -0.01em; user-select: none;
}
.nw-divider { height: 1px; background: var(--border); margin: 14px 20px 0; }

/* mobius-ui:Segmented v1 — keep in sync; library candidate. News uses the
   is-accent modifier (accent-fill active) and holds its own exact values;
   diverge below the marker only. */
.nw-tabs {
  display: flex; gap: 2px; padding: 3px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
}
.nw-tab {
  min-height: 44px; padding: 6px 14px; border: none; border-radius: 6px;
  background: transparent; color: var(--muted); font-family: var(--font);
  font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s;
  touch-action: manipulation; user-select: none;
}
.nw-tab.is-active { background: var(--accent); color: #fff; }
@media (hover: hover) {
  .nw-tab:not(.is-active):hover { color: var(--text); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-tab:active { opacity: 0.75; }
}
/* /mobius-ui:Segmented */

/* Reports — top control row */
.nw-top-row {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 14px; flex-wrap: wrap;
}
/* Generate-report button — accent fill, surface/muted while busy (disabled). */
.nw-generate-btn {
  padding: 7px 14px; border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--accent); color: #fff;
  cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
  min-height: 44px;
  touch-action: manipulation; user-select: none;
}
.nw-generate-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-generate-btn:not(:disabled):hover { filter: brightness(1.06); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-generate-btn:not(:disabled):active { opacity: 0.82; transform: scale(0.97); }
}
.nw-status-hint { font-size: 12px; color: var(--muted); }

/* Inline offline banner. Sits at the top of the Reports tab when
   navigator.onLine is false. Subtle accent-tinted strip — loud enough
   to be noticed, quiet enough not to dominate the report itself. We
   deliberately keep the rest of the UI rendered (cached reports remain
   visible) rather than swapping to a full-screen disconnect splash. */
.nw-offline-banner {
  margin: 0 0 12px; padding: 8px 12px; border-radius: 8px;
  background: var(--accent-dim, rgba(99,102,241,0.12));
  border: 1px solid var(--border); color: var(--text);
  font-size: 12.5px; line-height: 1.45;
}

/* Reading column for the report feed. We centre a comfortable width so
   long summaries don't stretch edge-to-edge on web; on mobile it just
   fills the viewport. */
.nw-report-container {
  max-width: 640px; margin: 0 auto;
  word-break: break-word; overflow-wrap: anywhere;
}
.nw-report-container.is-reader { padding: 20px; }

/* "Today at a glance" tl;dr strip — accent-tinted, the report's lede. */
.nw-glance {
  font-size: 14px; line-height: 1.6; color: var(--text);
  margin: 14px 0 16px; padding: 12px 14px;
  background: var(--accent-dim); border-radius: 8px;
  border-left: 3px solid var(--accent);
}
.nw-section-title {
  display: inline-block;
  font-size: 15px; font-weight: 700; color: var(--text);
  margin: 18px 0 10px; padding-bottom: 5px;
  border-bottom: 2px solid var(--accent);
}
.nw-article {
  margin-bottom: 14px; padding-left: 12px;
  border-left: 3px solid var(--border-light, var(--border));
}
.nw-headline { font-size: 14px; font-weight: 600; line-height: 1.4; margin: 0 0 4px; }
.nw-article-summary { font-size: 13px; line-height: 1.55; color: var(--muted); margin: 0; }

/* Report reader — full-bleed overlay anchored to the app root. */
.nw-reader {
  position: absolute; inset: 0; z-index: 5;
  display: flex; flex-direction: column;
  background: var(--bg); color: var(--text);
}
.nw-reader-bar {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-bottom: 1px solid var(--border);
  background: var(--surface); flex-shrink: 0;
}
.nw-reader-back {
  min-height: 44px; padding: 7px 12px; border-radius: 9px;
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text); font-size: 13px; font-weight: 650;
  cursor: pointer; font-family: var(--font);
  touch-action: manipulation; user-select: none;
}
@media (prefers-reduced-motion: no-preference) {
  .nw-reader-back:active { opacity: 0.75; }
}
.nw-reader-title {
  flex: 1; min-width: 0; font-size: 14px; font-weight: 750;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  user-select: none;
}
.nw-reader-body {
  flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden;
  overscroll-behavior: contain;
  /* Reserve the classic-scrollbar gutter even while content fits, so the
     height-bridge growing the iframe never changes the content width
     (width change → text re-wrap → new height → feedback loop). */
  scrollbar-gutter: stable;
}
.nw-reader-frame {
  width: 100%; border: 0; background: var(--bg); display: block;
  /* Height is set dynamically by the postMessage height-bridge.
     min-height keeps the reader from looking empty before the first
     message arrives (~70vh equivalent); max content height is capped
     server-side at 16000px so the outer column never grows unboundedly. */
  min-height: 70vh;
}

/* Report feed list. */
.nw-feed-list { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
.nw-feed-item {
  width: 100%; min-height: 44px; text-align: left; padding: 13px 15px;
  border-radius: 10px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  cursor: pointer; font-family: var(--font);
  touch-action: manipulation;
}
@media (hover: hover) {
  .nw-feed-item:hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-feed-item { transition: border-color 0.15s, transform 0.1s; }
  .nw-feed-item:active { opacity: 0.85; transform: translateY(1px); }
}
.nw-feed-date { font-size: 14px; font-weight: 750; color: var(--accent); margin-bottom: 5px; user-select: none; }
.nw-feed-summary { font-size: 13px; line-height: 1.45; color: var(--muted); }

/* Feedback affordance — sits at the bottom of the scrollable report body. */
.nw-feedback-box {
  margin: 16px 16px 22px; padding-top: 14px;
  padding-bottom: max(22px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
}
.nw-ask-btn {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  width: 100%; min-height: 46px;
  padding: 11px 16px; border-radius: 12px;
  border: 1px solid var(--accent);
  background: var(--accent-dim); color: var(--accent);
  font-size: 13.5px; font-weight: 700; cursor: pointer;
  touch-action: manipulation; user-select: none;
  box-sizing: border-box; font-family: var(--font);
}
@media (hover: hover) {
  .nw-ask-btn:hover { filter: brightness(1.06); border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-ask-btn:active { opacity: 0.8; transform: scale(0.97); }
}

/* Centered status states. */
.nw-empty {
  text-align: center; padding: 50px 20px; color: var(--muted);
  font-size: 13px; line-height: 1.6;
}
.nw-loading { text-align: center; padding: 50px 20px; color: var(--muted); font-size: 13px; }

/* Settings */
.nw-settings-wrap { max-width: 720px; }
.nw-settings-section { margin-bottom: 24px; }
.nw-label { font-size: 13px; font-weight: 600; margin: 0 0 4px; display: block; }
.nw-note { font-size: 12px; color: var(--muted); margin: 0 0 10px; line-height: 1.5; }
.nw-topics-textarea {
  width: 100%; min-height: 140px;
  font-family: var(--font);   /* plain prose textarea — this is freeform English now */
  font-size: 16px;            /* 16px stops iOS Safari zoom-on-focus — don't go lower on a focusable field */
  line-height: 1.55; padding: 12px;
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 8px;
  resize: vertical; box-sizing: border-box;
  white-space: pre-wrap; word-break: break-word;
  overflow-wrap: anywhere; max-width: 100%;
}
.nw-btn-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.nw-btn-row.has-top { margin-top: 8px; }
.nw-btn {
  min-height: 44px; padding: 7px 16px; border: none; border-radius: 10px;
  background: var(--accent); color: #fff;
  font-size: 13px; font-weight: 600; cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-btn:disabled {
  background: var(--surface); color: var(--muted); cursor: default; pointer-events: none;
}
@media (hover: hover) {
  .nw-btn:not(:disabled):hover { filter: brightness(1.06); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-btn:not(:disabled):active { opacity: 0.82; transform: scale(0.97); }
}
.nw-link-btn {
  background: none; border: none; padding: 0;
  color: var(--accent); font-size: 12px; cursor: pointer; text-decoration: underline;
  touch-action: manipulation; user-select: none;
}
@media (prefers-reduced-motion: no-preference) {
  .nw-link-btn:active { opacity: 0.75; }
}
.nw-toast { font-size: 12px; color: var(--green, #4caf50); }
.nw-error-toast { font-size: 12px; color: var(--danger, #ef4444); }
/* Secondary button for "Run now"/"Save schedule" — surface fill so it
   reads as a quieter action than the accent-filled primary buttons.
   Busy reuses the disabled state (muted text, default cursor). */
.nw-btn-secondary {
  min-height: 44px; padding: 7px 14px; border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--surface); color: var(--text);
  font-size: 13px; font-weight: 600; cursor: pointer;
  touch-action: manipulation; user-select: none;
}
.nw-btn-secondary:disabled { color: var(--muted); cursor: default; pointer-events: none; }
@media (hover: hover) {
  .nw-btn-secondary:not(:disabled):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-btn-secondary:not(:disabled):active { opacity: 0.8; transform: scale(0.97); }
}

/* Agent / Model section — compact picker. The backend already filters
   hidden model prefs, matching the chat picker list. */
.nw-model-select {
  width: 100%; min-height: 42px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); color: var(--text);
  font-size: 16px; font-family: var(--font); font-weight: 600;
}
.nw-time-input { width: 150px; }
.nw-model-meta { margin-top: 8px; font-size: 12px; color: var(--muted); line-height: 1.5; }
/* Raw model id is metadata — render it in the mono token, not Inter. */
.nw-model-meta-id { font-family: var(--mono); }
.nw-model-button {
  width: 100%; min-height: 46px; padding: 9px 12px;
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--surface); color: var(--text);
  display: flex; align-items: center; justify-content: space-between;
  gap: 12px; cursor: pointer; font-family: var(--font); text-align: left;
  touch-action: manipulation; user-select: none;
}
@media (hover: hover) {
  .nw-model-button:hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-model-button:active { opacity: 0.85; }
}
.nw-model-button-main { min-width: 0; }
.nw-model-button-label { display: block; font-size: 13.5px; font-weight: 750; }
.nw-model-button-sub { display: block; font-size: 12px; color: var(--muted); margin-top: 2px; font-family: var(--mono); }
.nw-model-button-caret { color: var(--muted); }

/* Picker sheet + scrim — anchored to the app root (absolute, not fixed). */
.nw-picker-backdrop {
  position: absolute; inset: 0; z-index: 20;
  background: var(--scrim, rgba(0,0,0,0.35)); display: flex;
  align-items: flex-end; justify-content: center;
  /* Bottom-pinned sheet: keep it clear of the home indicator on a phone. */
  padding: 16px;
  padding-bottom: max(16px, env(safe-area-inset-bottom));
}
.nw-picker-sheet {
  width: min(560px, 100%); max-height: 72vh; overflow-y: auto;
  background: var(--bg); color: var(--text);
  border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 18px 60px rgba(0,0,0,0.38); padding: 14px;
  overscroll-behavior: contain;
}
.nw-picker-head { display: flex; align-items: center; margin-bottom: 12px; gap: 10px; }
.nw-picker-head-title { flex: 1; font-size: 14px; font-weight: 800; user-select: none; }
.nw-model-group { display: flex; flex-direction: column; gap: 6px; }
.nw-model-group-header {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.6px;
  color: var(--muted); margin: 2px 4px 4px;
  user-select: none;
}
.nw-model-group-hint {
  font-size: 12px; font-weight: 500;
  text-transform: none; letter-spacing: 0;
  color: var(--muted); opacity: 0.85;
}
.nw-model-row {
  display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  padding: 10px 12px; border-radius: 10px; cursor: pointer;
  background: var(--surface); border: 1px solid var(--border);
  font-family: var(--font); font-size: 13px; font-weight: 500; color: var(--text);
  user-select: none; touch-action: manipulation;
}
.nw-model-row.is-on { background: var(--accent-dim); border-color: var(--accent); }
.nw-model-row:disabled { cursor: not-allowed; opacity: 0.55; pointer-events: none; }
.nw-model-row.is-on:disabled { opacity: 1; }
@media (hover: hover) {
  .nw-model-row:not(:disabled):not(.is-on):hover { border-color: var(--accent); }
}
@media (prefers-reduced-motion: no-preference) {
  .nw-model-row:not(:disabled):active { opacity: 0.85; }
}
.nw-model-row-main { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.nw-model-row-title { font-weight: 600; }
.nw-model-row-sub { font-size: 12px; color: var(--muted); font-weight: 400; font-family: var(--mono); }

/* mobius-ui:ReducedMotion v1 -- honor the OS reduce-motion setting */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
/* /mobius-ui:ReducedMotion */
`

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

// Editorial-brief offline cache. getText() goes straight to fetch (the
// runtime can't return plain text), so an offline Settings open reads
// {ok:false} and would otherwise paint DEFAULT_TOPICS — masking the
// user's real brief and, worse, letting an offline "Save" overwrite the
// real brief on the server with the default. We mirror the report cache:
// stash the brief in localStorage every time we read it online, and read
// it back when the network read fails so the textarea shows the real
// brief offline.
function topicsCacheKey(appId) {
  return `news:${appId}:topics-cache:v1`
}

function readTopicsCache(appId) {
  try {
    const v = localStorage.getItem(topicsCacheKey(appId))
    return typeof v === 'string' ? v : null
  } catch {
    return null
  }
}

function writeTopicsCache(appId, text) {
  try {
    if (typeof text === 'string') localStorage.setItem(topicsCacheKey(appId), text)
  } catch {
    // Quota / disabled storage — skip; in-memory state still works.
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
    // Emit alongside the existing chat-draft feedback so Dreaming can
    // count how often users engage with a digest without parsing chat logs.
    window.mobius?.signal?.('feedback_given', { signal: 'note' })
  }
  return (
    <div className="nw-feedback-box">
      <button type="button" className="nw-ask-btn" onClick={openFeedbackChat}>
        💬 Discuss this digest with the agent
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
    'ARTICLE', 'HEADER', 'H1', 'DETAILS', 'SUMMARY', 'SECTION', 'P', 'H2', 'H3', 'H4',
    'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'STRONG', 'EM', 'B', 'I',
    'SPAN', 'TIME', 'BR', 'DIV', 'FIGURE', 'FIGCAPTION', 'IMG', 'TABLE',
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
      } else if (child.tagName === 'IMG') {
        // Only https images survive; alt + numeric width/height are kept,
        // every other attribute is stripped. A non-https (or unparseable)
        // src drops the whole element rather than leaving a broken box.
        const src = safeImgSrc(child.getAttribute('src'))
        if (!src) {
          child.remove()
          walk(node)
          return
        }
        const alt = child.getAttribute('alt')
        const dims = { width: child.getAttribute('width'), height: child.getAttribute('height') }
        for (const attr of [...child.attributes]) child.removeAttribute(attr.name)
        child.setAttribute('src', src)
        // Suppress the Referer header so CDN hotlink-protection rules don't
        // block the request. Without this, many news image hosts (Reuters,
        // AP, Getty proxies) return 403 when the request carries the
        // srcdoc blob URL as referrer.
        child.setAttribute('referrerpolicy', 'no-referrer')
        if (typeof alt === 'string') child.setAttribute('alt', alt)
        for (const dim of ['width', 'height']) {
          const v = dims[dim]
          if (typeof v === 'string' && /^\d{1,4}$/.test(v.trim())) child.setAttribute(dim, v.trim())
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
<meta http-equiv="Content-Security-Policy" content="${NEWS_REPORT_CSP}">
<!-- Suppress Referer on all subresource requests. CDN hotlink-protection
     rules commonly 403 when the srcdoc blob URL leaks as the referer. -->
<meta name="referrer" content="no-referrer">
<base target="_blank">
${NEWS_REPORT_HEIGHT_SCRIPT}
<style>
  :root {
    --bg: ${t.bg};
    --surface: ${t.surface};
    --text: ${t.text};
    --muted: ${t.muted};
    --border: ${t.border};
    --accent: ${t.accent};
    /* Derived tokens — accent-tint is a soft fill behind accent-bordered cards. */
    --accent-tint: color-mix(in srgb, var(--accent) 12%, transparent);
    /* Spacing scale mirrors the dreaming brief template. */
    --sp-1: 0.25rem;
    --sp-2: 0.5rem;
    --sp-3: 0.75rem;
    --sp-4: 1rem;
    --sp-5: 1.5rem;
    --sp-6: 2rem;
    --sp-7: 3rem;
    --radius: 14px;
    --radius-sm: 9px;
    --maxw: 46rem;
    /* Modular type scale (1.20 minor-third). */
    --step--1: 0.833rem;
    --step-0:  1rem;
    --step-1:  1.20rem;
    --step-2:  1.44rem;
    --step-3:  1.728rem;
    --step-4:  2.074rem;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  /* Overflow safety net (mirrors the dreaming brief's base style): never
     let agent-authored content scroll the page sideways. Wide tables get
     their OWN scroller below; everything else is boxed to the viewport.
     <article> is excluded so its --maxw column cap keeps winning. */
  html, body { max-width: 100%; overflow-x: hidden; }
  *:not(html):not(body):not(article) { max-width: 100%; }
  body {
    margin: 0;
    padding: clamp(var(--sp-4), 4vw, var(--sp-7));
    padding-bottom: var(--sp-7);
    /* Accent-tinted radial gradient in the top-right corner — same as the
       dreaming brief so both reports feel like they belong to the same platform. */
    background:
      radial-gradient(120% 55% at 100% 0%, var(--accent-tint) 0%, transparent 55%),
      var(--bg);
    background-attachment: fixed;
    color: var(--text);
    font: var(--step-0)/1.65
          -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica,
          Arial, "Apple Color Emoji", sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  article {
    max-width: var(--maxw);
    margin: 0 auto;
  }

  /* Masthead — kicker line + big headline + hairline rule, matching the
     dreaming brief's masthead (brand row, h1, dateline, border-bottom). */
  article.news-report > header {
    margin: 0 0 var(--sp-5);
    padding-bottom: var(--sp-4);
    border-bottom: 1px solid var(--border);
  }
  article.news-report > header > p {
    margin: 0 0 var(--sp-2);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  article.news-report > header h1 {
    margin: 0;
    font-size: clamp(var(--step-3), 5.5vw, var(--step-4));
    line-height: 1.12;
    font-weight: 680;
    letter-spacing: -0.02em;
    color: var(--text);
  }

  /* TL;DR summary card — accent-left-rail + surface card, matches the
     dreaming brief's .lede treatment. */
  details.news-report__summary {
    margin: 0 0 var(--sp-5);
    padding: var(--sp-4) var(--sp-5);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 14px rgba(0,0,0,.05);
  }
  details.news-report__summary summary {
    cursor: pointer;
    color: var(--accent);
    font-weight: 700;
    font-size: var(--step--1);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: var(--sp-2);
    list-style: none;
  }
  details.news-report__summary summary::-webkit-details-marker { display: none; }
  details.news-report__summary > p {
    margin: 0;
    font-size: var(--step-0);
    line-height: 1.62;
    color: var(--text);
  }
  /* Key developments inside the summary card — dreaming's .keypoints:
     accent dots + hairline separators instead of default bullets. */
  details.news-report__summary ul {
    list-style: none;
    margin: var(--sp-3) 0 0;
    padding: 0;
  }
  details.news-report__summary ul li {
    position: relative;
    margin: 0;
    padding: var(--sp-2) 0 var(--sp-2) var(--sp-5);
    border-top: 1px solid var(--border);
    line-height: 1.55;
  }
  details.news-report__summary ul li::before {
    content: "";
    position: absolute;
    left: var(--sp-1);
    top: 1.05em;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
  }

  /* Strong lede — the opening paragraph of the body reads large and bold,
     like a magazine lede, matching the dreaming brief's headline treatment. */
  .news-report__body > p:first-child {
    font-size: var(--step-2);
    line-height: 1.28;
    font-weight: 720;
    letter-spacing: -0.02em;
    color: var(--text);
    margin: 0 0 var(--sp-5);
  }
  /* When the report carries a masthead h1 (the current schema), the
     headline register belongs to the h1 and the opening paragraph drops
     to a magazine standfirst. Legacy reports without a masthead keep the
     big-bold lede above (and browsers without :has() degrade to it). */
  article.news-report:has(> header h1) .news-report__body > p:first-child {
    font-size: var(--step-1);
    line-height: 1.5;
    font-weight: 500;
    letter-spacing: -0.005em;
  }

  /* Section headings — clean hierarchy with breathing room. */
  h2 {
    margin: var(--sp-6) 0 var(--sp-3);
    color: var(--text);
    font-size: var(--step-2);
    font-weight: 680;
    letter-spacing: -0.015em;
    line-height: 1.25;
  }
  h3 {
    margin: var(--sp-5) 0 var(--sp-2);
    color: var(--text);
    font-size: var(--step-1);
    font-weight: 640;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  h4 {
    margin: var(--sp-4) 0 var(--sp-2);
    color: var(--muted);
    font-size: var(--step-0);
    font-weight: 660;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  p { margin: 0 0 var(--sp-4); }

  a {
    color: var(--accent);
    text-decoration-thickness: 0.08em;
    text-underline-offset: 0.18em;
  }
  a:hover { text-decoration: underline; }
  a:focus-visible {
    outline: none;
    border-radius: 4px;
    box-shadow: 0 0 0 3px var(--accent-tint);
  }

  /* Long-tail drill-downs — "Also today" / "In brief". Collapsed card
     with a rotating chevron, same affordance as the dreaming brief's
     details blocks: terse by default, detail on tap. */
  details.news-report__more {
    margin: var(--sp-5) 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 14px rgba(0,0,0,.05);
    overflow: hidden;
  }
  details.news-report__more > summary {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4);
    font-weight: 600;
    color: var(--text);
  }
  details.news-report__more > summary::-webkit-details-marker { display: none; }
  details.news-report__more > summary::before {
    content: "›";
    display: inline-block;
    transition: transform .15s ease;
    color: var(--accent);
    font-weight: 700;
  }
  details.news-report__more[open] > summary::before { transform: rotate(90deg); }
  details.news-report__more > summary:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  /* Margins (not padding) inset the content so a nested list keeps its
     own padding-left and the bullets stay inside the card. */
  details.news-report__more > *:not(summary) {
    margin-top: 0;
    margin-bottom: var(--sp-3);
    margin-left: var(--sp-4);
    margin-right: var(--sp-4);
  }

  /* Blockquote — muted pull-quote surface. */
  blockquote {
    margin: var(--sp-5) 0;
    padding: var(--sp-4) var(--sp-5);
    border-left: 3px solid var(--accent);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    background: var(--surface);
    color: var(--muted);
    font-style: italic;
  }
  blockquote p:last-child { margin-bottom: 0; }

  /* Card surface for figures and callouts — same as dreaming .item. */
  figure, .callout {
    margin: var(--sp-5) 0;
    padding: var(--sp-4) var(--sp-5);
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 4px 14px rgba(0,0,0,.05);
  }
  figure { display: block; }
  figure img { margin: 0; display: block; }
  figcaption {
    margin-top: var(--sp-2);
    color: var(--muted);
    font-size: var(--step--1);
    line-height: 1.5;
  }

  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: var(--sp-5) auto;
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }
  /* Suppress broken-image alt text visually (still readable by screen readers). */
  img { color: transparent; }

  table {
    /* display:block turns a too-wide table into its own horizontal
       scroller (dreaming's overflow guard) instead of pushing the whole
       page sideways. */
    display: block;
    width: 100%;
    border-collapse: collapse;
    margin: var(--sp-5) 0;
    font-size: var(--step--1);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow-x: auto;
  }
  th, td {
    border-bottom: 1px solid var(--border);
    padding: var(--sp-3) var(--sp-4);
    text-align: left;
    vertical-align: top;
  }
  tr:last-child th, tr:last-child td { border-bottom: none; }
  th { color: var(--text); font-weight: 700; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; background: var(--surface); }

  svg { max-width: 100%; height: auto; display: block; margin: var(--sp-3) auto; }

  ul, ol { padding-left: 1.4em; margin: 0 0 var(--sp-4); }
  li { margin: var(--sp-2) 0; line-height: 1.6; }
  li + li { margin-top: var(--sp-2); }

  /* Horizontal rule — clean separator. */
  hr { border: none; border-top: 1px solid var(--border); margin: var(--sp-6) 0; }
</style>
</head>
<body>${safe}</body>
</html>`
}

function ReportReader({ entry, appId, token, cachedReport, onBodyLoaded, onBack }) {
  const [report, setReport] = useState(cachedReport || null)
  // undefined = meta still resolving, null = resolved with no linked chat,
  // string = the report's chat id. The feedback button stays hidden until
  // this is resolved so a fast click on an instantly-painted cached report
  // can't race the meta read and open a blank new chat instead of the
  // report's linked one.
  const [chatId, setChatId] = useState(undefined)
  const [phase, setPhase] = useState(cachedReport ? 'ready' : 'loading')
  // Height reported by the iframe's injected height-reporter script via
  // postMessage. Starts at a sane minimum (~70vh in px equivalent so
  // the iframe never looks tiny before the first message arrives).
  const [iframeHeight, setIframeHeight] = useState(500)
  // Identifies OUR report iframe in the message listener: the sandboxed
  // frame has a null origin so ev.origin can't be checked — ev.source
  // against this ref's contentWindow is the only way to reject spoofed
  // news:report-height messages from other windows.
  const iframeRef = useRef(null)

  // Keep the body-cache callback and the cached fallback in refs so they
  // stay OUT of the load effect's dependency list. They used to be deps,
  // which created a feedback loop: the effect loads the body → calls
  // onBodyLoaded → the parent caches it → `cachedReport` (and sometimes
  // `onBodyLoaded`) get a fresh identity → the effect re-runs → loads
  // again. That was a 100+ fetch storm per open, and each re-run reset
  // chatId to null, so the feedback button raced the meta read and opened
  // a blank new chat instead of the report's linked chat. The load must
  // fire once per report date.
  const onBodyLoadedRef = useRef(onBodyLoaded)
  onBodyLoadedRef.current = onBodyLoaded
  const cachedReportRef = useRef(cachedReport)
  cachedReportRef.current = cachedReport

  useEffect(() => {
    let cancelled = false
    const cached = cachedReportRef.current
    setChatId(undefined)
    setReport(cached || null)
    setPhase(cached ? 'ready' : 'loading')
    ;(async () => {
      const body = await loadReportBody(appId, token, entry)
      if (cancelled) return
      if (body) {
        setReport(body)
        setPhase('ready')
        onBodyLoadedRef.current?.(entry.date, body)
      } else if (!cachedReportRef.current) {
        setPhase('error')
      }
    })()
    ;(async () => {
      const meta = await loadReportMeta(appId, token, entry.date)
      if (!cancelled) setChatId(meta.chatId)
    })()
    return () => { cancelled = true }
  }, [appId, token, entry.date, entry.ext])

  // Reset iframe height when a new report is loaded so we never show
  // the previous report's height before the first postMessage arrives.
  useEffect(() => {
    setIframeHeight(500)
  }, [entry.date])

  // Size the report iframe from postMessage events sent by the injected
  // height-reporter script (see buildHtmlSrcDoc + NEWS_REPORT_HEIGHT_SCRIPT).
  // The iframe runs with allow-scripts but WITHOUT allow-same-origin, so
  // contentDocument is NOT readable from the parent — height is received
  // passively via postMessage instead.
  useEffect(() => {
    const onMessage = (ev) => {
      if (!ev.data || ev.data.type !== 'news:report-height') return
      if (ev.source !== iframeRef.current?.contentWindow) return
      const h = Number(ev.data.height)
      if (Number.isFinite(h) && h > 0) {
        // No buffer: the reporter sends Math.ceil of the documentElement's
        // border-box height, which is already exact — adding padding here
        // would just re-introduce creep. Clamp to a sane ceiling so a
        // runaway report can't grow the page unboundedly (matches
        // dreaming's 16000px ceiling).
        setIframeHeight(Math.min(Math.max(h, 200), 16000))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  return (
    <div className="nw-reader">
      <div className="nw-reader-bar">
        <button type="button" className="nw-reader-back" onClick={onBack}>← Back</button>
        <div className="nw-reader-title">{formatDate(entry.date)}</div>
      </div>
      <div className="nw-reader-body">
        {phase === 'loading' && <div className="nw-loading">Loading report…</div>}
        {phase === 'error' && <div className="nw-empty">This report could not be loaded.</div>}
        {report && report.html && (
          <iframe
            title={`News digest for ${report.date}`}
            // allow-scripts lets the injected height-reporter run.
            // allow-same-origin is intentionally absent: without it the
            // iframe gets a null origin, so its scripts cannot reach the
            // parent's DOM, localStorage, or owner JWT regardless of what
            // the report HTML contains. allow-popups lets external links
            // open in a new tab.
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            srcDoc={buildHtmlSrcDoc(report)}
            className="nw-reader-frame"
            ref={iframeRef}
            style={{ height: `${iframeHeight}px` }}
          />
        )}
        {report && !report.html && (
          <div className="nw-report-container is-reader">
            {report.summary && <div className="nw-glance">{report.summary}</div>}
            {(report.sections || []).map((section, si) => (
              <div key={si}>
                {section.title && <div className="nw-section-title">{section.title}</div>}
                {(section.articles || []).map((art, ai) => (
                  <div key={ai} className="nw-article">
                    <p className="nw-headline">{art.headline}</p>
                    <p className="nw-article-summary">{art.summary}</p>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {report && chatId !== undefined && (
          <FeedbackLauncher report={report} chatId={chatId} />
        )}
      </div>
    </div>
  )
}

function ReportsTab({ appId, token, online }) {
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
    // Dreaming knows roughly how much content the user consumed.
    const cached = cachedReportsRef.current[entry.date]
    const articleCount = cached?.sections
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
  const sheetRef = useRef(null)
  // The trigger that opened the sheet, so focus can be restored to it on
  // close (sheet is a dialog — losing the user's place is a keyboard a11y
  // failure). Kept in a ref so it survives re-renders without re-running
  // the focus effect.
  const triggerRef = useRef(null)
  const activeGroup = groups?.find((g) => g.key === provider)
  const activeModel = activeGroup?.models.find((m) => m.id === model)
  const label = activeModel
    ? `${activeGroup.label} · ${activeModel.name}`
    : model || 'Choose model'

  // On open, move focus into the sheet so a keyboard user lands inside the
  // dialog (and Escape closes it); on close, return focus to the trigger.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    // Focus the first focusable control in the sheet (the Close button).
    const first = sheetRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    first?.focus?.()
    return () => {
      document.removeEventListener('keydown', onKey)
      triggerRef.current?.focus?.()
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="nw-model-button"
        onClick={() => setOpen(true)}
      >
        <span className="nw-model-button-main">
          <span className="nw-model-button-label">{label}</span>
          <span className="nw-model-button-sub">
            {model}
          </span>
        </span>
        <span aria-hidden="true" className="nw-model-button-caret">▾</span>
      </button>
      {open && (
        <div className="nw-picker-backdrop" onClick={() => setOpen(false)}>
          <div
            ref={sheetRef}
            className="nw-picker-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Choose model"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nw-picker-head">
              <div className="nw-picker-head-title">Model</div>
              <button type="button" className="nw-link-btn" onClick={() => setOpen(false)}>Close</button>
            </div>
            {!groups || groups.length === 0 ? (
              <div className="nw-note">No visible models. Adjust model visibility from chat settings.</div>
            ) : groups.map((group) => {
              const connected = !connectedProviders || connectedProviders.has(group.key)
              return (
                <div key={group.key} className="nw-model-group">
                  <div className="nw-model-group-header">
                    <span>{group.label}</span>
                    {!connected && <span className="nw-model-group-hint">not connected</span>}
                  </div>
                  {group.models.map((m) => {
                    const on = provider === group.key && model === m.id
                    const disabled = !connected && !on
                    return (
                      <button
                        key={`${group.key}-${m.id}`}
                        type="button"
                        className={`nw-model-row${on ? ' is-on' : ''}`}
                        disabled={disabled}
                        onClick={() => {
                          onChange(group.key, m.id)
                          setOpen(false)
                        }}
                      >
                        <div className="nw-model-row-main">
                          <span className="nw-model-row-title">{m.name}</span>
                          <span className="nw-model-row-sub">{m.id}</span>
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
  // True when the brief currently in the textarea was NOT read live from
  // the server this session (offline cache fallback, or bundled default
  // because there was no cache). Saving a stale brief offline would queue
  // an overwrite of the real server copy, so Save is gated until the user
  // either loads it live or edits it themselves (an intentional change).
  const [topicsStale, setTopicsStale] = useState(false)
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
      // Brief: prefer the live server read and refresh the offline
      // cache from it. When the read fails (offline / transient), fall
      // back to the cached brief so the textarea shows the user's real
      // brief — NOT DEFAULT_TOPICS, which a subsequent Save would
      // otherwise persist over the real brief on reconnect. Only fall
      // all the way back to the bundled default when there's no cache.
      if (tRes.ok) {
        const liveTopics = normalizeSeededTopics(tRes.data)
        setTopics(liveTopics)
        writeTopicsCache(appId, liveTopics)
        setTopicsStale(false)
      } else {
        const cached = readTopicsCache(appId)
        setTopics(cached != null ? cached : DEFAULT_TOPICS)
        // No live read landed — mark the brief stale so an offline Save
        // can't overwrite the server copy with an un-loaded value.
        setTopicsStale(true)
      }
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
    // The brief in the textarea is now the intended value — keep the
    // offline cache in lockstep so a later offline open shows it.
    writeTopicsCache(appId, topics)
    setTopicsStale(false)
    setTopicsToast(toastFor(res))
    setTimeout(() => setTopicsToast(''), 2000)
  }, [appId, token, topics])

  const resetTopics = useCallback(async () => {
    setTopics(DEFAULT_TOPICS)
    setTopicsStale(false)
    const res = await putText(
      `/api/storage/apps/${appId}/topics.txt`, token, DEFAULT_TOPICS, appId,
    )
    writeTopicsCache(appId, DEFAULT_TOPICS)
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
    // The cron registration is the authoritative action and can't be
    // queued — schedule.json is only a display mirror of it. Update cron
    // FIRST and only persist schedule.json once that succeeds, so the two
    // can never disagree. (Previously putJSON ran first and queued the new
    // time offline while the cron POST failed, leaving the displayed time
    // and the real job permanently out of sync once the queue drained.)
    const cron = buildCron(schedule.hour, schedule.minute)
    try {
      const r = await fetch(`/api/apps/${appId}/schedule`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cron, job: 'fetch.sh' }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      await putJSON(
        `/api/storage/apps/${appId}/schedule.json`,
        token,
        { ...schedule, cron },
        appId,
      )
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

  if (loading) return <div className="nw-loading">Loading settings…</div>

  return (
    <div className="nw-settings-wrap">
      <div className="nw-settings-section">
        {/* Label: "Editorial brief" rather than the old "What to search
            for". The textarea now carries most of the editorial intent
            (topics, sources, voice, framing), while system-prompt.md is
            kept as a thin technical schema. "Editorial brief" sets the
            expectation that this is prose, not a keyword list. */}
        <label className="nw-label">Editorial brief</label>
        {/* Fixed, non-editable helper: this is the "make it yours" framing
            that used to live as the first paragraph of the brief itself.
            Surfaced here so it guides the editor without the curator reading
            it back as part of the brief each morning. Keep it conversational
            and short — formatting/HTML guidance stays in system-prompt.md. */}
        <p className="nw-note">
          This is what the curator reads every morning to decide what to write
          and how. Make it yours — the more specific and opinionated you are,
          the better the digest. Plain English; the formatting is handled for you.
        </p>
        <textarea
          className="nw-topics-textarea"
          value={topics}
          // A user edit is intentional content, so it's safe to save even
          // if the live read never landed — clear the stale guard.
          onChange={(e) => { setTopics(e.target.value); setTopicsStale(false) }}
          // 12 rows by default so the editorial brief has room to
          // breathe; the user can still drag the resize handle.
          rows={12}
          spellCheck={true}
        />
        <div className="nw-btn-row">
          {/* Block saving an un-loaded brief while offline: the textarea
              is showing a cached/default fallback, not the live server
              copy, so a queued save would overwrite the real brief on
              reconnect. */}
          <button
            className="nw-btn"
            onClick={saveTopics}
            disabled={topicsStale && !online}
            title={topicsStale && !online ? 'Reconnect to load and save your brief' : undefined}
          >
            Save
          </button>
          <button className="nw-link-btn" onClick={resetTopics}>Reset to default</button>
          {topicsStale && !online && (
            <span className="nw-status-hint">Offline — showing your cached brief</span>
          )}
          {topicsToast && <span className="nw-toast">{topicsToast}</span>}
        </div>
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Agent / Model</label>
        <p className="nw-note">
          Which model generates your daily digest. The list follows your
          chat model visibility settings.
        </p>
        {providerGroups === null ? (
          <div className="nw-note">Loading models…</div>
        ) : (
          <>
            <ModelPicker
              provider={provider}
              model={model}
              groups={providerGroups}
              connectedProviders={connectedProviders}
              onChange={saveAgent}
            />
            <div className="nw-model-meta">
              {providerGroups.find((group) => group.key === provider)?.label || provider}
              {' · '}
              <span className="nw-model-meta-id">{model}</span>
            </div>
          </>
        )}
        {agentToast && (
          <div className="nw-btn-row has-top">
            <span className="nw-toast">{agentToast}</span>
          </div>
        )}
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Schedule</label>
        <p className="nw-note">
          Pick when the digest job should run each day.
        </p>
        <div className="nw-btn-row">
          <input
            type="time"
            value={timeValue(schedule)}
            onChange={onScheduleChange}
            className="nw-model-select nw-time-input"
            aria-label="Daily digest time"
          />
          <button
            className="nw-btn-secondary"
            onClick={saveSchedule}
            disabled={!online}
            title={!online ? 'Online required to update the schedule' : undefined}
          >
            Save schedule
          </button>
          <button
            className="nw-btn-secondary"
            onClick={handleRunNow}
            disabled={runNowBusy || !online}
            aria-busy={runNowBusy}
            title={!online ? 'Online required to trigger a fetch' : undefined}
          >
            {runNowBusy ? 'Running…' : 'Run now'}
          </button>
          {scheduleToast && <span className="nw-toast">{scheduleToast}</span>}
          {scheduleError && <span className="nw-error-toast">{scheduleError}</span>}
          {runNowToast && <span className="nw-toast">{runNowToast}</span>}
          {runNowError && <span className="nw-error-toast">{runNowError}</span>}
        </div>
      </div>
    </div>
  )
}

export default function App({ appId, token }) {
  const [tab, setTab] = useState('reports')
  const online = useOnline()

  return (
    <div className="nw-root">
      <style>{CSS}</style>
      <div className="nw-header">
        {/* Brand row: the app's own glossy icon (downscaled+cached by the
            backend, ?size=64 → ~6KB) followed by the "News" wordmark — the
            one app in the catalog that pairs its mark with a text label. The
            icon falls back to an accent dot when an install has no custom
            icon (the route 404s). */}
        <div className="nw-brand">
          <img
            src={`/api/apps/${appId}/icon?size=64`}
            alt=""
            width={34}
            height={34}
            className="nw-brand-icon"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
              const f = e.currentTarget.nextElementSibling
              if (f) f.style.display = 'flex'
            }}
          />
          <span className="nw-brand-fallback" style={{ display: 'none' }} aria-hidden="true">·</span>
          <span className="nw-title">News</span>
        </div>
        <div className="nw-tabs" role="tablist" aria-label="View">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'reports'}
            className={`nw-tab${tab === 'reports' ? ' is-active' : ''}`}
            onClick={() => setTab('reports')}
          >
            Reports
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'settings'}
            className={`nw-tab${tab === 'settings' ? ' is-active' : ''}`}
            onClick={() => setTab('settings')}
          >
            Settings
          </button>
        </div>
      </div>
      <div className="nw-divider" />
      <div className="nw-scroll">
        {/* Reports stays MOUNTED across tab switches (hidden, not
            unmounted) so an in-flight "Generate report now" poll isn't
            torn down when the user steps over to Settings — the poll
            keeps running, so the completion toast, the fresh-body cache
            write, and the refreshed feed all land when the job finishes.
            Settings stays lazily mounted: it does provider/model/status
            fetches on mount that there's no reason to run until viewed. */}
        <div hidden={tab !== 'reports'}>
          <ReportsTab appId={appId} token={token} online={online} />
        </div>
        {tab === 'settings' && (
          <SettingsTab appId={appId} token={token} online={online} />
        )}
      </div>
    </div>
  )
}
