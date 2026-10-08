import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const expired = (spec) => JSON.parse(execFileSync(
  'python3', ['report_retention.py', '--expired', JSON.stringify(spec)], { encoding: 'utf8' }))

test('report retention deletes only dated report files older than the window', () => {
  const names = [
    '2026-01-01.html', '2026-01-01.meta.json', '2026-01-01.run.json',
    '2026-07-08.html', '2026-07-09.html', '2026-10-07.html', 'notes.txt', '2026-13-40.html',
  ]
  assert.deepEqual(expired({ names, today: '2026-10-07', keep_days: 90 }), [
    '2026-01-01.html', '2026-01-01.meta.json', '2026-01-01.run.json', '2026-07-08.html',
  ])
})

const recognized = ['html', 'json', 'meta.json', 'run.json']
  .map(suffix => `2026-01-01.${suffix}`)
const preserved = [
  '2026-01-01.html.bak', '2026-01-01.json.backup', '2026-01-01.notes.txt',
  '2026-01-01.meta.json.extra', '2026-01-01.run.json\n', '2026-01-01.HTML',
  '2026-02-30.html', '2025-02-29.json', '0000-01-01.run.json', '2026-13-01.meta.json',
  ...['html', 'json', 'meta.json', 'run.json'].flatMap(suffix => [
    `2026-07-09.${suffix}`, `2026-10-07.${suffix}`, `2027-01-01.${suffix}`,
  ]),
]

test('retention preserves backups, unknown suffixes, invalid dates and the current window', () => {
  assert.deepEqual(expired({ names: [...recognized, ...preserved], today: '2026-10-07' }),
    [...recognized].sort())
})

test('main sends DELETE only for recognized expired report files from the listing', () => {
  const entries = [...recognized, ...preserved].map(name => ({ name, type: 'file' }))
  entries.push({ name: '2026-01-02.html', type: 'directory' })
  const calls = JSON.parse(execFileSync('python3', ['-c', `
import contextlib, io, json, sys
from unittest.mock import patch
import report_retention as retention
entries = json.loads(sys.argv[1])
calls = []
def request(base, token, method, path):
    calls.append([base, token, method, path])
    if method == "GET":
        return {"entries": entries}
    if method == "DELETE":
        return None
    raise AssertionError(method)
with patch.object(retention, "_request", side_effect=request):
    with contextlib.redirect_stdout(io.StringIO()):
        assert retention.main(["retention", "https://example.invalid/", "news", "synthetic-token", "2026-10-07"]) == 0
print(json.dumps(calls))
`, JSON.stringify(entries)], { encoding: 'utf8' }))
  assert.deepEqual(calls, [
    ['https://example.invalid', 'synthetic-token', 'GET', '/api/storage/apps-list/news/reports?limit=500'],
    ...[...recognized].sort().map(name => [
      'https://example.invalid', 'synthetic-token', 'DELETE', `/api/storage/apps/news/reports/${name}`,
    ]),
  ])
})

test('fetch.sh prunes old reports only on the saved-digest path', () => {
  const sh = readFileSync(new URL('../fetch.sh', import.meta.url), 'utf8')
  const call = sh.indexOf('report_retention.py')
  assert.ok(call > sh.indexOf('log "Digest saved'), 'retention runs after the digest is saved')
  assert.ok(call < sh.indexOf('emit_cron_summary "ok"'), 'retention runs before the ok exit')
  assert.equal(sh.split('report_retention.py').length, 2, 'retention runs from exactly one place')
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url), 'utf8'))
  assert.ok(manifest.source_files.includes('report_retention.py'))
})
