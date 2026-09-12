import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateAgentModels, RETIRED_MODEL_IDS } from '../model-selection.mjs'

test('migrates only the five retired ids and is idempotent', () => {
  for (const [retired, current] of Object.entries(RETIRED_MODEL_IDS)) {
    const original = { model: retired, fallback_model: retired, keep: 7 }
    const migrated = migrateAgentModels(original)
    assert.deepEqual(migrated, { model: current, fallback_model: current, keep: 7 })
    assert.equal(migrateAgentModels(migrated), migrated)
  }
  const unknown = { model: 'future-model', fallback_model: 'gpt-5.5' }
  assert.equal(migrateAgentModels(unknown), unknown)
})

test('scheduled migration rewrites the whole settings document once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'news-model-'))
  const path = join(dir, 'agent.json')
  writeFileSync(path, JSON.stringify({ model: 'claude-opus-4-6-20251015', extra: true }))
  assert.equal(execFileSync('python3', ['model_selection.py', path], { encoding: 'utf8' }).trim(), 'changed')
  assert.deepEqual(JSON.parse(readFileSync(path)), { model: 'claude-opus-4-6', extra: true })
  assert.equal(execFileSync('python3', ['model_selection.py', path], { encoding: 'utf8' }).trim(), 'unchanged')
})

test('offline defaults use the current product choices', () => {
  const constants = readFileSync(new URL('../constants.js', import.meta.url), 'utf8')
  assert.match(constants, /claude-opus-4-8/)
  assert.match(constants, /gpt-5\.6-terra/)
})
