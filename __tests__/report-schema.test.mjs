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
  extractReportQuestions, sanitizeQuestions,
} from '../report-schema.mjs'

test('HTML sanitizer keeps its wrapper while cleaning report children', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const domain = readFileSync(join(here, '..', 'domain.js'), 'utf8')
  assert.ok(domain.includes("const root = doc.body.querySelector('main')"))
  assert.ok(domain.includes('walk(root)'))
  assert.ok(domain.includes('return root.innerHTML'))
})

test('htmlToText decodes numeric HTML entities (hex + decimal)', () => {
  // Regression: the news agent emits apostrophes as the hex entity &#x27;.
  // Summaries/headlines render as plain text, so the decoder must restore '.
  assert.equal(htmlToText('Iran&#x27;s nuclear sites'), "Iran's nuclear sites")
  assert.equal(htmlToText('the deal&#39;s gaps'), "the deal's gaps")
  assert.equal(htmlToText('A&#x2014;B'), 'A—B')
  assert.equal(htmlToText('R&amp;D rises'), 'R&D rises')
})

test('normalizeHtmlReport summary decodes hex apostrophe entities', () => {
  const html = '<article data-date="2026-06-24"><details class="news-report__summary"><summary>x</summary><p>Iran&#x27;s sites and the deal&#x27;s gaps</p></details></article>'
  const r = normalizeHtmlReport(html)
  assert.equal(r.summary, "Iran's sites and the deal's gaps")
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

// ---- height-bridge: CSP meta + height-reporter script in buildHtmlSrcDoc ----
//
// buildHtmlSrcDoc is defined inside index.jsx (it needs sanitizeReportHtml and
// readReportTheme which depend on DOM APIs). We assert its output by reading
// the raw source and checking that both the CSP meta AND the height-reporter
// script are injected into the <head> of the generated srcdoc, so the iframe
// can report its content height to the parent via postMessage without needing
// allow-same-origin.

test('buildHtmlSrcDoc output contains the CSP meta tag', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'domain.js'), 'utf8')
  // The CSP meta must be present in the buildHtmlSrcDoc template literal.
  // We locate the function's body start and verify the critical lines appear
  // inside the srcdoc template (between the function's opening backtick and
  // the closing </html>).
  const fnStart = src.indexOf('function buildHtmlSrcDoc(')
  assert.ok(fnStart !== -1, 'buildHtmlSrcDoc not found in domain.js')
  const fnBody = src.slice(fnStart, fnStart + 3000)
  assert.ok(
    fnBody.includes('NEWS_REPORT_CSP'),
    'buildHtmlSrcDoc must reference NEWS_REPORT_CSP for the Content-Security-Policy meta',
  )
  assert.ok(
    fnBody.includes('NEWS_REPORT_HEIGHT_SCRIPT'),
    'buildHtmlSrcDoc must inject NEWS_REPORT_HEIGHT_SCRIPT for the height bridge',
  )
})

test('NEWS_REPORT_CSP and NEWS_REPORT_HEIGHT_SCRIPT constants are defined', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'constants.js'), 'utf8')
  assert.ok(src.includes("const NEWS_REPORT_CSP ="), 'NEWS_REPORT_CSP constant must be defined')
  assert.ok(src.includes("const NEWS_REPORT_HEIGHT_SCRIPT ="), 'NEWS_REPORT_HEIGHT_SCRIPT constant must be defined')
})

test('NEWS_REPORT_HEIGHT_SCRIPT posts news:report-height messages', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'constants.js'), 'utf8')
  const scriptStart = src.indexOf('const NEWS_REPORT_HEIGHT_SCRIPT =')
  assert.ok(scriptStart !== -1, 'NEWS_REPORT_HEIGHT_SCRIPT not found')
  // Grab the script body (up to 1200 chars should cover the template literal)
  const scriptBody = src.slice(scriptStart, scriptStart + 1200)
  assert.ok(
    scriptBody.includes("'news:report-height'"),
    "height-reporter must postMessage with type 'news:report-height'",
  )
  assert.ok(
    scriptBody.includes('document.documentElement.getBoundingClientRect().height'),
    'height-reporter must measure the documentElement border-box height (viewport-independent)',
  )
  // scrollHeight is floored at the iframe's own viewport height, so a
  // transient over-measurement mid-reflow (classic scrollbars re-wrapping
  // text) ratchets the iframe taller forever. The reporter must not use it.
  assert.ok(
    !scriptBody.includes('scrollHeight'),
    'height-reporter must NOT use scrollHeight (viewport-floored → ratchet)',
  )
  assert.ok(
    scriptBody.includes('ResizeObserver'),
    'height-reporter must set up a ResizeObserver for dynamic content',
  )
})

test('parent height listener only trusts the report iframe and adds no buffer', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'ui', 'ReportReader.jsx'), 'utf8')
  const onMessageStart = src.indexOf("ev.data.type !== 'news:report-height'")
  assert.ok(onMessageStart !== -1, 'news:report-height listener not found')
  const listenerBody = src.slice(onMessageStart, onMessageStart + 800)
  // The sandboxed iframe has a null origin, so ev.origin can't identify it;
  // ev.source against the iframe's contentWindow is the only spoof guard.
  assert.ok(
    listenerBody.includes('ev.source !== iframeRef.current?.contentWindow'),
    'listener must reject messages whose source is not the report iframe',
  )
  // The reporter already ceils an exact content metric; a +N buffer here
  // re-introduces height creep (each applied buffer re-triggers the
  // ResizeObserver with a slightly larger value).
  assert.ok(
    !listenerBody.includes('h + '),
    'listener must apply the reported height without a buffer',
  )
  // The report iframe element must actually carry the ref the guard checks.
  assert.ok(
    src.includes('ref={iframeRef}'),
    'report iframe must be bound to iframeRef',
  )
})

test('reader scroll container reserves a stable scrollbar gutter', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'theme.js'), 'utf8')
  const ruleStart = src.indexOf('.nw-reader-body {')
  assert.ok(ruleStart !== -1, '.nw-reader-body rule not found')
  const rule = src.slice(ruleStart, src.indexOf('}', ruleStart))
  // Classic (non-overlay) scrollbars shrink the layout width when they
  // appear; without a stable gutter, the height-bridge growing the iframe
  // toggles the scrollbar, re-wraps the text, and feeds back a new height.
  assert.ok(
    rule.includes('scrollbar-gutter: stable'),
    '.nw-reader-body must declare scrollbar-gutter: stable',
  )
})

test('iframe sandbox includes allow-scripts but not allow-same-origin', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'ui', 'ReportReader.jsx'), 'utf8')
  // The sandbox JSX prop on the HTML report iframe must contain allow-scripts
  // (so the injected height-reporter can run) but must NOT contain
  // allow-same-origin (which would expose the shell origin and owner JWT).
  // We look for the sandbox string literal that's actually assigned to the prop.
  const sandboxMatch = src.match(/sandbox=["']([^"']+)["']/)
  assert.ok(sandboxMatch, 'iframe sandbox attribute not found in ui/ReportReader.jsx')
  const sandboxValue = sandboxMatch[1]
  assert.ok(
    sandboxValue.includes('allow-scripts'),
    'iframe sandbox must include allow-scripts for height-reporter',
  )
  assert.ok(
    !sandboxValue.includes('allow-same-origin'),
    'iframe sandbox must NOT include allow-same-origin',
  )
})

// ---- masthead-era schema: reader CSS, sanitizers, and prompt sync ----
//
// v1.10.18 brought the report shell up to the dreaming brief's standard:
// a <header> masthead (kicker + h1), keypoints in the summary card,
// collapsed <details class="news-report__more"> drill-downs for the long
// tail, and dreaming's overflow guards. These tests pin the contract
// across the four files that must move together: index.jsx (reader CSS +
// client sanitizer), report-schema.mjs (headline extraction), fetch.sh
// (server sanitizer + bundled prompt), and system-prompt.md (the schema
// the agent writes against).

const HERE = dirname(fileURLToPath(import.meta.url))
const readRepoFile = (name) => readFileSync(join(HERE, '..', name), 'utf8')

test('masthead h1 joins the extracted headlines', () => {
  const html = `
    <article class="news-report" data-date="2026-06-12">
      <header>
        <p>Daily digest · Friday 12 June 2026</p>
        <h1>Accord redraws data-flow map</h1>
      </header>
      <details class="news-report__summary" open>
        <summary>Today at a glance</summary>
        <p>One line tl;dr.</p>
      </details>
      <section class="news-report__body">
        <h2>World</h2><p>Body text long enough to matter.</p>
      </section>
    </article>
  `
  const r = normalizeHtmlReport(html, '2026-06-12')
  assert.deepEqual(r.headlines, ['Accord redraws data-flow map', 'World'])
  // The summary still comes from the glance card, not the masthead kicker.
  assert.equal(r.summary, 'One line tl;dr.')
})

test('client sanitizer allows the masthead tags (HEADER, H1)', () => {
  const index = readRepoFile('domain.js')
  const allowed = index.match(/const allowed = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(allowed, 'client sanitizer allowlist not found')
  for (const tag of ["'HEADER'", "'H1'", "'DETAILS'", "'SUMMARY'"]) {
    assert.ok(allowed[1].includes(tag), `client sanitizer must allow ${tag}`)
  }
})

test('srcdoc CSS carries the dreaming-grade report styles', () => {
  const index = readRepoFile('domain.js')
  const fnStart = index.indexOf('function buildHtmlSrcDoc(')
  assert.ok(fnStart !== -1)
  const srcdoc = index.slice(fnStart, index.indexOf('</html>', fnStart))
  for (const marker of [
    'article.news-report > header h1',          // masthead headline
    'details.news-report__summary ul li::before', // keypoints accent dots
    'details.news-report__more',                  // long-tail drill-down card
    'overflow-x: hidden',                         // horizontal overflow guard
    '--step-4',                                   // headline tier of the type scale
    ':has(> header h1)',                          // standfirst downscale for new schema
  ]) {
    assert.ok(srcdoc.includes(marker), `srcdoc CSS must include "${marker}"`)
  }
})

test('fetch.sh bundled prompt stays byte-identical to system-prompt.md', () => {
  const fetchSh = readRepoFile('fetch.sh')
  const prompt = readRepoFile('system-prompt.md')
  const heredoc = fetchSh.match(/cat >"\$SYSTEM_FILE" <<'EOF'\n([\s\S]*?)\nEOF\n/)
  assert.ok(heredoc, 'bundled prompt heredoc not found in fetch.sh')
  // The heredoc is the repair copy that reaches already-installed
  // instances (storage seeds are never overwritten on update); if it
  // drifts from the seed, new installs and updated installs generate
  // structurally different reports.
  assert.equal(heredoc[1].trimEnd(), prompt.trimEnd())
})

test('fetch.sh sanitizer understands the masthead-era schema', () => {
  const fetchSh = readRepoFile('fetch.sh')
  // header/h1 must be in the server-side allowed tag set.
  const allowed = fetchSh.match(/allowed = \{([\s\S]*?)\}/)
  assert.ok(allowed, 'server sanitizer allowlist not found')
  for (const tag of ['"header"', '"h1"', '"details"', '"summary"']) {
    assert.ok(allowed[1].includes(tag), `server sanitizer must allow ${tag}`)
  }
  // First details stays the forced-open summary card; later ones become
  // collapsed news-report__more drill-downs.
  assert.ok(fetchSh.includes("clean.append(('class', 'news-report__summary'))"))
  assert.ok(fetchSh.includes("clean.append(('class', 'news-report__more'))"))
  assert.ok(fetchSh.includes('self.summary_emitted'))
  // The stale-prompt repair must re-bake prompts that predate the masthead.
  assert.ok(fetchSh.includes('! grep -q "<header>" "$SYSTEM_FILE"'))
})

// --- Brand mark + editorial-brief restructure (1.10.20) ------------------
// These read index.jsx / topics.txt as text the same way the sync guards
// above do: the brief constants live next to React, so the tests can't
// import them, but the shipped strings still need locking down.

test('top bar pairs the real app icon with a "News" text label', () => {
  const index = readRepoFile('index.jsx')
  const theme = readRepoFile('theme.js')
  // The brand mark is the backend-downscaled icon at ?size=64, kept crisp
  // while the rendered size grew to ~34px.
  assert.ok(
    index.includes('/api/apps/${appId}/icon?size=64'),
    'header must render the real downscaled app icon',
  )
  assert.ok(index.includes('className="nw-brand-icon"'), 'brand icon class missing')
  // The accent-dot fallback for installs whose icon route 404s.
  assert.ok(index.includes('className="nw-brand-fallback"'), 'brand fallback missing')
  // News is the one catalog app that pairs its mark with a text label: the
  // "News" wordmark sits beside the icon inside the brand row.
  assert.ok(
    index.includes('<span className="nw-title">News</span>'),
    '"News" text label must sit beside the icon',
  )
  assert.ok(theme.includes('.nw-title {'), '.nw-title CSS rule must back the wordmark')
  assert.ok(index.includes('className="nw-brand"'), 'icon + label must share the nw-brand row')
})

test('default brief drops the preamble and matches bundled topics.txt', () => {
  const index = readRepoFile('constants.js')
  const topics = readRepoFile('topics.txt')
  const m = index.match(/const DEFAULT_TOPICS = `([\s\S]*?)`/)
  assert.ok(m, 'DEFAULT_TOPICS constant not found')
  const def = m[1]
  // The "This is your editorial brief…" preamble now lives as fixed helper
  // text above the textarea, NOT inside the editable brief.
  assert.ok(
    !def.includes('This is your editorial brief'),
    'preamble must not remain inside the editable brief',
  )
  assert.ok(def.startsWith('Coverage:'), 'brief should open straight into Coverage')
  // The seeded file the installer writes must equal the in-app default so
  // "Reset to default" round-trips to the same text.
  assert.equal(def.trimEnd(), topics.trimEnd())
  // No format/HTML guidance leaks into the user-facing brief.
  assert.ok(!/html|<article|markdown/i.test(def), 'brief must not mention output format')
})

test('fixed helper above the brief carries the framing, no format leak', () => {
  const index = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const note = index.match(/<p className="nw-note">([\s\S]*?)<\/p>/)
  assert.ok(note, 'brief helper paragraph not found')
  const text = note[1]
  assert.ok(/curator reads every morning/i.test(text), 'helper should carry the framing')
  assert.ok(!/html|<article/i.test(text), 'helper must not surface HTML/format instructions')
})

test('reset-detection upgrades every prior seeded default', () => {
  const index = readRepoFile('constants.js')
  const domain = readRepoFile('domain.js')
  // Both the original hard-wrapped seed and the pre-shortened preamble seed
  // must be listed so a never-edited install upgrades to the new default.
  assert.ok(index.includes('const PRIOR_DEFAULT_TOPICS = [LEGACY_DEFAULT_TOPICS, PRE_SHORTENED_DEFAULT_TOPICS]'))
  assert.ok(
    domain.includes('PRIOR_DEFAULT_TOPICS.some((d) => trimmed === d.trim())'),
    'normalizeSeededTopics must compare against every prior default',
  )
  // LEGACY stays the literal original seed (hard-wrapped, with preamble).
  const legacy = index.match(/const LEGACY_DEFAULT_TOPICS = `([\s\S]*?)`/)
  assert.ok(legacy && legacy[1].includes('This is your editorial brief'), 'LEGACY must stay the old literal')
})

test('HTML-generation guidance stays in system-prompt.md only', () => {
  const prompt = readRepoFile('system-prompt.md')
  // The schema/output instructions live here and nowhere user-facing.
  assert.ok(/pure HTML fragment/i.test(prompt), 'system-prompt must own the HTML schema')
  const uiText = [
    'index.jsx', 'constants.js', 'theme.js', 'domain.js', 'storage.js',
    join('ui', 'ReportsTab.jsx'), join('ui', 'ReportReader.jsx'),
    join('ui', 'SettingsTab.jsx'), join('ui', 'ModelPicker.jsx'),
    join('ui', 'ReportQuestions.jsx'), join('ui', 'ChatPanel.jsx'), join('ui', 'Icons.jsx'),
  ].map(readRepoFile).join('\n')
  const topics = readRepoFile('topics.txt')
  assert.ok(!/pure HTML fragment/i.test(uiText), 'HTML schema must not leak into UI text')
  assert.ok(!/html|<article/i.test(topics), 'HTML schema must not leak into the seeded brief')
})

// ---------------------------------------------------------------------------
// In-report question carrier — the agent embeds a declarative <script> carrier
// in the report HTML; the app extracts + strips it (so the iframe never sees
// it) and renders native tap cards whose answers persist for the next run.
// ---------------------------------------------------------------------------

const CARRIER = `<section class="report-questions" data-report-questions>
  <h2>A few questions for next time</h2>
  <p class="rq-note">Your answers guide my next run.</p>
  <script type="application/mobius-questions+json">
  {"version":1,"questions":[
    {"question":"Go deeper on markets?","header":"Coverage","multiSelect":false,
     "options":[{"label":"Yes","description":"more markets"},{"label":"No"}]},
    {"question":"Which beats?","header":"Topics","multiSelect":true,
     "options":[{"label":"AI"},{"label":"Climate"}]}
  ]}
  </script>
</section>`

test('extractReportQuestions parses the carrier and strips it from the HTML', () => {
  const html = `<article class="news-report" data-date="2026-06-17"><p>Body.</p></article>\n${CARRIER}`
  const { html: cleaned, questions } = extractReportQuestions(html)
  assert.equal(questions.length, 2)
  assert.deepEqual(questions[0], {
    question: 'Go deeper on markets?',
    header: 'Coverage',
    multiSelect: false,
    options: [{ label: 'Yes', description: 'more markets' }, { label: 'No' }],
  })
  assert.equal(questions[1].multiSelect, true)
  // Carrier gone; article body intact.
  assert.ok(!/data-report-questions/.test(cleaned), 'section must be stripped')
  assert.ok(!/mobius-questions\+json/.test(cleaned), 'script must be stripped')
  assert.ok(/<article/.test(cleaned) && /Body\./.test(cleaned), 'article body preserved')
})

test('normalizeHtmlReport attaches questions even when the carrier follows </article>', () => {
  const html = `<article class="news-report" data-date="2026-06-17"><details class="news-report__summary"><summary>x</summary><p>Lede.</p></details></article>${CARRIER}`
  const report = normalizeHtmlReport(html, '2026-06-17')
  assert.ok(report, 'report normalizes')
  assert.equal(report.questions.length, 2)
  assert.ok(!/data-report-questions/.test(report.html), 'carrier never reaches report.html')
})

test('a report with no carrier yields an empty questions array', () => {
  const html = `<article data-date="2026-06-17"><p>Lede.</p></article>`
  const { questions } = extractReportQuestions(html)
  assert.deepEqual(questions, [])
  const report = normalizeHtmlReport(html, '2026-06-17')
  assert.deepEqual(report.questions, [])
})

test('a malformed carrier degrades to no questions without throwing', () => {
  const bad = `<section data-report-questions><script type="application/mobius-questions+json">{not json</script></section>`
  const { html: cleaned, questions } = extractReportQuestions(bad)
  assert.deepEqual(questions, [])
  assert.ok(!/data-report-questions/.test(cleaned), 'bad carrier still stripped')
})

test('sanitizeQuestions drops malformed entries and caps counts', () => {
  const arr = [
    { question: '', options: [{ label: 'a' }] },                 // empty question -> drop
    { question: 'Q', options: [] },                              // no options -> drop
    { question: 'Q2', options: [{ label: '' }, { label: 'Ok' }] }, // keeps only 'Ok'
    { question: 'Q3', options: Array.from({ length: 9 }, (_, i) => ({ label: 'o' + i })) },
    { question: 'Q4', options: [{ label: 'x' }] },
    { question: 'Q5', options: [{ label: 'y' }] },               // beyond the 3-question cap
  ]
  const out = sanitizeQuestions(arr)
  assert.equal(out.length, 3, 'caps at 3 questions')
  assert.deepEqual(out[0], { question: 'Q2', header: '', multiSelect: false, options: [{ label: 'Ok' }] })
  assert.equal(out[1].options.length, 6, 'caps options at 6')
})

test('extractReportQuestions ignores an ordinary <section> in the digest', () => {
  const html = `<article><section class="news-report__body"><p>Real body.</p></section></article>`
  const { html: cleaned, questions } = extractReportQuestions(html)
  assert.deepEqual(questions, [])
  assert.ok(/news-report__body/.test(cleaned), 'normal sections untouched')
})
