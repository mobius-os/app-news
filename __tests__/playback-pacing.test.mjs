import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPitchPreservingSpeechOutput } from '../speech-media.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

class FakeParam {
  setValueAtTime(value) { this.value = value }
  cancelScheduledValues() {}
}

// A speech output over a fake audio clock: tests move `context.currentTime`.
async function fakeSpeechOutput() {
  const context = {
    currentTime: 10,
    sampleRate: 100,
    audioWorklet: { async addModule() {} },
    createBuffer(_channels, length) {
      return { length, copyToChannel() {} }
    },
    createBufferSource() {
      return {
        playbackRate: new FakeParam(),
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      }
    },
  }
  const output = await createPitchPreservingSpeechOutput({
    context,
    destination: {},
    workletUrl: '/speech/pitch.js',
    fetcher: async () => ({ ok: true, async text() { return '' } }),
    BlobClass: class {},
    urlApi: { createObjectURL: () => 'blob:pitch', revokeObjectURL() {} },
    WorkletNode: class {
      constructor() {
        this.parameters = new Map([['playbackRate', new FakeParam()]])
        this.port = {}
      }
      connect() {}
      disconnect() {}
    },
  })
  return { context, output }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('the speech output reports how much audio is queued ahead of the listener', async () => {
  const { context, output } = await fakeSpeechOutput()
  assert.equal(output.bufferedSeconds(), 0)
  output.play(new Float32Array(300), { sampleRate: 100 })
  output.play(new Float32Array(200), { sampleRate: 100 })
  assert.equal(output.bufferedSeconds(), 5)
  context.currentTime = 13
  assert.equal(output.bufferedSeconds(), 2)
  output.dispose()
})

test('a speed change wakes the lead wait so a faster queue does not drain into silence', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { context, output } = await fakeSpeechOutput()
  output.play(new Float32Array(10_000), { sampleRate: 100 }) // 100 s at 1x
  let done = false
  void output.waitForBufferedAtMost(40).then(() => { done = true })
  await settle()
  output.setRate(2) // the queue now drains in 50 s, so the lead is reached at +10 s
  await settle()
  context.currentTime += 9
  t.mock.timers.tick(9_000)
  await settle()
  assert.equal(done, false, 'more than the lead is still queued')
  context.currentTime += 1.1
  t.mock.timers.tick(1_100)
  await settle()
  assert.equal(done, true, 'the wait used the new rate, not its 60 s deadline at 1x')
  output.dispose()
})

test('stopping or aborting releases a pending lead wait at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { output } = await fakeSpeechOutput()
  output.play(new Float32Array(10_000), { sampleRate: 100 })
  const controller = new AbortController()
  let aborted = false
  void output.waitForBufferedAtMost(40, controller.signal).then(() => { aborted = true })
  let stopped = false
  void output.waitForBufferedAtMost(40).then(() => { stopped = true })
  await settle()
  controller.abort()
  await settle()
  assert.equal(aborted, true)
  assert.equal(stopped, false)
  output.stop()
  await settle()
  assert.equal(stopped, true)
  output.dispose()
})

test('News generates section by section and waits at a bounded lead before the next', () => {
  const listen = readFileSync(join(repo, 'ui', 'ListenControls.jsx'), 'utf8')
  assert.match(listen, /\}, \{ maxSegments: 1 \}\)/)
  assert.match(listen, /await output\.waitForBufferedAtMost\(GENERATION_LEAD_SECONDS, controller\.signal\)/)
  assert.ok(listen.indexOf('waitForBufferedAtMost(') < listen.indexOf('await synthesizeSpeech({'),
    'the lead is checked before the next section is requested')
})
