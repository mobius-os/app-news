// Pure + DOM-level report logic — NO React, NO network I/O. Two layers live
// here: (1) small pure helpers (schedule cron<->fields, date formatting, the
// chat-split ratio clamp, provider-group stitching, seeded-brief upgrade) that
// the settings/reader UI and the unit tests share; (2) the report render
// pipeline (client HTML sanitizer, theme-token reader, srcdoc builder) which
// touches DOMParser / getComputedStyle but is still React-free, so it stays out
// of ui/. The canonical schema validators are imported from report-schema.mjs;
// safeImgSrc is the one pure helper that only the client sanitizer needs, so it
// lives here rather than in the shared schema module.
import { safeHref } from './report-schema.mjs'
import {
  NEWS_REPORT_CSP,
  NEWS_REPORT_HEIGHT_SCRIPT,
  PROVIDER_ORDER,
  FALLBACK_GROUPS,
  DEFAULT_SCHEDULE,
  DEFAULT_TOPICS,
  PRIOR_DEFAULT_TOPICS,
} from './constants.js'

// Images are held to a stricter bar than links: https only. The digest
// is curated content, so a mixed-content (http) or unparseable image
// url is dropped rather than rendered as a broken box.
export function safeImgSrc(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    return parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

export function buildCron(hour, minute = 0) {
  return `${minute} ${hour} * * *`
}

export function getBrowserTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

export function parseSchedule(data) {
  const fallback = { ...DEFAULT_SCHEDULE, timezone: getBrowserTimezone() }
  if (!data || typeof data !== 'object') return fallback
  const timezone = typeof data.timezone === 'string' && data.timezone
    ? data.timezone
    : fallback.timezone
  if (typeof data.cron === 'string') {
    const parts = data.cron.trim().split(/\s+/)
    if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      const minute = Number(parts[0])
      const hour = Number(parts[1])
      if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return { hour, minute, timezone }
      }
    }
  }
  const hour = Number(data.hour)
  const minute = Number(data.minute || 0)
  if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute, timezone }
  return fallback
}

export function timeValue(schedule) {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
}

export function normalizeSeededTopics(text) {
  const trimmed = String(text || '').trim()
  return PRIOR_DEFAULT_TOPICS.some((d) => trimmed === d.trim())
    ? DEFAULT_TOPICS
    : text
}

export function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  return d.toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })
}

// Decide whether an in-flight "Generate report now" run has terminated, from
// the run-status side file fetch.sh writes (reports/<date>.run.json). Keyed on
// finished_at rather than the report file's mtime, because the overwrite guard
// deliberately leaves reports/<date>.html untouched when a failed rerun
// preserves a good digest — so mtime never advances in that case and an
// mtime-only poll hangs on "Generating…" forever (the blocker this closes).
//
// baseline.finishedAt is run.json.finished_at captured when generation started;
// a DIFFERENT (or newly-present) finished_at means THIS run wrote a fresh
// terminal. Both are container timestamps, so the comparison is immune to
// browser/container clock skew.
//
// Returns exactly one of:
//   { kind: 'no-run-json' } — file absent (pre-upgrade fetch.sh, or a
//        timezone-mismatched report date); the caller falls back to the
//        legacy mtime / new-file completion heuristic.
//   { kind: 'running' }     — a run.json exists but has no fresh terminal yet.
//   { kind: 'done', status: 'ok' | 'error', message } — the run finished; the
//        caller shows "Report ready." only for 'ok' and an honest error banner
//        for 'error'.
export function decideGenerateOutcome(runStatus, baseline = {}) {
  if (!runStatus || typeof runStatus !== 'object') return { kind: 'no-run-json' }
  const finished = typeof runStatus.finished_at === 'string' && runStatus.finished_at
    ? runStatus.finished_at
    : null
  if (!finished) return { kind: 'running' }
  const base = baseline.finishedAt == null ? null : String(baseline.finishedAt)
  if (finished === base) return { kind: 'running' }
  return {
    kind: 'done',
    status: runStatus.status === 'error' ? 'error' : 'ok',
    message: typeof runStatus.message === 'string' ? runStatus.message : '',
  }
}

// Choose which live-refresh triggers the Reports tab wires for out-of-band
// (cron) writes. Deliberately NEVER includes window.mobius.storage.subscribe /
// subscribeText, even when the runtime exposes them: runtime subscribe only
// re-notifies on THIS tab's own writes/reads, so a cron PUT from fetch.sh never
// fires it — wiring it would imply a live-update path that does not exist. Do
// NOT "upgrade" this back to subscribe. Out-of-band writes are instead caught by
// the visibility re-list, the online-transition re-list, and the modest
// while-visible poll.
export function selectRefreshTriggers(runtime = {}) {
  const triggers = ['visibility', 'poll']
  if (runtime && typeof runtime.onOnlineChange === 'function') triggers.push('online')
  return triggers
}

// Clamp a desired chat-pane height (px) into [pill, total - pill] and return it
// as a 0..1 ratio of the body. When the body is shorter than two pills, fall
// back to a 50/50 split so neither pane vanishes. Pure — unit-testable.
export function clampChatRatio(desiredPx, total, minPx) {
  if (!(total > 0)) return 0.5
  const floor = minPx
  const ceil = total - minPx
  if (ceil <= floor) return 0.5
  const px = Math.max(floor, Math.min(ceil, desiredPx))
  return px / total
}

// Stitch the backend's `{claude: [...], codex: [...]}` payload onto
// the PROVIDER_ORDER scaffold, dropping providers the backend didn't
// return and ignoring any unknown keys. Returns a list shaped like
// FALLBACK_GROUPS so the picker render path doesn't care where the
// data came from.
export function buildProviderGroups(payload) {
  if (!payload || typeof payload !== 'object') return FALLBACK_GROUPS
  const groups = []
  for (const meta of PROVIDER_ORDER) {
    const rows = Array.isArray(payload[meta.key]) ? payload[meta.key] : null
    if (!rows || rows.length === 0) continue
    // Defensive normalize: tolerate missing `name` (fall back to id)
    // so a half-shaped row from a future backend never blanks a row.
    const models = rows
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({ id: r.id, name: r.name || r.id }))
    // Skip a provider whose rows all failed the id filter: a group with an
    // empty models[] would crash every `group.models[0].id` default-pick.
    // Invariant: every group in the returned list has at least one model.
    if (models.length === 0) continue
    groups.push({ key: meta.key, label: meta.label, models })
  }
  return groups
}

export function sanitizeReportHtml(html) {
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
export function readReportTheme() {
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

export function buildHtmlSrcDoc(report) {
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
