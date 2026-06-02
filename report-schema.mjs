// Pure report-schema helpers shared by the UI (index.jsx) and the unit
// tests. No React, no I/O — just the coercion that turns a parsed JSON
// report (from the agent, from storage, or from the offline cache) into
// the exact shape the renderer trusts. fetch.sh runs an equivalent
// normalization server-side before writing; this is the client-side
// mirror, and the single place the rules live for the front end.

// Only http(s) URLs become real links. fetch.sh already drops non-
// http(s) and fabricated source_urls server-side, but a report is
// stored data we read back later and an older report (or a future
// writer) might carry something odd — so the render path gates again
// rather than trusting the stored shape. A null return tells the
// renderer to show the headline as plain text instead of an anchor.
export function safeHref(url) {
  if (typeof url !== 'string') return null
  return (url.startsWith('http://') || url.startsWith('https://')) ? url : null
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
