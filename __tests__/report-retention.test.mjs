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

test('fetch.sh prunes old reports only on the saved-digest path', () => {
  const sh = readFileSync(new URL('../fetch.sh', import.meta.url), 'utf8')
  const call = sh.indexOf('report_retention.py')
  assert.ok(call > sh.indexOf('log "Digest saved'), 'retention runs after the digest is saved')
  assert.ok(call < sh.indexOf('emit_cron_summary "ok"'), 'retention runs before the ok exit')
  assert.equal(sh.split('report_retention.py').length, 2, 'retention runs from exactly one place')
  const manifest = JSON.parse(readFileSync(new URL('../mobius.json', import.meta.url), 'utf8'))
  assert.ok(manifest.source_files.includes('report_retention.py'))
})
