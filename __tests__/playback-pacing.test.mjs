import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPitchPreservingSpeechOutput } from '../speech-media.js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

test('the speech output reports how much audio is queued ahead of the listener', async () => {
  class FakeParam {
    setValueAtTime(value) { this.value = value }
    cancelScheduledValues() {}
  }
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
  assert.equal(output.bufferedSeconds(), 0)
  output.play(new Float32Array(300), { sampleRate: 100 })
  output.play(new Float32Array(200), { sampleRate: 100 })
  assert.equal(output.bufferedSeconds(), 5)
  context.currentTime = 13
  assert.equal(output.bufferedSeconds(), 2)
  output.dispose()
})

test('News generates section by section and waits at a bounded lead before the next', () => {
  const listen = readFileSync(join(repo, 'ui', 'ListenControls.jsx'), 'utf8')
  assert.match(listen, /\}, \{ maxSegments: 1 \}\)/)
  assert.match(listen, /if \(batchIndex > 0\) await waitForListeningLead\(\)/)
  assert.match(listen, /output\.bufferedSeconds\(\)/)
  assert.ok(listen.indexOf('waitForListeningLead()') < listen.indexOf('await synthesizeSpeech({'),
    'the lead is checked before the next section is requested')
})
