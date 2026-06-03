// Unit tests for the pure report-schema helpers. Run with:
//   node --test __tests__/report-schema.test.mjs
// (No loader needed — report-schema.mjs is React-free.)
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { normalizeReport, safeHref, isReportFilename } from '../report-schema.mjs'

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
    "(url.startsWith('http://') || url.startsWith('https://')) ? url : null",
    "return typeof name === 'string' && /^\\d{4}-\\d{2}-\\d{2}\\.json$/.test(name)",
    'const clean = { headline, summary: artSummary }',
    'return { date, summary, sections }',
  ]
  for (const snippet of distinctive) {
    assert.ok(index.includes(norm(snippet)), `index.jsx inline drifted: missing "${snippet}"`)
  }
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
  assert.equal(safeHref('https://x.com'), 'https://x.com')
  assert.equal(safeHref('http://x.com'), 'http://x.com')
  assert.equal(safeHref('ftp://x.com'), null)
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('/relative'), null)
  assert.equal(safeHref(undefined), null)
})

test('isReportFilename accepts only ISO-date digest JSON files', () => {
  assert.equal(isReportFilename('2026-06-03.json'), true)
  assert.equal(isReportFilename('2026-6-3.json'), false)
  assert.equal(isReportFilename('2026-06-03.meta.json'), false)
  assert.equal(isReportFilename('latest.json'), false)
  assert.equal(isReportFilename('../2026-06-03.json'), false)
})
