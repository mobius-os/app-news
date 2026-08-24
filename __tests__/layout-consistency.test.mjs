import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const theme = readFileSync(new URL('../theme.js', import.meta.url), 'utf8')
const index = readFileSync(new URL('../index.jsx', import.meta.url), 'utf8')

test('the report home is centered while the reader remains full-bleed', () => {
  assert.match(theme, /\.nw-page[^}]*max-width:\s*760px[^}]*margin-inline:\s*auto/s)
  assert.match(theme, /\.nw-reader\s*\{[^}]*position:\s*absolute;\s*inset:\s*0/s)
  assert.match(index, /className="nw-page"/)
})
