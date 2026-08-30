import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decideGenerateOutcome,
  selectRefreshTriggers,
  armCoverBackstop,
  isProxyableReportImageMime,
  isSafeReportImageDataUrl,
} from '../domain.js'
import { applySpeechHints, isErrorReport } from '../report-schema.mjs'
import { EFFORT_LEVELS, defaultEffort } from '../constants.js'
import {
  STARTER_TOPICS,
  normalizePreferences,
} from '../preferences.js'
import { canReorderAgentSlots, reorderAgentSlots } from '../ui/backgroundAgentOrder.js'
import {
  activeVoiceModel,
  batchSpeechDocument,
  isSpeechCancellation,
  isSpeechReplacement,
  readVoiceAppInstallation,
  SPEECH_DOCUMENT_MAX_TEXT_CHARS,
  speechHintsForReport,
  voicePlaybackConfig,
  voiceSetupState,
} from '../speech-capability.js'
import {
  addSpeechPauses,
  createSpeechTimeline,
  estimateSpeechDuration,
  normalizePlaybackSettings,
  normalizePlaybackRate,
  playbackSettingsWithRate,
  playbackSettingsWithResume,
  PLAYBACK_RATES,
  resumeSegmentFor,
  speechReportKey,
  speechPauseMs,
} from '../speech-timeline.js'
import { concatAudioFrames, createSpeechBoundaryTrimmer } from '../speech-audio.js'
import {
  createPitchPreservingSpeechOutput,
  createSpeechMediaBridge,
} from '../speech-media.js'
import { openShellPlayback } from '../shell-playback.js'

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

test('listening follows the one active device voice without storing a second choice', () => {
  const fields = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  const speech = readRepoFile('speech-capability.js')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.doesNotMatch(fields, /Speech provider|<select/)
  assert.match(fields, /Choose a voice/)
  assert.match(fields, /Open App Store/)
  assert.match(fields, /Open Voice/)
  assert.match(speech, /appId: 'app-store'/)
  assert.match(speech, /intent: 'app:voice'/)
  assert.match(speech, /appId: 'voice'/)
  assert.equal(manifest.storage_seeds['preferences.json'].version, 3)
  assert.equal(manifest.storage_seeds['preferences.json'].tts.enabled, false)
  assert.equal(Object.hasOwn(manifest.storage_seeds['preferences.json'].tts, 'provider'), false)
  const normalized = normalizePreferences({
    tts: { enabled: true, provider: 'app:future/speech' },
  })
  assert.deepEqual(normalized.tts, { enabled: true })
})

test('Voice installation and voice readiness remain distinct setup states', async () => {
  const ready = { id: 'ready', name: 'Alba', language: 'English' }
  assert.equal(voiceSetupState({ state: 'ready', activeModel: ready, voiceAppInstalled: true }), 'ready')
  assert.equal(voiceSetupState({ state: 'ready', activeModel: null, voiceAppInstalled: true }), 'needs_voice')
  assert.equal(voiceSetupState({ state: 'ready', activeModel: null, voiceAppInstalled: false }), 'needs_app')
  assert.equal(voiceSetupState({ state: 'unavailable', activeModel: null, voiceAppInstalled: true }), 'unavailable')
  assert.equal(voiceSetupState({ state: 'unavailable', activeModel: null, voiceAppInstalled: null }), 'unavailable')

  let request
  const installed = await readVoiceAppInstallation('news-token', async (url, options) => {
    request = { url, options }
    return {
      ok: true,
      async json() { return [{ slug: 'voice', source_manifest: { id: 'voice' } }] },
    }
  })
  assert.equal(installed, true)
  assert.equal(request.url, '/api/apps/')
  assert.equal(request.options.headers.Authorization, 'Bearer news-token')
})

test('the speech catalog exposes only its active ready model', () => {
  const ready = { id: 'ready', name: 'Alba', language: 'English' }
  assert.equal(activeVoiceModel({ activeModel: ready }), ready)
  assert.equal(activeVoiceModel({ activeModel: null }), null)
  assert.equal(activeVoiceModel(null), null)
})

test('the playback catalog requires one reviewed pitch-preserving worklet', () => {
  assert.deepEqual(voicePlaybackConfig({
    playback: { pitchPreserving: true, workletUrl: '/speech/pitch.js' },
  }), { pitchPreserving: true, workletUrl: '/speech/pitch.js' })
  assert.equal(voicePlaybackConfig({
    playback: { pitchPreserving: false, workletUrl: '/speech/pitch.js' },
  }), null)
  assert.equal(voicePlaybackConfig({
    playback: { pitchPreserving: true, workletUrl: 'https://unreviewed.test/pitch.js' },
  }), null)
  assert.equal(isSpeechReplacement({ code: 'superseded', name: 'AbortError' }), true)
  assert.equal(isSpeechCancellation({ code: 'superseded' }), true)
})

test('playback UI requires the shared catalog to have an active ready voice', () => {
  const reader = readRepoFile(join('ui', 'ReportReader.jsx'))
  const fields = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  const hook = readRepoFile(join('ui', 'useVoiceCatalog.js'))
  assert.match(reader, /voicePlaybackReady\(speechCatalog\)/)
  assert.match(reader, /preferences\?\.tts\?\.enabled && voiceReady/)
  assert.match(fields, /voiceSetupState\(catalog\)/)
  assert.match(fields, /if \(setupState !== 'ready'\)/)
  assert.match(hook, /visibilitychange/)
  assert.match(hook, /window\.addEventListener\('focus'/)
  assert.match(hook, /readVoiceAppInstallation\(token\)/)
})

test('setup and Settings keep guidance concise and state-specific', () => {
  const setup = readRepoFile(join('ui', 'SetupFlow.jsx'))
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.doesNotMatch(setup, /nw-setup-eyebrow/)
  assert.doesNotMatch(setup, /set it up before or after setup/)
  assert.match(settings, /Tell the curator what to cover and how to write it\./)
  assert.doesNotMatch(settings, /This is what the curator reads every morning/)
  assert.doesNotMatch(settings, /News uses the voice currently selected in Voice/)
})

test('reports over 50,000 characters become ordered semantic speech batches', () => {
  const segments = [
    { text: 'a'.repeat(25_000), kind: 'section', pauseAfterMs: 600 },
    { text: 'b'.repeat(25_000), kind: 'paragraph', pauseAfterMs: 240 },
    { text: 'c'.repeat(12_000), kind: 'section', pauseAfterMs: 0 },
  ]
  const document = { version: 1, locale: 'en-GB', hints: [], segments }
  const batches = batchSpeechDocument(document)

  assert.deepEqual(batches.map((batch) => batch.segments.length), [2, 1])
  assert.deepEqual(batches.flatMap((batch) => batch.segments), segments)
  assert.equal(batches[0].segments[1].pauseAfterMs, 240,
    'the pause at a document seam remains owned by its original block')
  assert.ok(batches.every((batch) => (
    batch.segments.reduce((total, segment) => total + segment.text.length, 0)
      <= SPEECH_DOCUMENT_MAX_TEXT_CHARS
  )))
  assert.deepEqual(batchSpeechDocument(document), batches, 'batching is deterministic')

  const manyBlocks = Array.from({ length: 513 }, (_, index) => ({
    text: String(index), kind: 'list', pauseAfterMs: 150,
  }))
  assert.deepEqual(
    batchSpeechDocument({ version: 1, segments: manyBlocks })
      .map((batch) => batch.segments.length),
    [512, 1],
  )
})

test('speech batching budgets expanded hints and never truncates an oversized block', () => {
  const hinted = 'AI '.repeat(1_500).trim()
  const segments = [0, 1, 2].map((index) => ({
    text: hinted,
    kind: index === 0 ? 'section' : 'paragraph',
    pauseAfterMs: index === 2 ? 0 : 240,
  }))
  const batches = batchSpeechDocument({
    version: 1,
    hints: [{ written: 'AI', spoken: 'artificial intelligence' }],
    segments,
  })
  assert.deepEqual(batches.map((batch) => batch.segments.length), [1, 1, 1])
  assert.deepEqual(batches.flatMap((batch) => batch.segments), segments)

  assert.throws(
    () => batchSpeechDocument({
      version: 1,
      hints: [
        { written: 'WORDS', spoken: '--------' },
        { written: '----', spoken: 'x' },
      ],
      segments: [{ text: 'WORDS WORDS', kind: 'paragraph' }],
    }, { maxTextChars: 12 }),
    (error) => error?.code === 'speech_block_too_long',
    'a transient hint expansion must not exceed the same host limit',
  )

  const originalReplace = RegExp.prototype[Symbol.replace]
  let expansionAllocated = false
  RegExp.prototype[Symbol.replace] = function guardedReplace(value, replacement) {
    if (this.source.includes('BOMB')) {
      expansionAllocated = true
      throw new Error('oversized replacement was constructed')
    }
    return Reflect.apply(originalReplace, this, [value, replacement])
  }
  const bombHints = [{ written: 'BOMB', spoken: 'x'.repeat(240) }]
  const bombText = 'BOMB '.repeat(9_000).trim()
  try {
    assert.throws(
      () => applySpeechHints(bombText, bombHints),
      (error) => error?.code === 'speech_text_too_long',
      'the public hint helper is bounded by default',
    )
    assert.throws(
      () => batchSpeechDocument({
        version: 1,
        hints: bombHints,
        segments: [{ text: bombText, kind: 'paragraph' }],
      }),
      (error) => error?.code === 'speech_block_too_long',
    )
  } finally {
    RegExp.prototype[Symbol.replace] = originalReplace
  }
  assert.equal(expansionAllocated, false,
    'the replacement itself must not run after its length crosses the limit')

  const text = 'x'.repeat(SPEECH_DOCUMENT_MAX_TEXT_CHARS + 1)
  assert.throws(
    () => batchSpeechDocument({ version: 1, segments: [{ text, kind: 'paragraph' }] }),
    (error) => error?.code === 'speech_block_too_long' && /Report block 1/.test(error.message),
  )
  assert.equal(text.length, SPEECH_DOCUMENT_MAX_TEXT_CHARS + 1)
})

test('source preferences stay concise and their text remains selectable', () => {
  const fields = readRepoFile(join('ui', 'PreferenceFields.jsx'))
  const theme = readRepoFile('theme.js')
  assert.match(fields, /nw-choice-grid/)
  assert.match(fields, />Include<\/label>/)
  assert.match(fields, />Exclude<\/label>/)
  assert.doesNotMatch(fields, /Coverage mix|Always look for|Avoid or ignore|For example:/)
  assert.match(theme, /nw-source-inputs \.nw-text-input[\s\S]*user-select: text/)
})

test('shared speech lifecycle cancellations reset quietly instead of appearing as failures', () => {
  assert.equal(isSpeechCancellation({ name: 'AbortError' }), true)
  assert.equal(isSpeechCancellation({ code: 'aborted' }), true)
  assert.equal(isSpeechCancellation({ message: 'Speech stopped.' }), false)
  assert.equal(isSpeechCancellation(new Error('model missing')), false)
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(listen, /isSpeechCancellation\(caught\)/)
  assert.match(listen, /setError\(''\)/)
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

test('report listening resumes audio in the tap before opening shared speech', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('await context.resume()'))
  assert.ok(listen.includes('await readVoiceCatalog(controller.signal)'))
  assert.ok(
    listen.indexOf('await context.resume()') < listen.indexOf('await readVoiceCatalog(controller.signal)'),
    'mobile audio context must resume before the network await',
  )
  assert.ok(listen.includes('await synthesizeSpeech({'))
  assert.doesNotMatch(listen, /speechBackend|speechMetrics|PerformanceObserver/)
})

test('News delegates bounded Speech Documents to one active device voice', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const speech = readRepoFile('speech-capability.js')
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const setup = readRepoFile(join('ui', 'SetupFlow.jsx'))
  const voiceCatalogHook = readRepoFile(join('ui', 'useVoiceCatalog.js'))
  const digestJob = readRepoFile('fetch.sh')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.ok(listen.includes("from '../speech-capability.js'"))
  assert.ok(speech.includes("SPEECH_CAPABILITY = 'media.speech'"))
  assert.ok(speech.includes("operation: 'synthesize'"))
  assert.doesNotMatch(speech + listen, /providerId|providers\?\.|tts\.provider/)
  assert.ok(listen.includes('reportSpeechDocument'))
  assert.match(listen, /batchSpeechDocument\(\{[\s\S]*?\.\.\.speechDocument,[\s\S]*?segments: parts/)
  assert.ok(listen.includes('catalog = await readVoiceCatalog(controller.signal)'))
  assert.ok(listen.includes('const speechModel = activeVoiceModel(catalog)'))
  assert.ok(listen.includes('document: speechBatch'))
  assert.ok(listen.includes('modelId: speechModel.id'))
  assert.ok(listen.includes('onBoundary: completePart'))
  assert.equal((listen.match(/await synthesizeSpeech\(\{/g) || []).length, 1)
  assert.ok(settings.includes('useVoiceCatalog(token)'))
  assert.ok(setup.includes('useVoiceCatalog(token)'))
  assert.ok(voiceCatalogHook.includes('readVoiceCatalog()'))
  assert.doesNotMatch(settings + setup, /prepareTtsModelPack|Download voice/)
  assert.doesNotMatch(digestJob, /torch|numpy|scipy|pip install/i)
  assert.doesNotMatch(digestJob, /Pocket TTS|model\.safetensors|install-request/)
  assert.ok(manifest.source_files.includes('speech-capability.js'))
  assert.equal(manifest.source_files.some((name) => /browser-tts|tts-model-pack|TtsModelPack/.test(name)), false)
  assert.equal(manifest.capabilities['media.speech'].version, 1)
  assert.equal(
    manifest.capabilities['media.speech'].limits.max_text_chars,
    SPEECH_DOCUMENT_MAX_TEXT_CHARS,
  )
  assert.equal(Object.hasOwn(manifest.capabilities, 'device.asset-cache'), false)
  assert.equal(manifest.schedule.job, 'fetch.sh')
  assert.equal(manifest.schedule.default, '0 10 * * *')
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
  assert.ok(listen.includes('onBoundary: completePart'))
  assert.ok(listen.includes('semanticPauseMs'))
  assert.ok(listen.includes('pauseAfterMs: semanticPauseMs'))
  assert.ok(listen.includes('concatAudioFrames(partFrames, partSamples)'))
  assert.doesNotMatch(listen, /replace\(\/.+?<[^>]+>/,
    'speech structure must not regress to flattening report HTML with a tag regex')
})

test('the warm News frame never owns or disposes the shared speech engine', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const speech = readRepoFile('speech-capability.js')
  assert.doesNotMatch(listen + speech, /browserSpeechEngine|releaseBrowserSpeechEngine/)
  assert.ok(speech.includes("SPEECH_CAPABILITY = 'media.speech'"))
  assert.doesNotMatch(listen, /moebius:frame-visibility/)
})

test('semantic elements own one direct pause policy', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('addSpeechPauses(parts)'))
  assert.ok(listen.includes("kind = 'section-end'"))
  assert.equal(speechPauseMs('title', 'paragraph'), 900)
  assert.equal(speechPauseMs('section', 'subsection'), 900)
  assert.equal(speechPauseMs('paragraph', 'paragraph'), 500)
  assert.equal(speechPauseMs('paragraph', 'list'), 500)
  assert.equal(speechPauseMs('list', 'list'), 260)
  assert.equal(speechPauseMs('list', 'paragraph'), 500)
  assert.equal(speechPauseMs('section-end', 'paragraph'), 1_000)
  assert.deepEqual(addSpeechPauses([
    { text: 'Items', kind: 'section' },
    { text: 'One', kind: 'list' },
    { text: 'Two', kind: 'list' },
    { text: 'Next', kind: 'paragraph' },
  ]).map((part) => part.pauseMs), [900, 260, 500, 500])
})

test('the fixed masthead label uses an unambiguous spoken form while preserving its date hint', () => {
  const hints = speechHintsForReport([{
    written: 'Wednesday 12 August 2026',
    spoken: 'Wednesday, the twelfth of August, twenty twenty-six',
  }])
  assert.equal(
    applySpeechHints('Daily digest · Wednesday 12 August 2026', hints),
    'Daily news briefing · Wednesday, the twelfth of August, twenty twenty-six',
  )
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

test('audio-clock queue stays contiguous across live pitch-preserving speed changes', async () => {
  class FakeParam {
    constructor() { this.events = []; this.value = 1 }
    cancelScheduledValues(at) { this.events.push(['cancel', at]) }
    setValueAtTime(value, at) { this.value = value; this.events.push(['set', value, at]) }
  }
  const workletRate = new FakeParam()
  let worklet
  class FakeWorkletNode {
    constructor(_context, name, options) {
      this.name = name
      this.options = options
      this.parameters = new Map([['playbackRate', workletRate]])
      worklet = this
    }
    connect(value) { this.destination = value }
    disconnect() { this.disconnected = true }
  }
  const sources = []
  const buffers = []
  const context = {
    currentTime: 2,
    sampleRate: 100,
    audioWorklet: {
      modules: [],
      async addModule(url) { this.modules.push(url) },
    },
    createBuffer(_channels, length, sampleRate) {
      const channel = new Float32Array(length)
      const buffer = {
        length,
        sampleRate,
        channel,
        copyToChannel(samples) { channel.set(samples) },
      }
      buffers.push(buffer)
      return buffer
    },
    createBufferSource() {
      const source = {
        playbackRate: new FakeParam(),
        connect(value) { this.destination = value },
        disconnect() { this.disconnected = true },
        start(at) { this.startedAt = at },
        stop() { this.stopped = true },
      }
      sources.push(source)
      return source
    },
  }
  const revoked = []
  const output = await createPitchPreservingSpeechOutput({
    context,
    destination: { id: 'native-media' },
    workletUrl: '/speech/pitch.js',
    fetcher: async (url, options) => ({
      ok: url === '/speech/pitch.js' && options.credentials === 'same-origin',
      async text() { return 'registerProcessor()' },
    }),
    BlobClass: class { constructor(parts, options) { this.parts = parts; this.options = options } },
    urlApi: {
      createObjectURL: () => 'blob:pitch',
      revokeObjectURL: (url) => revoked.push(url),
    },
    WorkletNode: FakeWorkletNode,
  })

  assert.equal(worklet.name, 'soundtouch-processor')
  assert.deepEqual(worklet.options.outputChannelCount, [1])
  assert.deepEqual(context.audioWorklet.modules, ['blob:pitch'])
  assert.deepEqual(revoked, ['blob:pitch'])

  const completed = []
  const first = output.play(new Float32Array(100).fill(0.25), {
    sampleRate: 100,
    pauseAfterMs: 500,
    playbackRate: 1.5,
    onEnded: (seconds) => completed.push(['first', seconds]),
  })
  const second = output.play(new Float32Array(100).fill(0.25), {
    sampleRate: 100,
    final: true,
    onEnded: (seconds) => completed.push(['second', seconds]),
  })
  assert.equal(first.logicalDuration, 1.5)
  assert.equal(second.logicalDuration, 1)
  assert.equal(buffers[0].length, 1, 'a silent source keeps the worklet draining between sections')
  assert.equal(buffers[1].length, 150, 'the semantic pause stays part of the content buffer')
  assert.equal(buffers[2].length, 140, 'only the final section carries a bounded DSP drain')
  assert.equal(sources[1].playbackRate.value, 1.5)
  assert.equal(sources[1].startedAt, 2)
  assert.equal(sources[2].startedAt, 3,
    'the second section is scheduled before the first ended callback runs')
  assert.equal(workletRate.value, 1.5,
    'matching rates make the processor cancel the source pitch shift')

  context.currentTime = 2.4
  assert.ok(Math.abs(output.elapsedSeconds() - 0.6) < 0.0001)
  output.setRate(2)
  assert.equal(sources[1].playbackRate.value, 2)
  assert.equal(workletRate.value, 2)
  assert.equal(sources[2].stopped, true,
    'a not-yet-started source is replaced because its Web Audio start time is immutable')
  assert.ok(Math.abs(sources[3].startedAt - 2.85) < 0.0001,
    'the future section follows the active section at its recalculated end without a gap')
  context.currentTime = 2.6
  assert.ok(Math.abs(output.elapsedSeconds() - 1) < 0.0001,
    'content time follows both rates without jumping at the live change')
  context.currentTime = 2.9
  output.setRate(1.25)
  assert.equal(sources[3].stopped, undefined,
    'a delayed ended callback must not make the already-playing next section restart')
  assert.equal(sources[3].playbackRate.value, 1.25)
  assert.ok(Math.abs(output.elapsedSeconds() - 1.6) < 0.0001,
    'progress includes audio-clock-complete sections even before their callbacks run')
  sources[1].onended()
  assert.deepEqual(completed, [['first', 1.5]])
  sources[3].onended()
  assert.deepEqual(completed, [['first', 1.5], ['second', 1]])
  output.dispose()
  assert.equal(sources[0].stopped, true, 'the silent keepalive is released')
  assert.equal(worklet.disconnected, true)
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

test('speech frames concatenate into one semantic section without reordering', () => {
  assert.deepEqual(
    [...concatAudioFrames([
      Float32Array.from([1, 2]),
      Float32Array.from([3, 4, 5]),
      Float32Array.from([6, 7]),
    ])],
    [1, 2, 3, 4, 5, 6, 7],
  )
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

test('quiet final consonants remain in the spoken tail', () => {
  const output = []
  const trimmer = createSpeechBoundaryTrimmer({
    sampleRate: 1_000,
    windowMs: 10,
    fadeMs: 0,
    leadingPaddingMs: 0,
    trailingHoldMs: 100,
    onSamples: (samples) => output.push(...samples),
  })
  trimmer.push(Float32Array.from([
    ...new Array(100).fill(0.25),
    ...new Array(10).fill(0.002),
    ...new Array(100).fill(0),
  ]))
  trimmer.flush()
  assert.equal(output.length, 210,
    'the quieter final phoneme plus its 100 ms padding must survive')
  assert.equal(output.slice(100, 110).every((sample) => Math.abs(sample - 0.002) < 0.00001), true)
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

test('streaming playback gives complete semantic sections to one audio-clock queue', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('PROGRESS_TICK_MS = 250'))
  assert.ok(listen.includes('partFrames.push(samples)'))
  assert.ok(listen.includes('concatAudioFrames(partFrames, partSamples)'))
  assert.ok(listen.includes('scheduled = output.play(samples'))
  assert.ok(listen.includes('pendingSegments += 1'))
  assert.ok(listen.includes('generatedContentSeconds += scheduled.logicalDuration'))
  assert.doesNotMatch(listen, /const queue = \[\]|activeSegment|pumpQueue/)
  assert.ok(listen.includes('createSpeechBoundaryTrimmer'))
  assert.ok(listen.includes('window.setTimeout(updateProgress, PROGRESS_TICK_MS)'))
  assert.doesNotMatch(listen, /requestAnimationFrame\(animate\)/)
  assert.doesNotMatch(listen, /createAudioFrameBatcher|nextAtRef|sourcesRef/)
  assert.ok(listen.includes('onAudio: (samples) =>'))
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
  assert.ok(listen.includes('hints,'))
  assert.ok(listen.includes('document: speechBatch'))
  assert.doesNotMatch(listen, /applySpeechHints/)
  assert.doesNotMatch(prompt + fetch + listen, /speechPauses|pauseStrength|raw_pauses/)
  assert.doesNotMatch(listen, /normalizeSpeechText/)
})

test('streaming progress is honest and aligned inside the player copy', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const speech = readRepoFile('speech-capability.js')
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
  assert.ok(speech.includes("session.on('loading'"))
  assert.ok(speech.includes("session.on('audio'"))
  assert.doesNotMatch(listen, /preparing \$\{prepared\.current\} of \$\{prepared\.total\}/)
  assert.ok(!listen.includes('setPrepared('))
  assert.ok(theme.includes('.nw-listen-copy { display: block; min-width: 0; flex: 1; }'))
  assert.ok(theme.includes('position: relative; display: block; width: 100%; height: 3px'))
})

test('playback completion has one finalizer for every stream ending order', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(listen, /const finishPlayback = \(\) =>/)
  assert.equal((listen.match(/setPhase\('finished'\)/g) || []).length, 1)
  assert.equal((listen.match(/finishPlayback\(\)/g) || []).length, 2,
    'both generation-last and playback-last order converge on the same guarded finalizer')
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

test('playback speed is live, pitch-preserving, and leaves the content clock stable', () => {
  const parts = [
    { text: 'A short opening sentence', pauseMs: 900 },
    { text: 'A second sentence closes the report', pauseMs: 0 },
  ]
  const ordinary = estimateSpeechDuration(parts)
  assert.equal(createSpeechTimeline(parts).initialDuration, ordinary)
  assert.deepEqual(PLAYBACK_RATES, [1, 1.25, 1.5, 2])
  assert.equal(normalizePlaybackRate('1.5'), 1.5)
  assert.equal(normalizePlaybackRate(3), 1)

  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const media = readRepoFile('speech-media.js')
  assert.ok(listen.includes('playbackOutputRef.current?.setRate(rate)'))
  assert.ok(listen.includes("durableWrite('playback.json', next)"))
  assert.ok(listen.includes('aria-label="Playback speed"'))
  assert.ok(listen.includes('Playback speed · pitch preserved'))
  assert.doesNotMatch(listen, /disabled=\{active\}/)
  assert.ok(media.includes('setParam(current.source?.playbackRate, next, at)'))
  assert.ok(media.includes('setParam(workletRate, next, at)'))
  assert.ok(media.includes('source.start(scheduledStart)'))
})

test('playback settings preserve rate and resume only the exact report content', () => {
  const segments = [
    { text: 'Opening', kind: 'title', pauseAfterMs: 900 },
    { text: 'First paragraph', kind: 'paragraph', pauseAfterMs: 500 },
    { text: 'Second paragraph', kind: 'paragraph', pauseAfterMs: 0 },
  ]
  const key = speechReportKey('2026-08-29', segments)
  const changed = playbackSettingsWithResume(
    playbackSettingsWithRate(null, 1.5),
    { reportKey: key, nextSegment: 1 },
  )
  assert.deepEqual(normalizePlaybackSettings(changed), {
    rate: 1.5,
    resume: { reportKey: key, nextSegment: 1 },
  })
  assert.equal(resumeSegmentFor(changed, key, segments.length), 1)
  assert.equal(resumeSegmentFor(changed, `${key}-changed`, segments.length), null)
  assert.equal(resumeSegmentFor(changed, key, 1), null)
  assert.deepEqual(playbackSettingsWithResume(changed, null), { rate: 1.5 })

  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('Resume this digest'))
  assert.ok(listen.includes('Continue from section'))
  assert.ok(listen.includes('Start over'))
  assert.ok(listen.includes('void saveResume(absoluteIndex + 1)'))
  assert.ok(listen.includes('Another voice session started. Resume here whenever you’re ready.'))
  assert.ok(listen.indexOf('void saveResume(startIndex)') < listen.indexOf('await readVoiceCatalog'),
    'leaving during slow engine startup must still preserve the restart boundary')
  assert.ok(listen.indexOf('void saveResume(startIndex)') > listen.indexOf('await mediaBridge.start()'),
    'unsupported media playback must not create a false resume checkpoint')
})

test('shared generation keeps benchmark instrumentation out of the listening path', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const speech = readRepoFile('speech-capability.js')
  assert.doesNotMatch(speech + listen,
    /firstAudioMs|audioDuration|realtime|performance\.now|longTask|page stalls/)
  assert.ok(speech.includes('return await session.result'))
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

test('manual report generation asks for confirmation before either entry point starts a run', () => {
  const app = readRepoFile('index.jsx')
  const reports = readRepoFile(join('ui', 'ReportsTab.jsx'))
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.ok(app.includes('Generate a new report?'))
  assert.ok(app.includes('This may replace today’s digest.'))
  assert.ok(app.includes('aria-modal="true"'))
  assert.ok(app.includes('event.key === \'Escape\''))
  assert.ok(app.includes('start?.()'))
  assert.ok(reports.includes('onRequestGenerate?.(handleGenerate)'))
  assert.ok(settings.includes('onRequestGenerate?.(handleRunNow)'))
  assert.ok(!reports.includes('onClick={handleGenerate}'))
  assert.ok(!settings.includes('onClick={handleRunNow}'))
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
  assert.match(theme, /\.nw-reader-bar\s*\{[\s\S]*width:\s*min\(100%,\s*760px\);\s*margin-inline:\s*auto;/)
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

test('immediate listening saves roll back only the latest refused choice', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  assert.ok(settings.includes('const savePreferencesSeqRef = useRef(0)'))
  assert.ok(settings.includes('const savePreferencesQueueRef = useRef(Promise.resolve())'))
  assert.ok(settings.includes('const durablePreferencesRef = useRef(preferences)'))
  assert.ok(settings.includes('const sequence = ++savePreferencesSeqRef.current'))
  assert.ok(settings.includes('savePreferencesQueueRef.current.then(write, write)'))
  assert.ok(settings.includes('if (outcome.durable) durablePreferencesRef.current = next'))
  assert.ok(settings.includes('sequence !== savePreferencesSeqRef.current'))
  assert.ok(settings.includes('if (override) setPreferences(durablePreferencesRef.current)'))
  assert.ok(settings.includes("void savePreferences('listening', next)"))
})

test('the pre-install Voice icon records its copied-artwork provenance', () => {
  const icon = readRepoFile('voice-icon.js')
  assert.ok(icon.includes('Voice v1.12.8'))
  assert.ok(icon.includes('before Voice exists'))
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

test('News no longer redistributes the shared Voice runtime', () => {
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.equal(manifest.source_files.some((name) => /XN-RUNTIME|THIRD_PARTY|browser-tts/.test(name)), false)
})
