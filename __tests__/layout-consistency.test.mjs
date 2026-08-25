import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('the report home is centered while the reader remains full-bleed', () => {
  assert.match(theme, /\.nw-page[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto/s)
  assert.match(theme, /\.nw-header-shell[^}]*width:\s*100%[^}]*background:\s*var\(--bg\)[^}]*border-bottom:\s*1px solid var\(--border\)/s)
  assert.match(theme, /\.nw-header[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto/s)
  assert.match(theme, /\.nw-reader\s*\{[^}]*position:\s*absolute;\s*inset:\s*0/s)
  assert.match(index, /className="nw-header-shell"/)
  assert.doesNotMatch(index, /immersive\.holdToToggle/)
  assert.doesNotMatch(theme, /radial-gradient\(ellipse 76% 112%/)
})
