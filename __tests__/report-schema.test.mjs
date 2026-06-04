// Unit tests for the pure report-schema helpers. Run with:
//   node --test __tests__/report-schema.test.mjs
// (No loader needed — report-schema.mjs is React-free.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  normalizeReport, normalizeHtmlReport, htmlToText,
  safeHref, isReportFilename, reportDateFromFilename,
  reportExtFromFilename, buildFeedbackRecord,
} from '../report-schema.mjs'

// Sync guard: index.jsx ships an INLINED copy of these helpers (the
// installer compiles only the entry file, so it can't import the sibling
// .mjs). If the canonical source changes but the inline doesn't, the
// shipped app silently diverges. Assert both function bodies are present
// verbatim (whitespace-normalized) inside index.jsx.
test('inlined schema in index.jsx stays in sync with report-schema.mjs', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const norm = (s) => s.replace(/\s+/g, ' ')
  const index = norm(readFileSync(join(here, '..', 'index.jsx'), 'utf8'))
  // Distinctive body lines that must appear verbatim in the inlined copy.
  // If the canonical logic changes, update report-schema.mjs AND the inline,
  // and refresh these snippets.
  const distinctive = [
    'const parsed = new URL(url.trim())',
    "return typeof name === 'string' && /^\\d{4}-\\d{2}-\\d{2}\\.(html|json)$/.test(name)",
    'return { date, summary, html: body, headlines: headlines.slice(0, 20), sections: [] }',
    'const clean = { headline, summary: artSummary }',
    'return { date, summary, sections }',
    'Array.isArray(report?.headlines)',
    "kind: 'digest_feedback'",
  ]
  for (const snippet of distinctive) {
    assert.ok(index.includes(norm(snippet)), `index.jsx inline drifted: missing "${snippet}"`)
  }
})

test('HTML sanitizer keeps its wrapper while cleaning report children', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const index = readFileSync(join(here, '..', 'index.jsx'), 'utf8')
  assert.ok(index.includes("const root = doc.body.querySelector('main')"))
  assert.ok(index.includes('walk(root)'))
  assert.ok(index.includes('return root.innerHTML'))
})

const SAMPLE = {
  date: '2026-06-02',
  summary: 'Markets steadied while a major chip deal cleared review.',
  sections: [
    {
      title: 'Markets',
      articles: [
        {
          headline: 'Indices recover after volatile open',
          summary: 'Stocks clawed back early losses. Bond yields eased. Watch tomorrow’s jobs print.',
          source_url: 'https://www.reuters.com/markets/example',
        },
      ],
    },
    {
      title: 'Tech',
      articles: [
        {
          // No source_url — the agent couldn't confirm a real link.
          headline: 'Chip merger clears antitrust review',
          summary: 'Regulators signed off. Closes Q3. Rivals weigh appeals.',
        },
      ],
    },
  ],
}

test('parses a well-formed report and keeps a confirmed source_url', () => {
  const r = normalizeReport(SAMPLE, '2026-06-02')
  assert.equal(r.date, '2026-06-02')
  assert.equal(r.sections.length, 2)
  const markets = r.sections[0]
  assert.equal(markets.title, 'Markets')
  assert.equal(markets.articles[0].source_url, 'https://www.reuters.com/markets/example')
})

test('tolerates a missing source_url: article stays, no href key', () => {
  const r = normalizeReport(SAMPLE, '2026-06-02')
  const tech = r.sections[1].articles[0]
  assert.equal(tech.headline, 'Chip merger clears antitrust review')
  assert.equal('source_url' in tech, false)
})

test('drops a fabricated / non-http source_url but keeps the article', () => {
  const r = normalizeReport({
    summary: 'tl;dr',
    sections: [{
      title: 'World',
      articles: [{
        headline: 'H',
        summary: 'S',
        source_url: 'javascript:alert(1)',
      }],
    }],
  })
  assert.equal('source_url' in r.sections[0].articles[0], false)
})

test('falls back to fallbackDate when date is missing or blank', () => {
  const r = normalizeReport({ summary: 'x', sections: [], date: '   ' }, '2099-01-01')
  assert.equal(r.date, '2099-01-01')
})

test('returns null when the top-level summary is missing', () => {
  assert.equal(normalizeReport({ date: '2026-06-02', sections: [] }), null)
  assert.equal(normalizeReport(null), null)
  assert.equal(normalizeReport('not an object'), null)
})

test('drops articles without both headline and summary, and empty sections', () => {
  const r = normalizeReport({
    summary: 'tl;dr',
    sections: [
      { title: 'Empty', articles: [{ headline: 'only headline' }] },
      { title: 'Good', articles: [{ headline: 'H', summary: 'S' }] },
    ],
  })
  assert.equal(r.sections.length, 1)
  assert.equal(r.sections[0].title, 'Good')
})

test('safeHref gates to http(s)', () => {
  assert.equal(safeHref('https://x.com'), 'https://x.com/')
  assert.equal(safeHref('http://x.com'), 'http://x.com/')
  assert.equal(safeHref('  HTTPS://x.com/path  '), 'https://x.com/path')
  assert.equal(safeHref('ftp://x.com'), null)
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('/relative'), null)
  assert.equal(safeHref(undefined), null)
})

test('normalizes HTML reports for current digests', () => {
  const html = `
    <article class="news-report" data-date="2026-06-03">
      <details class="news-report__summary" open>
        <summary>Today at a glance</summary>
        <p>Markets rallied &amp; researchers announced a new battery chemistry.</p>
      </details>
      <section class="news-report__body">
        <h2>Markets rebound</h2>
        <p>Stocks moved higher after policy remarks.</p>
        <h3>Science note</h3>
        <p>A lab said cycle life improved.</p>
      </section>
    </article>
  `
  const r = normalizeHtmlReport(html, '2099-01-01')
  assert.equal(r.date, '2026-06-03')
  assert.equal(r.summary, 'Markets rallied & researchers announced a new battery chemistry.')
  assert.deepEqual(r.headlines, ['Markets rebound', 'Science note'])
  assert.ok(r.html.includes('news-report__body'))
  assert.deepEqual(r.sections, [])
})

test('normalizes HTML reports with fallback date and text fallback', () => {
  const r = normalizeHtmlReport('<article><p>Plain digest paragraph.</p></article>', '2026-06-04')
  assert.equal(r.date, '2026-06-04')
  assert.equal(r.summary, 'Plain digest paragraph.')
})

test('htmlToText strips scripts/styles/tags and decodes common entities', () => {
  assert.equal(
    htmlToText('<style>x</style><p>A &amp; B&nbsp;<script>alert(1)</script><strong>C</strong></p>'),
    'A & B C',
  )
})

test('isReportFilename accepts only ISO-date digest HTML or JSON files', () => {
  assert.equal(isReportFilename('2026-06-03.html'), true)
  assert.equal(isReportFilename('2026-06-03.json'), true)
  assert.equal(reportDateFromFilename('2026-06-03.html'), '2026-06-03')
  assert.equal(reportExtFromFilename('2026-06-03.html'), 'html')
  assert.equal(reportExtFromFilename('2026-06-03.json'), 'json')
  assert.equal(isReportFilename('2026-6-3.json'), false)
  assert.equal(isReportFilename('2026-06-03.meta.json'), false)
  assert.equal(isReportFilename('latest.json'), false)
  assert.equal(isReportFilename('../2026-06-03.json'), false)
  assert.equal(reportDateFromFilename('latest.json'), '')
  assert.equal(reportExtFromFilename('latest.json'), '')
})

test('buildFeedbackRecord stores digest feedback with report context', () => {
  const record = buildFeedbackRecord(
    SAMPLE,
    { signal: 'less_like_this', text: ' Too much markets; more science. ' },
    new Date('2026-06-04T12:00:00Z'),
  )

  assert.equal(record.kind, 'digest_feedback')
  assert.equal(record.app, 'news')
  assert.equal(record.report_date, '2026-06-02')
  assert.equal(record.signal, 'less_like_this')
  assert.equal(record.text, 'Too much markets; more science.')
  assert.equal(record.created_at, '2026-06-04T12:00:00.000Z')
  assert.ok(record.article_headlines.includes('Indices recover after volatile open'))
  assert.ok(record.report_summary.startsWith('Markets steadied'))
})

test('buildFeedbackRecord stores HTML report headlines when present', () => {
  const record = buildFeedbackRecord(
    {
      date: '2026-06-03',
      summary: 'HTML digest summary',
      html: '<article><h2>One</h2></article>',
      headlines: ['One', 'Two'],
      sections: [],
    },
    { signal: 'more_like_this' },
    new Date('2026-06-04T12:00:00Z'),
  )

  assert.deepEqual(record.article_headlines, ['One', 'Two'])
})
