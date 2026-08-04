import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideGenerateOutcome,
  selectRefreshTriggers,
  armCoverBackstop,
  isProxyableReportImageMime,
  isSafeReportImageDataUrl,
} from '../domain.js'
import { isErrorReport } from '../report-schema.mjs'
import { EFFORT_LEVELS, defaultEffort } from '../constants.js'
import {
  STARTER_TOPICS,
  normalizePreferences,
} from '../preferences.js'
import { canReorderAgentSlots, reorderAgentSlots } from '../ui/backgroundAgentOrder.js'
import {
  isTtsModelPackCancellation,
  TTS_MODEL_PACK_STORED_BYTES,
  TTS_MODEL_PACKAGE,
} from '../tts-model-pack.js'
import {
  addSpeechPauses,
  createSpeechTimeline,
  estimateSpeechDuration,
  speechPauseMs,
} from '../speech-timeline.js'
import { createAudioFrameBatcher, createSpeechBoundaryTrimmer } from '../speech-audio.js'
import { createSpeechMediaBridge } from '../speech-media.js'
import { openShellPlayback } from '../shell-playback.js'
import { XN_PTTS_WASM_BYTES, XN_PTTS_WASM_SHA256 } from '../browser-tts-xn-module.js'
import { XN_PTTS_WASM_BASE64_1 } from '../browser-tts-xn-wasm-1.js'
import { XN_PTTS_WASM_BASE64_2 } from '../browser-tts-xn-wasm-2.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const repo = join(HERE, '..')
const readRepoFile = (name) => readFileSync(join(repo, name), 'utf8')

const decodeCodexOutput = (input) => {
  const result = spawnSync('python3', [join(repo, 'codex_output.py')], {
    input,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('Codex output decoder unwraps current item.completed messages', () => {
  const html = '<article class="news-report">\n<p>Today</p>\n</article>'
  const jsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: html },
    }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10 } }),
  ].join('\n')

  assert.equal(decodeCodexOutput(jsonl), html)
  assert.equal(decodeCodexOutput(jsonl).includes('\\n'), false,
    'JSON escapes must become real newlines before HTML extraction')
})

test('Codex output decoder preserves legacy agent-message envelopes', () => {
  const first = JSON.stringify({ type: 'agent_message', message: '<article>' })
  const second = JSON.stringify({ msg: { type: 'agent_message', message: '</article>' } })
  assert.equal(decodeCodexOutput(`${first}\n${second}\n`), '<article></article>')
})

test('Codex output decoder fails closed for unknown JSON transport', () => {
  // This is the regression guard for the visible "\\n" failure: markup in an
  // unrecognized transport event must not be handed to the HTML scanner raw.
  const escapedReport = '<article>\\n<p>transport, not content</p>\\n</article>'
  const jsonl = JSON.stringify({
    type: 'item.completed',
    item: { type: 'reasoning', text: escapedReport },
  })
  assert.equal(decodeCodexOutput(jsonl), '')
})

test('Codex output decoder keeps plain-text compatibility without JSON transport', () => {
  const html = '<article>\n<p>legacy plain output</p>\n</article>'
  assert.equal(decodeCodexOutput(html), html)
})

test('fetch.sh decodes Codex transport before scanning for report HTML', () => {
  const sh = readRepoFile('fetch.sh')
  assert.ok(sh.includes('from codex_output import extract_codex_agent_text'))
  assert.ok(sh.includes('text = extract_codex_agent_text(raw)'))
  assert.ok(!sh.includes('msg = obj.get("msg", obj)'),
    'the obsolete envelope-specific inline parser must not return')
})

test('first-run topic suggestion is global and concrete without regional assumptions', () => {
  assert.match(STARTER_TOPICS, /global events/i)
  assert.match(STARTER_TOPICS, /technology and AI/i)
  assert.match(STARTER_TOPICS, /productivity/i)
  assert.doesNotMatch(STARTER_TOPICS, /\bUK\b|Bosnia|Arsenal/i)
  const setup = readRepoFile(join('ui', 'SetupFlow.jsx'))
  assert.ok(setup.includes('STARTER_TOPICS'))
  assert.ok(setup.includes('topicsFirstFocusRef'))
  assert.ok(setup.includes('event.target.select()'))
})

test('listening setup explains languages without asking the user to choose one', () => {
  const fields = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.match(fields, /English Alba voice[\s\S]*French[\s\S]*German[\s\S]*Spanish[\s\S]*Portuguese[\s\S]*Italian/)
  assert.match(fields, /Off\. Nothing is downloaded\./)
  assert.match(fields, /Download voice · 154 MB/)
  assert.match(fields, /154 MB on each device/)
  assert.match(fields, /Nothing is stored on the server/)
  assert.equal((fields.match(/nw-privacy-note/g) || []).length, 0)
  assert.match(fields, /!value\.tts\.enabled \? \(/)
  assert.equal(manifest.storage_seeds['preferences.json'].tts.enabled, false)
  assert.equal(Object.hasOwn(manifest.storage_seeds['preferences.json'].tts, 'engine'), false)
  assert.ok(!fields.includes('nw-tts-language'))
  const normalized = normalizePreferences({
    tts: { enabled: true, language: 'french_24l', voice: 'estelle' },
  })
  assert.equal(normalized.tts.language, 'english')
  assert.equal(normalized.tts.voice, 'alba')
})

test('source preferences stay concise and their text remains selectable', () => {
  const fields = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  const theme = readRepoFile('theme.js')
  assert.match(fields, /nw-choice-grid/)
  assert.match(fields, />Include:<\/label>/)
  assert.match(fields, />Exclude:<\/label>/)
  assert.doesNotMatch(fields, /Coverage mix|Always look for|Avoid or ignore|For example:/)
  assert.match(theme, /nw-source-inputs \.nw-text-input[\s\S]*user-select: text/)
})

test('device-asset lifecycle cancellations reset quietly instead of appearing as TTS failures', () => {
  assert.equal(isTtsModelPackCancellation({ name: 'AbortError' }), true)
  assert.equal(isTtsModelPackCancellation({ code: 'aborted' }), true)
  assert.equal(isTtsModelPackCancellation({ message: 'Device asset operation cancelled.' }), true)
  assert.equal(isTtsModelPackCancellation(new Error('checksum mismatch')), false)
  const setup = readRepoFile(join('ui', 'SetupFlow.jsx'))
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(setup, /isTtsModelPackCancellation\(caught\)/)
  assert.match(settings, /isTtsModelPackCancellation\(caught\)/)
  assert.match(listen, /isTtsModelPackCancellation\(caught\)/)
})

test('News has one clear editorial brief rather than hidden prompt additions', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const fetch = readRepoFile('fetch.sh')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.doesNotMatch(settings, /Advanced|prompt-additions/)
  assert.doesNotMatch(fetch, /prompt-additions|Advanced system prompt additions/)
  assert.equal(Object.hasOwn(manifest.storage_seeds, 'prompt-additions.txt'), false)
})

test('scheduled News runs use only their supervised app authority', () => {
  const fetch = readRepoFile('fetch.sh')
  assert.ok(fetch.includes('AUTH_TOKEN="${APP_TOKEN:-}"'))
  assert.ok(fetch.includes('unset APP_TOKEN'))
  assert.ok(fetch.includes(`/api/apps/$APP_ID/job-context`))
  assert.doesNotMatch(fetch, /service-token\.txt|resolve_background_agents|\/data\/platform\/backend/)
})

test('report listening resumes audio in the tap before loading browser speech', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('await context.resume()'))
  assert.ok(listen.includes('await engine.load({'))
  assert.ok(
    listen.indexOf('await context.resume()') < listen.indexOf('await engine.load({'),
    'mobile audio context must resume before the network await',
  )
  assert.ok(listen.includes('engine.generate(parts[index].text'))
  assert.doesNotMatch(listen, /speechBackend|speechMetrics|PerformanceObserver/)
})

test('Pocket TTS has one XN Q8 Wasm worker and no page or engine fallback', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const browser = readRepoFile('browser-tts.js')
  const worker = readRepoFile('browser-tts-worker-entry.js')
  const embeddedRuntime = readRepoFile('browser-tts-xn-module.js')
  const digestJob = readRepoFile('fetch.sh')
  const notices = readRepoFile('THIRD_PARTY_NOTICES.md')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.ok(listen.includes("from '../browser-tts.js'"))
  assert.ok(browser.includes("from './browser-tts-worker-source.js'"))
  assert.ok(browser.includes('streamTtsModelPack({'))
  assert.ok(browser.includes('new Worker(this.workerUrl)'))
  assert.doesNotMatch(browser, /new Worker\([^\n]+type: 'module'/)
  assert.ok(browser.includes('offset: value.offset'))
  assert.ok(worker.includes("new runtime.Model(completedAssets.get('model'), 'q8')"))
  assert.ok(worker.includes('WebAssembly.validate(wasmBytes)'))
  assert.ok(worker.includes('WebAssembly.compile(wasmBytes)'))
  assert.ok(browser.includes('XN_PTTS_WASM_BASE64_1'))
  assert.ok(browser.includes('XN_PTTS_WASM_BASE64_2'))
  assert.ok(browser.includes('runtimeWasmBase64Parts:'))
  assert.match(embeddedRuntime, /Wasm SHA-256: 83a0cd64fe133a146714ae7a8dd369cb26b19e9a0b0b2732e963a024795b5a79/)
  assert.ok(worker.includes('bytes: new Uint8Array(expected)'))
  assert.ok(worker.includes('state.bytes.set(bytes, offset)'))
  assert.doesNotMatch(worker, /joinChunks/)
  assert.ok(worker.includes("post('audio'"))
  assert.doesNotMatch(worker, /fetch\s*\(/)
  assert.doesNotMatch(browser, /onnx|jax|load-on-page|pageRuntime/i)
  assert.doesNotMatch(listen, /preferences\.tts\.engine|onnxSpeechEngine|engine selector/i)
  assert.match(notices, /LaurentMazare\/xn-ptts[\s\S]*4398678425e1b3d48d525024257830aec989bc58/)
  assert.match(notices, /8ae65694efd3658de4cfdbef5fc8aca833248d1c/)
  assert.match(notices, /c2d23606a738c5afb5e24e44f9d2f5d6af1b4528/)
  assert.match(notices, /Creative Commons Attribution 4\.0/)
  assert.doesNotMatch(listen + browser + worker, /requestAdapter|navigator\.gpu|WebGPU|shader-f16/)
  assert.doesNotMatch(listen + browser, /\/services\/|fetch\([^)]*["'`]\/speech\//)
  assert.doesNotMatch(digestJob, /torch|numpy|scipy|pip install/i)
  assert.doesNotMatch(digestJob, /Pocket TTS|model\.safetensors|install-request/)
  assert.ok(manifest.source_files.includes('tts-model-pack.js'))
  assert.ok(manifest.source_files.includes('browser-tts-worker-source.js'))
  assert.ok(manifest.source_files.includes('browser-tts-xn-module.js'))
  assert.ok(manifest.source_files.includes('browser-tts-xn-wasm-1.js'))
  assert.ok(manifest.source_files.includes('browser-tts-xn-wasm-2.js'))
  assert.equal(manifest.source_files.some((name) => /onnx|jax|streaming-gzip/.test(name)), false)
  assert.equal(manifest.capabilities['device.asset-cache'].version, 1)
  assert.equal(manifest.capabilities['device.asset-cache'].limits.max_bytes, 402_653_184)
  assert.equal(manifest.capabilities['device.asset-cache'].limits.max_chunk_bytes, 8_388_608)
  assert.equal(manifest.schedule.job, 'fetch.sh')
  assert.equal(manifest.schedule.default, '0 10 * * *')
})

test('Pocket TTS pack is an explicit, checksum-pinned per-device download', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const setup = readRepoFile(join('ui', 'SetupFlow.jsx'))
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const browser = readRepoFile('browser-tts.js')
  const pack = readRepoFile('tts-model-pack.js')
  assert.ok(listen.includes('const engine = browserSpeechEngine()'))
  assert.doesNotMatch(browser, /sharedEngineKey|browserSpeechEngine\(appId, token\)/,
    'device-only speech must not retain credentials from the removed server-backed path')
  assert.ok(listen.includes('await engine.load({'))
  assert.ok(setup.includes('await prepareTtsModelPack({'))
  assert.ok(settings.includes('await prepareTtsModelPack({'))
  assert.match(settings, /useState\(\{ state: 'idle', progress: 0, message: '' \}\)/,
    'an optional browser cache probe must never block Settings behind a checking state')
  const finishBody = setup.slice(setup.indexOf('const finish = async'), setup.indexOf('if (loading)'))
  assert.doesNotMatch(finishBody, /prepareTtsModelPack|run-job/,
    'Finish setup must not silently start the optional download')
  assert.ok(browser.includes('streamTtsModelPack({'))
  assert.ok(pack.includes("TTS_DEVICE_ASSET_CAPABILITY = 'device.asset-cache'"))
  assert.ok(pack.includes("openPackage('install')"))
  assert.doesNotMatch(pack, /Authorization|\/api\/storage\/apps/,
    'legacy cleanup must use app storage rather than retain a raw token path')
  assert.ok(pack.includes("removeLegacyDevicePack('pocket-tts-alba-onnx-int8-worker-v1')"))
  assert.ok(pack.includes("removeLegacyDevicePack('pocket-tts-alba-jax-fp16-v1')"))
  assert.ok(
    pack.indexOf("removeLegacyDevicePack('pocket-tts-alba-onnx-int8-worker-v1')")
      < pack.indexOf("const session = openPackage('install')"),
    'the expendable ONNX preview is removed before installing the winning engine',
  )
  assert.ok(
    pack.indexOf("const session = openPackage('install')")
      < pack.lastIndexOf("removeLegacyDevicePack('pocket-tts-alba-jax-fp16-v1')"),
    'the old working JAX package is preserved until XN installs successfully',
  )
  assert.doesNotMatch(pack, /completedBytes/, 'model streaming must not reference an undeclared counter')
  assert.equal(TTS_MODEL_PACK_STORED_BYTES, 153_672_532)
  assert.equal(TTS_MODEL_PACKAGE.key, 'pocket-tts-alba-xn-q8-worker-v1')
  assert.equal(TTS_MODEL_PACKAGE.assets.length, 5)
  assert.equal(TTS_MODEL_PACKAGE.assets.find((asset) => asset.id === 'model').chunks.length, 18)
  assert.equal(
    TTS_MODEL_PACKAGE.assets.reduce((total, asset) => total + asset.bytes, 0),
    TTS_MODEL_PACK_STORED_BYTES,
  )
  assert.equal(TTS_MODEL_PACKAGE.assets.every((asset) => (
    asset.chunks.every((chunk) => chunk.bytes <= 8_388_608 && /^[a-f0-9]{64}$/.test(chunk.sha256))
  )), true)
  assert.match(TTS_MODEL_PACKAGE.assets.find((asset) => asset.id === 'model').url, /lmz\/pocket-tts-without-voice-cloning-q8/)
  assert.match(TTS_MODEL_PACKAGE.assets.find((asset) => asset.id === 'runtime-wasm').url, /8ae65694efd3658de4cfdbef5fc8aca833248d1c/)
  assert.match(pack, /0 MB|server/)
  const preferences = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  assert.ok(preferences.includes('154 MB on each device'))
  assert.doesNotMatch(settings + preferences, /preview|engine choice|onnx|jax/i)
})

test('wall-clock settings update the ordinary app schedule directly', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.ok(settings.includes('/schedule.json'))
  assert.ok(settings.includes('{ ...nextSchedule, timezone, cron }'))
  assert.match(settings, /\/api\/apps\/\$\{appId\}\/schedule/)
  assert.ok(settings.includes('buildCron(nextSchedule.hour, nextSchedule.minute)'))
  assert.ok(settings.includes("job: 'fetch.sh'"))
  assert.ok(settings.includes('saveSchedule(next)'))
  assert.doesNotMatch(settings, />Save schedule</)
  assert.doesNotMatch(settings, /nw-settings-heading-row/)
  assert.ok(settings.indexOf('aria-label="Daily digest time"') < settings.indexOf("{runNowBusy ? 'Running…' : 'Run now'}"))
})

test('report listening preserves editorial structure with player-owned pauses', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes("header > p, h1, details > summary, h2, h3, p, li, blockquote, .callout, figcaption"))
  assert.ok(listen.includes("element.matches('figcaption')"))
  assert.ok(listen.includes('schedulePause(parts[index].pauseMs)'))
  assert.ok(listen.includes('nextAtRef.current +='))
  assert.doesNotMatch(listen, /replace\(\/.+?<[^>]+>/,
    'speech structure must not regress to flattening report HTML with a tag regex')
})

test('the warm News frame reuses its hydrated voice until that frame unmounts', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const resetStart = listen.indexOf('const resetPlayback = useCallback')
  const cleanupStart = listen.indexOf('useEffect(() => () => {', resetStart)
  const resetBody = listen.slice(resetStart, cleanupStart)
  assert.doesNotMatch(resetBody, /releaseBrowserSpeechEngine/)
  const cleanupBody = listen.slice(cleanupStart, listen.indexOf('}, [resetPlayback])', cleanupStart))
  assert.doesNotMatch(cleanupBody, /releaseBrowserSpeechEngine/)
  assert.match(listen, /catch \(caught\)[\s\S]*releaseBrowserSpeechEngine\(\)/)
  assert.doesNotMatch(listen, /moebius:frame-visibility/)
})

test('semantic elements own one direct pause policy', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('addSpeechPauses(parts)'))
  assert.ok(listen.includes("kind = 'section-end'"))
  assert.equal(speechPauseMs('title', 'paragraph'), 600)
  assert.equal(speechPauseMs('section', 'subsection'), 600)
  assert.equal(speechPauseMs('paragraph', 'paragraph'), 240)
  assert.equal(speechPauseMs('paragraph', 'list'), 240)
  assert.equal(speechPauseMs('list', 'list'), 150)
  assert.equal(speechPauseMs('list', 'paragraph'), 240)
  assert.equal(speechPauseMs('section-end', 'paragraph'), 600)
  assert.deepEqual(addSpeechPauses([
    { text: 'Items', kind: 'section' },
    { text: 'One', kind: 'list' },
    { text: 'Two', kind: 'list' },
    { text: 'Next', kind: 'paragraph' },
  ]).map((part) => part.pauseMs), [600, 150, 240, 240])
})

test('streaming speech keeps enough scheduling lead to recover smoothly', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('INITIAL_AUDIO_LEAD_SECONDS = 0.65'))
  assert.ok(listen.includes('RECOVERY_AUDIO_LEAD_SECONDS = 0.15'))
})

test('native media bridge owns streamed output and lock-screen controls', async () => {
  const track = { stopped: false, stop() { this.stopped = true } }
  const stream = { getTracks: () => [track] }
  const destination = { stream }
  const context = {
    state: 'running',
    createMediaStreamDestination: () => destination,
    async suspend() { this.state = 'suspended' },
    async resume() { this.state = 'running' },
  }
  const element = {
    srcObject: null,
    playCount: 0,
    pauseCount: 0,
    async play() { this.playCount += 1 },
    pause() { this.pauseCount += 1 },
  }
  const handlers = new Map()
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) { handlers.set(action, handler) },
  }
  const audioSession = { type: 'auto' }
  const actions = []
  const bridge = createSpeechMediaBridge({
    context,
    element,
    metadata: { title: 'Daily digest' },
    navigatorObject: { mediaSession, audioSession },
    Metadata: class { constructor(value) { Object.assign(this, value) } },
    onPlay: () => actions.push('play'),
    onPause: () => actions.push('pause'),
    onStop: () => actions.push('stop'),
  })

  assert.equal(bridge.destination, destination)
  assert.equal(element.srcObject, stream)
  assert.equal(audioSession.type, 'playback')
  assert.equal(mediaSession.metadata.title, 'Daily digest')
  await bridge.start()
  assert.equal(mediaSession.playbackState, 'playing')
  await bridge.pause()
  assert.equal(context.state, 'suspended')
  assert.equal(mediaSession.playbackState, 'paused')
  await bridge.resume()
  assert.equal(element.playCount, 2)
  handlers.get('play')()
  handlers.get('pause')()
  handlers.get('stop')()
  await Promise.resolve()
  assert.deepEqual(actions, ['play', 'pause', 'stop'])
  bridge.finish()
  assert.equal(mediaSession.playbackState, 'none')
  bridge.dispose()
  assert.equal(element.srcObject, null)
  assert.equal(track.stopped, true)
  assert.equal(audioSession.type, 'auto')
  assert.equal(mediaSession.metadata, null)
  for (const action of ['play', 'pause', 'stop']) assert.equal(handlers.get(action), null)
})

test('a stale News frame does not clear another player’s media session', () => {
  const handlers = new Map()
  const mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action, handler) { handlers.set(action, handler) },
  }
  const element = {
    srcObject: null,
    async play() {},
    pause() {},
  }
  const bridge = createSpeechMediaBridge({
    context: {
      state: 'running',
      createMediaStreamDestination: () => ({ stream: { getTracks: () => [] } }),
    },
    element,
    metadata: { title: 'News' },
    navigatorObject: { mediaSession },
    Metadata: class { constructor(value) { Object.assign(this, value) } },
  })
  const otherMetadata = { title: 'Another player' }
  const otherPlay = () => {}
  mediaSession.metadata = otherMetadata
  mediaSession.setActionHandler('play', otherPlay)

  bridge.dispose()

  assert.equal(mediaSession.metadata, otherMetadata)
  assert.equal(handlers.get('play'), otherPlay)
})

test('shell playback accepts controls only from its parent and closes exactly once', async () => {
  const posted = []
  const listeners = new Set()
  const parent = {
    postMessage(message, origin) { posted.push({ message, origin }) },
  }
  const ownWindow = {
    parent,
    location: { origin: 'https://mobius.test' },
    addEventListener(type, listener) { if (type === 'message') listeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener) },
  }
  const actions = []
  const playback = openShellPlayback({
    title: ' Daily digest ',
    onControl: action => actions.push(action),
    ownWindow,
  })
  const id = posted[0].message.sessionId
  assert.deepEqual(posted[0], {
    origin: 'https://mobius.test',
    message: {
      type: 'moebius:media-session', event: 'open', sessionId: id,
      title: 'Daily digest', playbackState: 'loading',
    },
  })

  const dispatch = (source, origin, action, session = id) => {
    for (const listener of listeners) listener({
      source, origin,
      data: { type: 'moebius:media-control', sessionId: session, action },
    })
  }
  dispatch({}, 'https://mobius.test', 'pause')
  dispatch(parent, 'https://attacker.test', 'pause')
  dispatch(parent, 'https://mobius.test', 'pause', 'stale')
  dispatch(parent, 'https://mobius.test', 'seek')
  dispatch(parent, 'https://mobius.test', 'pause')
  await Promise.resolve()
  assert.deepEqual(actions, ['pause'])

  playback.setState('paused')
  playback.setState('invalid')
  playback.close()
  playback.close()
  assert.equal(posted.filter(({ message }) => message.event === 'update').length, 1)
  assert.equal(posted.filter(({ message }) => message.event === 'close').length, 1)
  assert.equal(listeners.size, 0)
})

test('embedded XN runtime bytes match the reviewed checksum', () => {
  const bytes = Buffer.from(`${XN_PTTS_WASM_BASE64_1}${XN_PTTS_WASM_BASE64_2}`, 'base64')
  assert.equal(bytes.byteLength, XN_PTTS_WASM_BYTES)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), XN_PTTS_WASM_SHA256)
  assert.equal(WebAssembly.validate(bytes), true)
  const embedScript = readRepoFile(join('scripts', 'embed-xn-runtime.mjs'))
  assert.match(embedScript, /const EXPECTED_WASM_SHA256 = '83a0cd64fe133a146714ae7a8dd369cb26b19e9a0b0b2732e963a024795b5a79'/)
  assert.match(embedScript, /sha256 !== EXPECTED_WASM_SHA256/)
})

test('short model frames are batched without changing their sample order', () => {
  const batches = []
  const batcher = createAudioFrameBatcher({
    targetSamples: 5,
    onBatch: (samples) => batches.push([...samples]),
  })
  assert.equal(batcher.push(Float32Array.from([1, 2])), 0)
  assert.equal(batcher.pendingSamples, 2)
  assert.equal(batcher.push(Float32Array.from([3, 4, 5])), 5)
  assert.deepEqual(batches, [[1, 2, 3, 4, 5]])
  batcher.push(Float32Array.from([6, 7]))
  assert.equal(batcher.flush(), 2)
  assert.deepEqual(batches, [[1, 2, 3, 4, 5], [6, 7]])
  assert.equal(batcher.pendingSamples, 0)
})

test('model boundary silence is trimmed while speech padding is preserved', () => {
  const output = []
  const trimmer = createSpeechBoundaryTrimmer({
    sampleRate: 1_000,
    threshold: 0.01,
    windowMs: 10,
    leadingPaddingMs: 20,
    trailingPaddingMs: 30,
    trailingHoldMs: 100,
    onSamples: (samples) => output.push(...samples),
  })
  trimmer.push(new Float32Array(80))
  trimmer.push(Float32Array.from([
    ...new Array(40).fill(0),
    ...new Array(80).fill(0.25),
  ]))
  trimmer.push(Float32Array.from([
    ...new Array(40).fill(0.25),
    ...new Array(160).fill(0),
  ]))
  trimmer.flush()
  assert.equal(output.length, 170)
  assert.equal(output.slice(0, 20).every((sample) => sample === 0), true)
  assert.equal(output.slice(20, 140).every((sample) => sample === 0.25), true)
  assert.equal(output.slice(140).every((sample) => sample === 0), true)
})

test('independent speech prompts fade to zero at both joins', () => {
  const output = []
  const trimmer = createSpeechBoundaryTrimmer({
    sampleRate: 1_000,
    threshold: 0.01,
    windowMs: 2,
    fadeMs: 4,
    leadingPaddingMs: 0,
    trailingPaddingMs: 0,
    trailingHoldMs: 20,
    onSamples: (samples) => output.push(...samples),
  })
  trimmer.push(new Float32Array(30).fill(0.25))
  trimmer.flush()
  assert.equal(output[0], 0)
  assert.equal(output.at(-1), 0)
  assert.equal(output.some((sample) => sample === 0.25), true)
})

test('streaming playback batches audio while XN yields inside its worker', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const worker = readRepoFile('browser-tts-worker-entry.js')
  assert.ok(listen.includes('AUDIO_BATCH_SECONDS = 0.32'))
  assert.ok(listen.includes('PROGRESS_TICK_MS = 250'))
  assert.ok(listen.includes('audioBatcher.push(samples)'))
  assert.ok(listen.includes('audioBatcher.flush()'))
  assert.ok(listen.includes('createSpeechBoundaryTrimmer'))
  assert.ok(listen.includes('window.setTimeout(updateProgress, PROGRESS_TICK_MS)'))
  assert.doesNotMatch(listen, /requestAnimationFrame\(animate\)/)
  assert.ok(worker.includes('if (steps % 4 === 0) await new Promise'))
})

test('report agent owns spoken forms and descriptive image captions enter listening', () => {
  const prompt = readRepoFile('system-prompt.md')
  const fetch = readRepoFile('fetch.sh')
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(prompt, /report agent—not app-side text replacement/i)
  assert.match(prompt, /Describe what the image visibly shows/)
  assert.match(prompt, /caption is visible and is read aloud/i)
  assert.match(prompt, /must also read naturally aloud/i)
  assert.match(prompt, /copies the full visible date.*including the weekday/i)
  assert.match(prompt, /Headline:[\s\S]*every proper noun, initialism, compact amount or range/i)
  assert.match(prompt, /Remaining blocks:[\s\S]*every block from top to bottom/i)
  assert.match(prompt, /one exact full-headline hint/i)
  assert.match(prompt, /punctuation-heavy titles, product phrases, and unusual people or place names/)
  assert.ok(fetch.includes('application/mobius-speech+json'))
  assert.match(fetch, /any inert speech or questions carriers permitted by the system prompt/)
  assert.doesNotMatch(fetch, /and end with <\/article>/)
  assert.ok(listen.includes('applySpeechHints'))
  assert.doesNotMatch(prompt + fetch + listen, /speechPauses|pauseStrength|raw_pauses/)
  assert.doesNotMatch(listen, /normalizeSpeechText/)
})

test('streaming progress is honest and aligned inside the player copy', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const browserTts = readRepoFile('browser-tts.js')
  const pack = readRepoFile('tts-model-pack.js')
  const theme = readRepoFile('theme.js')
  assert.ok(listen.includes("streamReady && duration > 0"))
  assert.ok(listen.includes("${durationExact ? '' : '~'}${clock(duration)}"))
  assert.ok(listen.includes("loadingState.stage === 'reading' ? 'Opening saved voice…'"))
  assert.ok(listen.includes("loadingState.stage === 'preparing' ? 'Preparing saved voice…'"))
  assert.ok(listen.includes("loadingState.stage === 'generating' ? 'Generating first audio…'"))
  assert.ok(listen.includes("loadingState.stage === 'starting' ? 'Starting saved voice…'"))
  assert.ok(listen.includes('Starting the local speech engine'))
  assert.ok(listen.includes('opening the saved voice locally · no download'))
  assert.ok(listen.includes('Preparing the saved voice locally · no download'))
  assert.ok(listen.includes('progressRef.current = Math.max('))
  assert.ok(listen.includes("nw-listen-track${streamReady || loadingDeterminate ? '' : ' is-building'}"))
  assert.ok(listen.includes('role="progressbar"'))
  assert.match(browserTts, /onProgress: \(percent\) => \{[\s\S]*stage: 'reading', percent/)
  assert.ok(browserTts.includes("onProgress?.({ stage: 'starting', percent: 0 })"))
  assert.ok(browserTts.includes('START_TIMEOUT_MS'))
  assert.ok(browserTts.includes('CHUNK_TIMEOUT_MS'))
  assert.ok(pack.includes('session.ready'))
  assert.ok(browserTts.includes('The speech worker took too long to open the saved model.'))
  assert.ok(browserTts.includes("stage: 'preparing'"))
  assert.doesNotMatch(browserTts, /percent < 90 \? 89 : percent/)
  assert.doesNotMatch(listen, /preparing \$\{prepared\.current\} of \$\{prepared\.total\}/)
  assert.ok(!listen.includes('setPrepared('))
  assert.ok(theme.includes('.nw-listen-copy { display: block; min-width: 0; flex: 1; }'))
  assert.ok(theme.includes('position: relative; display: block; width: 100%; height: 3px'))
  assert.match(theme, /nw-tts-setup-copy span[\s\S]*flex: 0 0 4ch[\s\S]*text-align: right/)
})

test('playback completion has one finalizer for every stream ending order', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(listen, /const finishPlayback = \(\) =>/)
  assert.equal((listen.match(/setPhase\('finished'\)/g) || []).length, 1)
  assert.ok((listen.match(/finishPlayback\(\)/g) || []).length >= 2)
})

test('speech duration starts as a whole-report estimate and learns from generated audio', () => {
  const parts = [
    { text: 'A concise title', pauseMs: 900 },
    { text: 'Twenty five ordinary spoken words make this paragraph long enough to calibrate the current voice without trusting a short title as the entire speaking rate.', pauseMs: 420 },
    { text: 'A final paragraph remains to be spoken.', pauseMs: 0 },
  ]
  const initial = estimateSpeechDuration(parts)
  const timeline = createSpeechTimeline(parts)
  assert.equal(timeline.initialDuration, initial)
  const afterTitle = timeline.completePart(0, 1.6, 2.5)
  assert.ok(afterTitle > 2.5, 'the total must include every remaining block')
  const afterParagraph = timeline.completePart(1, 12, 14.92)
  assert.ok(afterParagraph >= 14.92, 'a calibrated estimate cannot end before queued audio')
  assert.ok(Number.isFinite(afterParagraph))
})

test('XN generation keeps benchmark instrumentation out of the listening path', () => {
  const worker = readRepoFile('browser-tts-worker-entry.js')
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.doesNotMatch(worker + listen,
    /firstAudioMs|audioDuration|realtime|performance\.now|longTask|page stalls/)
  assert.ok(worker.includes("post('generate-complete', { requestId })"))
})

// --- Blocker 1: "Generate report now" must terminate on a run-status terminal,
// even when a preserved good digest leaves reports/<today>.html (and thus its
// mtime) untouched. These EXECUTE the extracted terminal-detection decision;
// they would fail if the "stuck forever" bug were present.

test('decideGenerateOutcome: absent run.json falls back to the mtime heuristic', () => {
  assert.deepEqual(decideGenerateOutcome(null, { finishedAt: null }), { kind: 'no-run-json' })
  assert.deepEqual(decideGenerateOutcome(undefined, {}), { kind: 'no-run-json' })
})

test('decideGenerateOutcome: a run in flight (null finished_at) keeps polling', () => {
  const running = { started_at: '2026-07-07T07:00:00Z', finished_at: null, status: 'running' }
  assert.equal(decideGenerateOutcome(running, { finishedAt: null }).kind, 'running')
})

test('decideGenerateOutcome: a terminal equal to the baseline is not a new completion', () => {
  // The morning run's finished_at is the baseline; until the evening rerun
  // writes a DIFFERENT finished_at, the poll must keep waiting, not mis-fire.
  const stale = { started_at: 't', finished_at: '2026-07-07T07:05:00Z', status: 'ok' }
  assert.equal(decideGenerateOutcome(stale, { finishedAt: '2026-07-07T07:05:00Z' }).kind, 'running')
})

test('decideGenerateOutcome: a preserved-digest failure terminates with an honest error', () => {
  // The exact blocker scenario: good morning digest (baseline finished_at = M),
  // evening rerun fails and PRESERVES it (report file + mtime untouched), but
  // run.json gets a fresh finished_at + status:error. The poll MUST end.
  const rerunFailed = {
    started_at: '2026-07-07T20:00:00Z',
    finished_at: '2026-07-07T20:04:00Z',
    status: 'error',
    message: 'rerun failed; existing digest preserved',
  }
  const outcome = decideGenerateOutcome(rerunFailed, { finishedAt: '2026-07-07T07:05:00Z' })
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.status, 'error')
  assert.equal(outcome.message, 'rerun failed; existing digest preserved')
})

test('decideGenerateOutcome: a fresh success terminates with ok (first run of the day)', () => {
  const ok = { started_at: 't', finished_at: '2026-07-07T07:05:00Z', status: 'ok', message: 'digest saved' }
  const outcome = decideGenerateOutcome(ok, { finishedAt: null })
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.status, 'ok')
})

test('decideGenerateOutcome: only status "error" is an error; anything else is ok', () => {
  assert.equal(decideGenerateOutcome({ finished_at: 'x', status: 'mystery' }, {}).status, 'ok')
})

// --- Blocker 2: runtime storage.subscribe is dead for cron (out-of-band)
// writes and must NEVER be selected as a live-refresh trigger. EXECUTES the
// extracted refresh-trigger selection.

test('selectRefreshTriggers never selects storage.subscribe, even when the runtime exposes it', () => {
  const runtime = {
    onOnlineChange: () => () => {},
    storage: { subscribe: () => {}, subscribeText: () => {} },
  }
  const triggers = selectRefreshTriggers(runtime)
  assert.ok(!triggers.includes('subscribe'))
  assert.ok(!triggers.includes('subscribeText'))
  assert.ok(triggers.includes('visibility'))
  assert.ok(triggers.includes('poll'))
  assert.ok(triggers.includes('online'))
})

test('same-day regeneration bypasses SWR and invalidates the offline body cache by mtime', () => {
  const storage = readRepoFile('storage.js')
  const reports = readRepoFile(join('ui', 'ReportsTab.jsx'))
  assert.match(storage, /fetch\(`\/api\/storage\/apps\/\$\{appId\}\/reports\/\$\{dateStr\}\.\$\{ext\}`/)
  assert.ok(storage.includes("cache: 'no-store'"))
  assert.ok(storage.includes('JSON.stringify({ dates: recent, reports: trimmed, mtimes: trimmedMtimes })'))
  assert.ok(reports.includes('cachedMtime === entry.mtime'))
  assert.ok(reports.includes('cacheBody(entry.date, body, entry.mtime)'))
})

test('selectRefreshTriggers omits online when onOnlineChange is absent', () => {
  assert.deepEqual(selectRefreshTriggers({}), ['visibility', 'poll'])
})

test('ReportsTab wires triggers via selectRefreshTriggers and never re-adds subscribe', () => {
  const reports = readRepoFile(join('ui', 'ReportsTab.jsx'))
  assert.ok(reports.includes('selectRefreshTriggers'))
  assert.ok(!reports.includes('.subscribeText('), 'must not resurrect subscribeText wiring')
  assert.ok(!/storage\.subscribe\(/.test(reports), 'must not resurrect subscribe wiring')
  assert.ok(!reports.includes('90_000'), 'generation must not show a false 90s timeout')
})

// --- should-fix 1: the success toast + generate_completed:ok must be gated on
// report kind so a landed ERROR report is not celebrated as a digest.

test('isErrorReport flags the diagnostics report fetch.sh writes on failure', () => {
  assert.equal(isErrorReport({ summary: "Today's digest could not be generated.", html: '<article/>' }), true)
  assert.equal(isErrorReport({ summary: 'x', html: '<section><h2>Diagnostics</h2></section>' }), true)
  assert.equal(isErrorReport({ summary: 'digest unavailable', html: '' }), true)
  assert.equal(isErrorReport({ summary: 'Markets rallied today.', html: '<article>markets</article>' }), false)
  assert.equal(isErrorReport(null), false)
  assert.equal(isErrorReport({}), false)
})

// --- Blocker 1 fetch.sh side + should-fix 5: run-status written at start and
// every terminal, and the stray heredoc tabs removed. bash isn't executed
// here, so these assert the wiring is present.

test('fetch.sh writes run-status at start and every terminal, with no stray heredoc tabs', () => {
  const sh = readRepoFile('fetch.sh')
  assert.ok(sh.includes('write_run_status "running"'), 'run started marker')
  assert.ok(sh.includes('write_run_status "ok" "digest saved"'), 'success terminal')
  assert.ok(sh.includes('write_run_status "error" "$NOTIFY_BODY"'), 'preserved + first-run failure terminal')
  assert.ok(sh.includes('write_run_status "error" "bundled system-prompt.md is unavailable"'), 'early error terminal')
  assert.ok(sh.includes('.run.json'), 'run-status side file path')
  assert.ok(!/\t\s*}"/.test(sh), 'no stray tab before a notification heredoc closing }"')
})

// --- The remaining source-invariant guards (unchanged behaviors these
// finding-fixes must not regress). Kept as-is; the pieces they cover are shell
// / integration behavior not cheaply executable under node --test.

test('runtime online hook uses onOnlineChange, not the removed onChange API', () => {
  const storage = readRepoFile('storage.js')
  assert.ok(storage.includes('window.mobius.onOnlineChange'))
  assert.ok(!storage.includes('window.mobius.onChange'))
})

test('detail view and picker sheet register shell back sentinels', () => {
  const reports = readRepoFile(join('ui', 'ReportsTab.jsx'))
  const picker = readRepoFile(join('ui', 'ModelPicker.jsx'))

  assert.ok(reports.includes("window.mobius.nav.open('news-report'"))
  assert.ok(reports.includes('onForward: () => {'))
  assert.ok(reports.includes('setDetail(entry)'))
  assert.ok(reports.includes('const { status } = await handle.outcome'))
  assert.ok(reports.includes("status !== 'owned' && status !== 'standalone'"))
  assert.ok(reports.indexOf('flushSync(() => {') < reports.indexOf("signal('digest_read'"),
    'the opaque reader must commit before analytics work')
  assert.ok(reports.includes('aria-busy={openingDate === entry.date || undefined}'))
  assert.ok(reports.includes('navRef.current?.close?.()'))

  assert.ok(picker.includes('window.mobius.nav.open(navKey'))
  assert.ok(picker.includes('onForward: () => {'))
  assert.ok(picker.includes('const { status } = await handle.outcome'))
  assert.ok(picker.includes("status !== 'owned' && status !== 'standalone'"))
  assert.ok(picker.includes('navRef.current?.close?.()'))
  assert.ok(!picker.includes('handle.ready'))
  assert.ok(!picker.includes('onClick={() => setOpen(false)}'))
})

test('top and bottom pinned chrome honors standalone PWA safe areas', () => {
  const theme = readRepoFile('theme.js')

  assert.match(theme, /\.nw-header\s*\{[\s\S]*padding:\s*max\(18px,\s*env\(safe-area-inset-top\)\)/)
  assert.match(theme, /\.nw-reader-bar\s*\{[\s\S]*padding:\s*max\(11px,\s*env\(safe-area-inset-top\)\)\s*14px\s*11px;/)
  assert.match(theme, /\.nw-chat-panel\s*\{[\s\S]*padding-bottom:\s*env\(safe-area-inset-bottom\)/)
  assert.match(theme, /\.mobius-model-sheet__backdrop\s*\{[\s\S]*env\(safe-area-inset-bottom\)/)
})

test('embedded chat keeps its cover until the shared visual ready signal', () => {
  const panel = readRepoFile(join('ui', 'ChatPanel.jsx'))
  const theme = readRepoFile('theme.js')

  assert.match(panel, /onReady:\s*\(\)\s*=>\s*\{\s*if \(!disposed\) setPhase\('live'\)/)
  assert.ok(!panel.includes("handle = h\n        setPhase('live')"))
  assert.ok(panel.includes('className="nw-chat-stage"'))
  assert.ok(!panel.includes("display: phase === 'live'"))
  assert.match(theme, /\.nw-chat-stage\s*\{[\s\S]*position:\s*relative/)
  assert.match(theme, /\.nw-chat-resolving\s*\{[\s\S]*position:\s*absolute[\s\S]*background:\s*var\(--bg\)/)
})

test('report image delivery accepts passive raster data only', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
    assert.equal(isProxyableReportImageMime(mime), true, mime)
  }
  assert.equal(isProxyableReportImageMime('image/jpeg; charset=binary'), true)
  assert.equal(isProxyableReportImageMime('image/svg+xml'), false)
  assert.equal(isProxyableReportImageMime('text/html'), false)
  assert.equal(isSafeReportImageDataUrl('data:image/jpeg;base64,/9j/AA=='), true)
  assert.equal(isSafeReportImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), false)
  assert.equal(isSafeReportImageDataUrl('https://example.com/image.jpg'), false)
})

test('ReportReader prepares report text after the shell paints and delivers images progressively', () => {
  const reader = readRepoFile(join('ui', 'ReportReader.jsx'))
  const domain = readRepoFile('domain.js')
  assert.ok(reader.includes('/api/proxy?url=${encodeURIComponent(src)}'))
  assert.ok(reader.includes('Authorization: `Bearer ${token}`'))
  assert.ok(reader.includes('Promise.allSettled'))
  assert.ok(reader.includes('requestAnimationFrame(() =>'))
  assert.ok(reader.includes('buildFrame = requestAnimationFrame(() =>'))
  assert.ok(reader.includes('setReportSrcDoc(buildHtmlSrcDoc({ html: reportHtml }))'))
  assert.ok(reader.includes('}, [reportHtml])'), 'does not rebuild unchanged cached HTML')
  assert.ok(reader.includes("type: 'news:report-images'"))
  assert.ok(reader.includes('report && reportHtml && reportSrcDoc && ('))
  assert.ok(domain.includes("child.setAttribute('data-news-source', src)"))
  assert.ok(!reader.includes('imagesSettled'))
})

test('ReportReader reveals report controls and questions only after the frame is measured', () => {
  const reader = readRepoFile(join('ui', 'ReportReader.jsx'))
  const theme = readRepoFile('theme.js')
  assert.match(reader, /setIframeHeight\([\s\S]*setReportMeasured\(true\)/)
  assert.ok(reader.includes('aria-hidden={!reportMeasured}'))
  assert.ok(reader.includes('reportReady && report?.questions?.length > 0'))
  assert.ok(reader.includes('reportReady && report && preferences?.tts?.enabled'))
  assert.ok(reader.includes("'Opening report…'"))
  const measuringRule = theme.match(/\.nw-reader-frame\.is-measuring\s*\{[^}]*\}/)?.[0] || ''
  assert.match(measuringRule, /(?:opacity:\s*0|visibility:\s*hidden)/)
})

test('ReportReader image taps open an app-owned, back-aware sheet', () => {
  const reader = readRepoFile(join('ui', 'ReportReader.jsx'))
  const theme = readRepoFile('theme.js')
  const constants = readRepoFile('constants.js')
  assert.ok(reader.includes("if (ev.source !== iframeRef.current?.contentWindow) return"))
  assert.ok(reader.includes("nav.open('news-image'"))
  assert.ok(reader.includes('className="nw-image-scrim"'))
  assert.ok(reader.includes('aria-modal="true"'))
  assert.ok(constants.includes("type:'news:open-image'"))
  assert.ok(constants.includes("event.key!=='Enter'&&event.key!==' '"))
  assert.match(theme, /\.nw-image-scrim\s*\{[\s\S]*position:\s*absolute/)
  assert.match(theme, /\.nw-image-sheet__close\s*\{[\s\S]*min-height:\s*44px/)
})

// --- HIGH finding: the "Opening…" cover is lifted ONLY by the chat's
// ready signal — a single un-backstopped point of failure. If that signal
// never fires (embed auth error, runtime mismatch, frame killed), the cover
// hangs forever. A bounded backstop must lift it anyway, and must be cancelled
// cleanly when ready wins the race or the panel unmounts (no stray timer).
// These EXECUTE the extracted coordinator with injected timers.

test('armCoverBackstop lifts the cover when the ready signal never fires', () => {
  let scheduled = null
  let cleared = null
  let revealed = 0
  const backstop = armCoverBackstop({
    delay: 5000,
    onReveal: () => { revealed += 1 },
    setTimer: (fn, ms) => { scheduled = { fn, ms }; return 'timer-1' },
    clearTimer: (id) => { cleared = id },
  })
  assert.equal(scheduled.ms, 5000, 'arms a bounded timer at the given delay')
  assert.equal(revealed, 0, 'nothing revealed before the backstop elapses')
  // Ready never fires; the timer elapses.
  scheduled.fn()
  assert.equal(revealed, 1, 'backstop lifts the cover exactly once')
  // A late cancel (ready or unmount after the backstop already fired) is a no-op.
  backstop.cancel()
  assert.equal(cleared, null, 'no clearTimer once the timer has already fired')
  assert.equal(revealed, 1, 'still revealed exactly once')
})

test('armCoverBackstop cancel() clears the pending timer and never reveals (ready/unmount)', () => {
  let cleared = null
  let revealed = 0
  const backstop = armCoverBackstop({
    delay: 5000,
    onReveal: () => { revealed += 1 },
    setTimer: () => 'timer-42',
    clearTimer: (id) => { cleared = id },
  })
  backstop.cancel()
  assert.equal(cleared, 'timer-42', 'cancel clears the exact pending timer id')
  assert.equal(revealed, 0, 'cancel before elapse never force-lifts the cover')
  // Idempotent: a second cancel (e.g. unmount after ready) does nothing more.
  cleared = null
  backstop.cancel()
  assert.equal(cleared, null, 'second cancel is a no-op — no double clear, no leak')
  assert.equal(revealed, 0)
})

test('ChatPanel arms the cover backstop and cancels it on ready, error, and unmount', () => {
  const panel = readRepoFile(join('ui', 'ChatPanel.jsx'))
  assert.ok(panel.includes('armCoverBackstop'), 'wires the bounded reveal backstop')
  assert.match(panel, /const COVER_BACKSTOP_MS = \d{4,}/, 'bounded (few-second) backstop delay')
  // onReady still lifts the cover, then cancels the now-moot backstop.
  assert.match(panel, /onReady:\s*\(\)\s*=>\s*\{\s*if \(!disposed\) setPhase\('live'\); backstop\.cancel\(\)/)
  // the mount-rejection path cancels before showing the unavailable note, so a
  // late backstop can't flip 'unavailable' back to 'live'.
  assert.match(panel, /\.catch\(\(\) => \{ backstop\.cancel\(\); if \(!disposed\) setPhase\('unavailable'\)/)
  // unmount cleanup cancels the timer (no leak) alongside the disposed guard.
  assert.match(panel, /disposed = true\s*\n\s*backstop\.cancel\(\)/)
})

test('top-level tabs use roving focus and labelled tab panels', () => {
  const app = readRepoFile('index.jsx')
  assert.match(app, /tabIndex=\{tab === 'reports' \? 0 : -1\}/)
  assert.match(app, /event\.key === 'ArrowRight'/)
  assert.match(app, /event\.key === 'Home'/)
  assert.match(app, /role="tabpanel" aria-labelledby="nw-tab-reports"/)
  assert.match(app, /role="tabpanel" aria-labelledby="nw-tab-settings"/)
})

test('settings fields and model sheet expose complete keyboard semantics', () => {
  const settings = readRepoFile('ui/SettingsTab.jsx')
  const picker = readRepoFile('ui/ModelPicker.jsx')
  assert.match(settings, /htmlFor="nw-editorial-brief"/)
  assert.match(settings, /id="nw-editorial-brief"/)
  assert.match(picker, /event\.key !== 'Tab'/)
  assert.match(picker, /document\.activeElement === first/)
  assert.match(picker, /triggerRef\.current\?\.focus/)
})

test('failed same-day reruns preserve ready reports and still emit cron_summary', () => {
  const fetchSh = readRepoFile('fetch.sh')
  assert.ok(fetchSh.includes('existing_ready_report()'))
  assert.ok(fetchSh.includes('EXISTING_STATUS" = "ready"'))
  assert.ok(fetchSh.includes('not overwriting with error report'))
  assert.ok(fetchSh.includes('"name": "cron_summary"'))
  assert.ok(fetchSh.includes('emit_cron_summary "error"'))
  assert.ok(fetchSh.includes('emit_cron_summary "ok" 0 1 "digest saved"'))
  assert.ok(!fetchSh.includes('write_report_chat_meta'))
  assert.ok(!fetchSh.includes('FeedbackLauncher'))
})

test('timezone is saved with schedules and fetch.sh dates reports in it', () => {
  const domain = readRepoFile('domain.js')
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const fetchSh = readRepoFile('fetch.sh')

  assert.ok(domain.includes('getBrowserTimezone'))
  assert.ok(domain.includes('timezone'))
  assert.ok(settings.includes('{ ...nextSchedule, timezone, cron }'))
  assert.ok(settings.includes('item_updated'))
  assert.ok(settings.includes("job: 'fetch.sh'"))
  assert.ok(fetchSh.includes('SCHEDULE_TZ='))
  assert.ok(fetchSh.includes('TODAY=$(TZ="$RUN_TZ" date +%Y-%m-%d)'))
})

test('reasoning effort enums mirror supported provider CLIs', () => {
  assert.deepEqual(
    EFFORT_LEVELS.claude,
    [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
      { value: 'max', label: 'Max' },
      { value: 'ultracode', label: 'Ultracode' },
    ],
  )
  assert.deepEqual(
    EFFORT_LEVELS.codex,
    [
      { value: 'none', label: 'None' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high' },
    ],
  )
  assert.equal(defaultEffort('claude'), 'medium')
  assert.equal(defaultEffort('codex'), 'medium')
  assert.equal(defaultEffort('unknown'), 'medium')
})

test('settings rolls back refused agent writes with a newest-wins guard', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.ok(settings.includes('const prevProvider = provider'))
  assert.ok(settings.includes('setProvider(prevProvider)'))
  assert.ok(settings.includes('setModel(prevModel)'))
  assert.ok(settings.includes('const prevEffort = effort'))
  assert.ok(settings.includes('setEffort(prevEffort)'))
  assert.ok(settings.includes('const saveEffort'))
  assert.ok(settings.includes('saveFallbackAgent'))
  assert.ok(settings.includes('setFallbackProvider(prevProvider)'))
  assert.ok(settings.includes('const saveFallbackEffort'))
  assert.ok(settings.includes('setFallbackEffort(prevEffort)'))
  assert.ok(settings.includes('agentPayload({'))
  assert.ok(settings.includes('setPrimaryAgentMode(prevMode)'))
  assert.ok(settings.includes('setSecondaryAgentMode(prevMode)'))
  // newest-wins guard: a stale response applies neither its toast nor rollback.
  assert.ok(settings.includes('saveAgentSeqRef'))
  assert.ok(settings.includes('seq !== saveAgentSeqRef.current'))
  assert.ok(settings.includes("type: 'editorial_brief'"))
  assert.ok(settings.includes('reset: false'))
  assert.ok(settings.includes('reset: true'))
})

test('settings never silently auto-configures an identical fallback', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.ok(settings.includes("g.key !== provider && connected(g)"))
  assert.ok(settings.includes("g.key !== provider && g.models?.length"))
  assert.ok(settings.includes('Connect another provider before enabling a fallback.'))
  assert.ok(settings.includes('fallbackMatchesPrimary'))
  assert.ok(settings.includes('This override matches the primary exactly'))
})

test('settings writes explicit Background-agent modes and preserves legacy overrides', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  for (const key of [
    'primary_agent_mode', 'provider', 'model', 'effort',
    'secondary_agent_mode', 'fallback_provider', 'fallback_model', 'fallback_effort',
  ]) assert.ok(settings.includes(`${key}:`), `${key} missing from payload`)
  assert.ok(settings.includes('stored.effort'))
  assert.ok(settings.includes('stored.fallback_effort'))
  assert.ok(settings.includes('<EffortStepper'))
  assert.ok(settings.includes('legacyPrimaryOverride'))
  assert.ok(settings.includes('legacySecondaryOverride'))
  assert.ok(settings.includes("useState('system')"))
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.equal(manifest.storage_seeds['agent.json'].primary_agent_mode, 'system')
  assert.equal(manifest.storage_seeds['agent.json'].secondary_agent_mode, 'system')
})

test('background agent slots use the Settings-style picker with an inherited default row', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const picker = readRepoFile(join('ui', 'ModelPicker.jsx'))
  const priorityList = readRepoFile(join('ui', 'BackgroundAgentList.jsx'))
  const theme = readRepoFile('theme.js')
  assert.ok(settings.includes("useSettingsDefault={primaryAgentMode === 'system'}"))
  assert.ok(settings.includes("useSettingsDefault={secondaryAgentMode === 'system'}"))
  assert.ok(settings.includes('onChange={saveAgent}'))
  assert.ok(settings.includes("onSettingsDefault={() => savePrimaryMode('system')}"))
  assert.ok(settings.includes('onChange={saveFallbackAgent}'))
  assert.ok(settings.includes('onSettingsDefault={() => toggleFallback(false)}'))
  assert.ok(!settings.includes('aria-label="News primary agent mode"'))
  assert.ok(!settings.includes('aria-label="News secondary agent mode"'))
  assert.ok(picker.includes('Default from settings'))
  assert.ok(picker.includes('onSettingsDefault'))
  assert.ok(picker.includes('aria-label={triggerLabel}'))
  assert.ok(picker.includes('aria-pressed={useSettingsDefault}'))
  assert.ok(picker.includes('aria-pressed={selected}'))
  assert.ok(picker.includes('`${title}: ${modelName}${effortLabel ? `, ${effortLabel} effort`'))
  assert.match(picker, /\{open && createPortal\([\s\S]*document\.body,\s*\)\}/)
  assert.match(picker, /event\.target === event\.currentTarget\) closeSheet\(\)/)
  assert.match(picker, /mobius-model-sheet__close" onClick=\{closeSheet\}/)
  assert.match(picker, /closeRef\.current\?\.focus\?\.\(\)/)
  assert.match(picker, /triggerRef\.current\?\.focus\?\.\(\)/)
  assert.match(theme, /\.mobius-model-sheet__backdrop\s*\{[\s\S]*z-index:\s*1000/)
  assert.ok(settings.includes('<BackgroundAgentList'))
  assert.ok(settings.includes('onMove={reorderAgents}'))
  assert.ok(settings.includes('reorderAgentSlots(slots, fromIndex, toIndex)'))
  assert.ok(settings.includes('setPrimaryAgentMode(next.primaryAgentMode)'))
  assert.ok(settings.includes('setSecondaryAgentMode(next.secondaryAgentMode)'))
  assert.ok(settings.includes('setPrimaryAgentMode(previous.primary.mode)'))
  assert.ok(settings.includes('setSecondaryAgentMode(previous.secondary.mode)'))
  assert.ok(settings.includes('seq !== saveAgentSeqRef.current'))
  assert.ok(priorityList.includes('mobius-agent-priority-handle'))
  assert.ok(priorityList.includes('onPointerDown'))
  assert.ok(priorityList.includes("event.key === 'ArrowUp'"))
  assert.ok(priorityList.includes('itemLabels'))
  assert.ok(priorityList.includes('aria-live="polite"'))
  assert.ok(settings.includes('reorderDisabled={!canReorderAgents}'))
})

test('background agent reorder preserves concrete identities and rejects inherited slots', () => {
  const primary = { mode: 'app', provider: 'claude', model: 'claude-opus', effort: 'high' }
  const fallback = { mode: 'app', provider: 'codex', model: 'gpt-codex', effort: 'medium' }
  const before = [primary, fallback]
  const after = reorderAgentSlots(before, 1, 0)
  assert.equal(canReorderAgentSlots(before), true)
  assert.deepEqual(after, [fallback, primary])
  assert.notEqual(after[0], fallback)

  const inherited = [{ mode: 'system' }, fallback]
  assert.equal(canReorderAgentSlots(inherited), false)
  assert.equal(reorderAgentSlots(inherited, 0, 1), inherited)
})

test('fetch.sh resolves and retries a configured fallback agent', () => {
  const sh = readRepoFile('fetch.sh')
  assert.ok(sh.includes('/api/apps/$APP_ID/job-context'))
  assert.ok(sh.includes('_choice(context.get("primary"))'))
  assert.ok(sh.includes('_choice(context.get("fallback"))'))
  assert.ok(sh.includes('fallback_provider'))
  assert.ok(sh.includes('fallback_effort'))
  assert.ok(sh.includes('IFS=$\'\\t\' read -r PROVIDER MODEL EFFORT FALLBACK_PROVIDER FALLBACK_MODEL FALLBACK_EFFORT'))
  assert.ok(sh.includes('run_agent_cli "$PROVIDER" "$MODEL" "$EFFORT"'))
  assert.ok(sh.includes('Primary agent failed with code $CLI_EXIT; trying fallback'))
  assert.ok(sh.includes('PROVIDER="$FALLBACK_PROVIDER"'))
  assert.ok(sh.includes('MODEL="$FALLBACK_MODEL"'))
  assert.ok(sh.includes('EFFORT="$FALLBACK_EFFORT"'))
  assert.ok(sh.includes('CLAUDE_FLAGS+=(--effort "$claude_effort")'))
  assert.ok(sh.includes('CODEX_FLAGS+=(-c "model_reasoning_effort=\\"$selected_effort\\"")'))
  assert.doesNotMatch(sh, /from app\.|\/data\/platform\/backend/)
})

test('mechanical manifest and token fixes stay in place', () => {
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  const pkg = JSON.parse(readRepoFile('package.json'))
  const lock = JSON.parse(readRepoFile('package-lock.json'))
  const theme = readRepoFile('theme.js')
  assert.equal(manifest.version, pkg.version)
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages[''].version, pkg.version)
  assert.equal(manifest.embeds_agent, true)
  assert.ok(manifest.source_files.includes('ui/EffortStepper.jsx'))
  assert.ok(manifest.source_files.includes('ui/BackgroundAgentList.jsx'))
  assert.deepEqual(manifest.offline, { reads: true, writes: 'queued', execution: 'none' })
  assert.ok(!/color:\s*#fff/.test(theme))
  assert.ok(!/color:\s*var\(--bg\)/.test(theme))
  assert.ok(theme.includes('color: var(--accent-fg)'))
  assert.ok(theme.includes('min-height: 44px; min-width: 44px'))
  assert.ok(theme.includes('.nw-empty__mark'))
})

test('embedded XN runtime carries its dependency notices', () => {
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  const notices = readRepoFile('THIRD_PARTY_NOTICES.md')
  assert.ok(manifest.source_files.includes('licenses/XN-RUNTIME-LICENSES.md'))
  assert.ok(notices.includes('licenses/XN-RUNTIME-LICENSES.md'))
})
