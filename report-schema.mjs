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
    // Decode numeric HTML entities (the news agent emits apostrophes as
    // &#x27;, em dashes as &#x2014;, etc.); without this they show raw in
    // the plain-text summary/headlines. &amp; is decoded LAST so an encoded
    // &amp;#x27; is not double-decoded.
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => { const n = parseInt(hex, 16); return n <= 0x10ffff ? String.fromCodePoint(n) : m })
    .replace(/&#(\d+);/g, (m, dec) => { const n = parseInt(dec, 10); return n <= 0x10ffff ? String.fromCodePoint(n) : m })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstMatch(html, re) {
  const m = typeof html === 'string' ? html.match(re) : null
  return m ? htmlToText(m[1]) : ''
}

// Validate + coerce the in-report question carrier's questions array into
// the exact shape the native card consumes: [{ question, header,
// multiSelect, options:[{label, description}] }]. Anything that doesn't fit
// is dropped, not repaired — a half-formed question is worse than a missing
// one. Caps at 3 questions and 6 options each so a runaway carrier can't
// flood the read.
export function sanitizeQuestions(arr) {
  if (!Array.isArray(arr)) return []
  const out = []
  for (const raw of arr) {
    if (out.length >= 3) break        // cap at 3 VALID questions, not 3 inputs
    if (!raw || typeof raw !== 'object') continue
    const question = typeof raw.question === 'string' ? raw.question.trim() : ''
    if (!question) continue
    const opts = Array.isArray(raw.options) ? raw.options : []
    const options = []
    for (const o of opts.slice(0, 6)) {
      const label = o && typeof o.label === 'string' ? o.label.trim() : ''
      if (!label) continue
      const description = o && typeof o.description === 'string' ? o.description.trim() : ''
      options.push(description ? { label, description } : { label })
    }
    if (options.length === 0) continue
    out.push({
      question,
      header: typeof raw.header === 'string' ? raw.header.trim() : '',
      multiSelect: raw.multiSelect === true,
      options,
    })
  }
  return out
}

// Pull the agent's declarative in-report questions out of the RAW report
// HTML, and return the HTML with that carrier removed so it never reaches
// the sandboxed iframe. The agent emits ONE inert carrier:
//
//   <section class="report-questions" data-report-questions>
//     <h2>…</h2><p class="rq-note">…</p>
//     <script type="application/mobius-questions+json">{ … }</script>
//   </section>
//
// Regex-based on purpose (no DOMParser): this module is React- AND DOM-free
// so the unit suite can exercise it under `node --test`. The matcher is
// deliberately narrow — one carrier, the platform-specific MIME type — so
// it can't swallow an ordinary <section> the digest happens to use. Returns
// { html, questions }: html with the carrier removed; questions = a
// validated array (the EXACT shell QuestionCard shape) or [] when absent or
// malformed. Never throws.
export function extractReportQuestions(html) {
  const empty = { html: typeof html === 'string' ? html : '', questions: [] }
  if (typeof html !== 'string') return empty
  const scriptRe = /<script\b[^>]*type=["']application\/mobius-questions\+json["'][^>]*>([\s\S]*?)<\/script>/i
  const m = html.match(scriptRe)
  let questions = []
  if (m) {
    try {
      const parsed = JSON.parse(m[1].trim())
      questions = sanitizeQuestions(parsed && parsed.questions)
    } catch {
      questions = []
    }
  }
  let out = html
  const sectionRe = /<(section|div)\b[^>]*\bdata-report-questions\b[^>]*>[\s\S]*?<\/\1>/i
  if (sectionRe.test(out)) out = out.replace(sectionRe, '')
  else if (m) out = out.replace(scriptRe, '')
  return { html: out, questions }
}

export function normalizeHtmlReport(html, fallbackDate = '') {
  if (typeof html !== 'string') return null
  // Pull the declarative question carrier out of the FULL raw HTML first —
  // the agent may place the <section data-report-questions> after </article>
  // (as a sibling), which the article-slice below would otherwise drop.
  const { html: cleaned, questions } = extractReportQuestions(html)
  const article = cleaned.match(/<article\b[\s\S]*?<\/article>/i)
  const body = article ? article[0] : cleaned.trim()
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
  return { date, summary, html: body, headlines: headlines.slice(0, 20), sections: [], questions }
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
