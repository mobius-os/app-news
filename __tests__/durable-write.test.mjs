// Unit tests for the durableWrite migration: the write helpers must report a
// refused (dead-lettered) write as an ERROR, never a false "Saved", while a
// 'queued' offline write stays durable SUCCESS.
//
// index.jsx imports React, so it can't be loaded directly under node. We
// esbuild-bundle it (React stubbed as an external resolved to an empty shim)
// and import the named test-only exports durableWriteOutcome +
// classifyWriteOutcome. This mirrors the way the app itself is compiled.
//
// Run with: node --test __tests__/durable-write.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')

function resolveEsbuild() {
  const local = join(repo, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild')
  return existsSync(local) ? local : 'esbuild'
}

// Bundle index.jsx into a loadable ESM module. React/react-dom/jsx-runtime are
// stubbed (the helpers under test never touch them) so the module loads headless.
function buildModule() {
  const out = mkdtempSync(join(tmpdir(), 'news-test-'))
  const shim = join(out, 'react-shim.js')
  writeFileSync(shim, 'export const jsx=()=>null; export const jsxs=()=>null; export const Fragment=null; export const createPortal=(node)=>node; export default {}; export const useState=()=>[]; export const useEffect=()=>{}; export const useCallback=(f)=>f; export const useId=()=>"test-id"; export const useMemo=()=>undefined; export const useRef=()=>({current:null});')
  const bundle = join(out, 'news.mjs')
  execFileSync(resolveEsbuild(), [
    join(repo, 'index.jsx'),
    '--bundle', '--format=esm', '--jsx=automatic',
    `--alias:react=${shim}`,
    `--alias:react-dom=${shim}`,
    `--alias:react/jsx-runtime=${shim}`,
    `--outfile=${bundle}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  return bundle
}

const bundlePath = buildModule()
const mod = await import(pathToFileURL(bundlePath).href)
const { durableWriteOutcome, classifyWriteOutcome } = mod

// A faithful stand-in for the runtime's DurableWriteError (matched by .name).
class DurableWriteError extends Error {
  constructor(message, fields = {}) {
    super(message)
    this.name = 'DurableWriteError'
    this.code = fields.code || 'dead_letter'
    this.status = fields.status
    this.path = fields.path
    this.refusedValue = fields.refusedValue
    this.retryable = fields.retryable === true
  }
}

test('exports are wired', () => {
  assert.equal(typeof durableWriteOutcome, 'function', 'durableWriteOutcome exported')
  assert.equal(typeof classifyWriteOutcome, 'function', 'classifyWriteOutcome exported')
})

// (b) 'synced' resolves to a durable SAVED outcome.
test("synced → durable saved, not an error", async () => {
  const durableWrite = async () => ({ durability: 'synced', path: 'topics.txt', writeId: 'w1' })
  const res = await durableWriteOutcome(durableWrite, 'topics.txt', 'brief')
  assert.deepEqual(res, { synced: true })
  const t = classifyWriteOutcome(res)
  assert.equal(t.durable, true)
  assert.equal(t.msg, 'Saved ✓')
})

// (c) 'queued' (offline) is durable SUCCESS — NOT an error, NOT blocked.
test("queued → durable success (offline), not an error", async () => {
  const durableWrite = async () => ({ durability: 'queued', path: 'topics.txt', writeId: 'w2' })
  const res = await durableWriteOutcome(durableWrite, 'topics.txt', 'brief')
  assert.deepEqual(res, { queued: true })
  const t = classifyWriteOutcome(res)
  assert.equal(t.durable, true, 'queued must be durable success')
  assert.equal(t.msg, 'Saved offline — will sync')
})

// (a) a dead-letter REJECTION (413) surfaces an ERROR, never 'saved'.
test('dead_letter 413 reject → error outcome, never saved', async () => {
  const durableWrite = async () => {
    throw new DurableWriteError('rejected (413)', { code: 'dead_letter', status: 413, path: 'topics.txt' })
  }
  const res = await durableWriteOutcome(durableWrite, 'topics.txt', 'too big')
  assert.equal(res.ok, false, 'dead-letter must not be ok')
  assert.equal(res.deadLetter, true)
  assert.equal(res.status, 413)
  assert.equal(res.synced, undefined, 'must NOT carry a synced flag')
  assert.equal(res.queued, undefined, 'must NOT carry a queued flag')
  const t = classifyWriteOutcome(res)
  assert.equal(t.durable, false, 'a refused write is NEVER durable')
  assert.notEqual(t.msg, 'Saved ✓')
  assert.match(t.msg, /rejected/i)
})

// Other fatal dead-letter statuses (400/403) classify the same way.
for (const status of [400, 403]) {
  test(`dead_letter ${status} reject → error outcome`, async () => {
    const durableWrite = async () => {
      throw new DurableWriteError(`rejected (${status})`, { code: 'dead_letter', status })
    }
    const res = await durableWriteOutcome(durableWrite, 'agent.json', { provider: 'x' })
    assert.equal(res.ok, false)
    assert.equal(res.deadLetter, true)
    assert.equal(classifyWriteOutcome(res).durable, false)
  })
}

// A non-DurableWriteError throw (runtime absent / transient bug) is re-thrown
// so putJSON/putText fall through to the direct-fetch path rather than
// silently reporting a lost write.
test('non-DurableWriteError throw is re-thrown (lets direct-fetch fallback run)', async () => {
  const durableWrite = async () => { throw new TypeError('window.mobius vanished') }
  await assert.rejects(
    () => durableWriteOutcome(durableWrite, 'topics.txt', 'x'),
    /window.mobius vanished/,
  )
})

// classifier honesty for the generic lost-write shape (no synced/queued/deadLetter).
test('generic {ok:false} → not durable, generic retry copy', () => {
  const t = classifyWriteOutcome({ ok: false, status: 0 })
  assert.equal(t.durable, false)
  assert.match(t.msg, /try again/i)
})

// The shipped index.jsx must actually route writes through durableWrite and
// wire onDeadLetter once — guard against a regression that reverts to the old
// storage.set / {content} envelope.
test('app routes writes through durableWrite + wires onDeadLetter', () => {
  // Post-modularization the storage layer moved to storage.js (putJSON/putText
  // probe durableWrite there) while the App-level onDeadLetter subscription
  // stays in the index.jsx shell. Read each from its own module.
  const storage = readFileSync(join(repo, 'storage.js'), 'utf8')
  const index = readFileSync(join(repo, 'index.jsx'), 'utf8')
  assert.ok(storage.includes('window.mobius?.durableWrite'), 'putJSON/putText probe durableWrite')
  assert.ok(index.includes('window.mobius?.onDeadLetter'), 'App subscribes to onDeadLetter')
  assert.ok(!storage.includes('native.set'), 'no leftover storage.set write path')
  assert.ok(!storage.includes('{ content: text }') && !storage.includes('{content: text}'),
    'no leftover {content} text envelope (durableWrite writes bare text)')
})
