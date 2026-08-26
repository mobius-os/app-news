import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('the report home and opened report share one centered rail', () => {
  assert.match(theme, /\.nw-page[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto/s)
  assert.match(theme, /\.nw-header[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto[^}]*border-bottom:\s*1px solid var\(--border\)/s)
  assert.match(theme, /\.nw-reader\s*\{[^}]*position:\s*absolute;\s*inset:\s*0/s)
  assert.match(theme, /\.nw-reader-split[^}]*width:\s*min\(100%,\s*760px\)[^}]*margin-inline:\s*auto/s)
  assert.match(theme, /\.nw-reader-body[^}]*min-width:\s*0[^}]*width:\s*100%/s)
  assert.match(theme, /\.nw-reader-frame[^}]*width:\s*100%[^}]*max-width:\s*100%/s)
  assert.match(theme, /\.nw-listen-player[^}]*width:\s*min\(100%,\s*760px\)[^}]*margin-inline:\s*auto/s)
  assert.match(index, /className="nw-page"/)
  assert.doesNotMatch(index, /immersive\.holdToToggle/)
  assert.doesNotMatch(theme, /radial-gradient\(ellipse 76% 112%/)
})
