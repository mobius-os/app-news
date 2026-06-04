// Pure report-schema helpers shared by the UI (index.jsx) and the unit
// tests. No React, no I/O. New reports are agent-authored HTML fragments;
// older reports are structured JSON. These helpers coerce either form into
// the exact shape the renderer/feedback/chat seed trusts.

// Only http(s) URLs become real links. fetch.sh already drops non-
// http(s) and fabricated source_urls server-side, but a report is
// stored data we read back later and an older report (or a future
// writer) might carry something odd — so the render path gates again
// rather than trusting the stored shape. A null return tells the
// renderer to show the headline as plain text instead of an anchor.
export function safeHref(url) {
  if (typeof url !== 'string') return null
  try {
    const parsed = new URL(url.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? parsed.href : null
  } catch {
    return null
  }
}

export function isReportFilename(name) {
  return typeof name === 'string' && /^\d{4}-\d{2}-\d{2}\.(html|json)$/.test(name)
}

export function reportDateFromFilename(name) {
  return isReportFilename(name) ? name.slice(0, 10) : ''
}

export function reportExtFromFilename(name) {
  return isReportFilename(name) ? name.slice(-4) === 'html' ? 'html' : 'json' : ''
}

export function htmlToText(html) {
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

export function normalizeHtmlReport(html, fallbackDate = '') {
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

// Normalize a parsed report object into the exact shape the UI renders,
// or return null when it's unusable.
//
// Contract:
//   - returns null unless there's a non-empty top-level summary
//   - `date` falls back to fallbackDate when missing/blank
//   - sections without any usable article are dropped
//   - an article needs a non-empty headline AND summary; a missing or
//     non-http(s) source_url is simply omitted (the article stays)
export function normalizeReport(report, fallbackDate = '') {
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

export function buildFeedbackRecord(report, feedback = {}, now = new Date()) {
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
