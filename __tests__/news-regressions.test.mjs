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
import { isErrorReport } from '../report-schema.mjs'
import { EFFORT_LEVELS, defaultEffort } from '../constants.js'
import {
  STARTER_TOPICS,
  normalizePreferences,
} from '../preferences.js'
import { canReorderAgentSlots, reorderAgentSlots } from '../ui/backgroundAgentOrder.js'
import {
  TTS_MODEL_PACK_BYTES,
  TTS_MODEL_PACK_STORED_BYTES,
  TTS_MODEL_PACKAGE,
} from '../tts-model-pack.js'
import { createSpeechTimeline, estimateSpeechDuration } from '../speech-timeline.js'

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
  assert.match(fields, /English, French, German, Spanish,[\s\S]*Portuguese, and Italian/)
  assert.match(fields, /Off by default\. Nothing is downloaded to this device or stored on the server\./)
  assert.match(fields, /Download on this device · about 186 MB/)
  assert.match(fields, /About 186 MB is stored only in this browser/i)
  assert.match(fields, /0 MB to the server/i)
  assert.match(fields, /News uses native compression, without PyTorch or scientific dependencies/)
  assert.match(fields, /!value\.tts\.enabled \? \(/)
  assert.equal(manifest.storage_seeds['preferences.json'].tts.enabled, false)
  assert.ok(!fields.includes('nw-tts-language'))
  const normalized = normalizePreferences({
    tts: { enabled: true, language: 'french_24l', voice: 'estelle' },
  })
  assert.equal(normalized.tts.language, 'english')
  assert.equal(normalized.tts.voice, 'alba')
})

test('News has one clear editorial brief rather than hidden prompt additions', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const fetch = readRepoFile('fetch.sh')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.doesNotMatch(settings, /Advanced|prompt-additions/)
  assert.doesNotMatch(fetch, /prompt-additions|Advanced system prompt additions/)
  assert.equal(Object.hasOwn(manifest.storage_seeds, 'prompt-additions.txt'), false)
})

test('report listening resumes audio in the tap before loading browser speech', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.ok(listen.includes('await context.resume()'))
  assert.ok(listen.includes('await engine.load({'))
  assert.ok(
    listen.indexOf('await context.resume()') < listen.indexOf('await engine.load({'),
    'mobile audio context must resume before the network await',
  )
  assert.ok(listen.includes('engine.generate(part.text'))
  assert.ok(listen.includes("setSpeechBackend(loaded?.backend || '')"))
  assert.ok(listen.includes("speechBackend === 'webgpu' ? 'WebGPU'"))
})

test('Pocket TTS inference remains app-owned and runs off the reader main thread', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const browser = readRepoFile('browser-tts.js')
  const runtime = readRepoFile('jax-pocket-tts-vendor.js')
  const worker = readRepoFile('browser-tts-worker-entry.js')
  const digestJob = readRepoFile('fetch.sh')
  const notices = readRepoFile('THIRD_PARTY_NOTICES.md')
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  assert.ok(listen.includes("from '../browser-tts.js'"))
  assert.ok(browser.includes("from './browser-tts-worker-source.js'"))
  assert.ok(worker.includes("from './jax-pocket-tts-vendor.js'"))
  assert.ok(browser.includes('streamTtsModelPack({'))
  assert.ok(worker.includes("new DecompressionStream('gzip')"))
  assert.ok(worker.includes('modelBytes = new Uint8Array(MODEL_BYTES)'))
  assert.ok(worker.includes("post('audio'"))
  assert.ok(browser.includes("type: 'audio-ack'"))
  assert.doesNotMatch(runtime, /huggingface\.co/)
  assert.match(notices, /ekzhang\/jax-js-models[\s\S]*90ca1cf21ddd4d3daef539d4c90104f727b71169/)
  assert.match(notices, /Creative Commons Attribution 4\.0/)
  assert.ok(runtime.includes('webgpu'))
  assert.ok(browser.includes("features?.has('shader-f16')"))
  assert.ok(browser.indexOf('requirePocketTtsWebGpu(signal)')
    < browser.indexOf('this.runtime.load({'),
  'unsupported browsers must fail before reading the device pack')
  assert.ok(runtime.includes('await Zo("webgpu")'))
  assert.doesNotMatch(runtime, /await Zo\("webgpu","wasm"\)/)
  assert.doesNotMatch(listen + browser, /\/services\/|fetch\([^)]*["'`]\/speech\//)
  assert.doesNotMatch(digestJob, /torch|numpy|scipy|pip install/i)
  assert.doesNotMatch(digestJob, /Pocket TTS|model\.safetensors|install-request/)
  assert.ok(manifest.source_files.includes('tts-model-pack.js'))
  assert.ok(manifest.source_files.includes('jax-pocket-tts-vendor.js'))
  assert.ok(manifest.source_files.includes('browser-tts-worker-source.js'))
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
  assert.ok(listen.includes('const engine = browserSpeechEngine(appId, token)'))
  assert.ok(listen.includes('await engine.load({'))
  assert.ok(setup.includes('await prepareTtsModelPack(appId, token'))
  assert.ok(settings.includes('await prepareTtsModelPack(appId, token'))
  assert.match(settings, /useState\(\{ state: 'idle', progress: 0, message: '' \}\)/,
    'an optional browser cache probe must never block Settings behind a checking state')
  const finishBody = setup.slice(setup.indexOf('const finish = async'), setup.indexOf('if (loading)'))
  assert.doesNotMatch(finishBody, /prepareTtsModelPack|run-job/,
    'Finish setup must not silently start the optional download')
  assert.ok(browser.includes('streamTtsModelPack({'))
  assert.ok(pack.includes("TTS_DEVICE_ASSET_CAPABILITY = 'device.asset-cache'"))
  assert.ok(pack.includes("openPackage('install')"))
  assert.doesNotMatch(pack, /completedBytes/, 'model streaming must not reference an undeclared counter')
  assert.equal(TTS_MODEL_PACK_BYTES, 236_309_943)
  assert.equal(TTS_MODEL_PACK_STORED_BYTES, 185_927_736)
  assert.equal(TTS_MODEL_PACKAGE.assets.length, 3)
  assert.equal(TTS_MODEL_PACKAGE.assets[2].chunks.length, 23)
  assert.equal(
    TTS_MODEL_PACKAGE.assets.reduce((total, asset) => total + asset.bytes, 0),
    TTS_MODEL_PACK_STORED_BYTES,
  )
  assert.equal(TTS_MODEL_PACKAGE.assets.every((asset) => (
    asset.chunks.every((chunk) => chunk.bytes <= 8_388_608 && /^[a-f0-9]{64}$/.test(chunk.sha256))
  )), true)
  assert.match(TTS_MODEL_PACKAGE.assets[2].url, /releases\/download\/tts-assets-v1/)
  assert.match(pack, /0 MB|server/)
  assert.ok(readRepoFile(join('ui', 'PreferenceFields.jsx')).includes('every device or'))
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
  assert.ok(listen.includes('scheduleSilence(parts[index].pauseMs)'))
  assert.ok(listen.includes('new Float32Array(sampleCount)'))
  assert.doesNotMatch(listen, /replace\(\/.+?<[^>]+>/,
    'speech structure must not regress to flattening report HTML with a tag regex')
})

test('the warm News frame reuses its hydrated voice until that frame unmounts', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const resetStart = listen.indexOf('const resetPlayback = useCallback')
  const cleanupStart = listen.indexOf('useEffect(() => () => {', resetStart)
  const resetBody = listen.slice(resetStart, cleanupStart)
  assert.doesNotMatch(resetBody, /releaseBrowserSpeechEngine/)
  assert.match(listen.slice(cleanupStart), /resetPlayback\('idle'\)[\s\S]*releaseBrowserSpeechEngine\(\)/)
  assert.doesNotMatch(listen, /moebius:frame-visibility/)
})

test('semantic pauses remain distinct without making the reading languid', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(listen, /title: 420/)
  assert.match(listen, /section: 360/)
  assert.match(listen, /paragraph: 180/)
  assert.match(listen, /caption: 180/)
})

test('report agent owns spoken forms and descriptive image captions enter listening', () => {
  const prompt = readRepoFile('system-prompt.md')
  const fetch = readRepoFile('fetch.sh')
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  assert.match(prompt, /report agent—not app-side text replacement/i)
  assert.match(prompt, /Always include the visible masthead date/)
  assert.match(prompt, /Describe what the image visibly shows/)
  assert.match(prompt, /caption is visible and is read aloud/i)
  assert.ok(fetch.includes('application/mobius-speech+json'))
  assert.ok(listen.includes('applySpeechHints'))
  assert.doesNotMatch(listen, /normalizeSpeechText/)
})

test('streaming progress is honest and aligned inside the player copy', () => {
  const listen = readRepoFile(join('ui', 'ListenControls.jsx'))
  const theme = readRepoFile('theme.js')
  assert.ok(listen.includes("streamReady && duration > 0"))
  assert.ok(listen.includes("${durationExact ? '' : '~'}${clock(duration)}"))
  assert.ok(listen.includes("phase === 'loading' && loadingProgress > 0 ? 'Loading voice…'"))
  assert.ok(listen.includes('progressRef.current = Math.max('))
  assert.ok(listen.includes('await paceSynthesis('))
  assert.ok(listen.includes("nw-listen-track${streamReady || loadingProgress > 0 ? '' : ' is-building'}"))
  assert.ok(listen.includes('role="progressbar"'))
  assert.doesNotMatch(listen, /preparing \$\{prepared\.current\} of \$\{prepared\.total\}/)
  assert.ok(!listen.includes('setPrepared('))
  assert.ok(theme.includes('.nw-listen-copy { display: block; min-width: 0; flex: 1; }'))
  assert.ok(theme.includes('position: relative; display: block; width: 100%; height: 3px'))
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

test('jax-js awaits each delivered audio frame so News can pace GPU inference', () => {
  const runtime = readRepoFile('jax-pocket-tts-vendor.js')
  assert.ok(runtime.includes('await E,mt(s),await o?.($)'))
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
  assert.ok(sh.includes('write_run_status "error" "failed to fetch system-prompt.md'), 'early error terminal')
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
  assert.ok(reports.includes('const ready = handle.ready ? await handle.ready.catch(() => false) : true'))
  assert.ok(reports.includes('navRef.current?.close?.()'))
  assert.ok(reports.includes('if (ready === false)'))

  assert.ok(picker.includes('window.mobius.nav.open(navKey'))
  assert.ok(picker.includes('const ready = handle.ready ? await handle.ready.catch(() => false) : true'))
  assert.ok(picker.includes('navRef.current?.close?.()'))
  assert.ok(picker.includes('if (ready === false)'))
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

test('ReportReader mounts text immediately and delivers proxied images progressively', () => {
  const reader = readRepoFile(join('ui', 'ReportReader.jsx'))
  const domain = readRepoFile('domain.js')
  assert.ok(reader.includes('/api/proxy?url=${encodeURIComponent(src)}'))
  assert.ok(reader.includes('Authorization: `Bearer ${token}`'))
  assert.ok(reader.includes('Promise.allSettled'))
  assert.ok(reader.includes('buildHtmlSrcDoc(report)'))
  assert.ok(reader.includes("type: 'news:report-images'"))
  assert.ok(reader.includes('report && report.html && ('))
  assert.ok(domain.includes("child.setAttribute('data-news-source', src)"))
  assert.ok(!reader.includes('imagesSettled'))
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
  assert.ok(sh.includes('from app.background_agents import resolve_background_agents'))
  assert.ok(sh.includes('resolve_background_agents(data_dir, app)'))
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
  assert.ok(sh.includes("Route through the platform's ONE canonical resolver"))
})

test('mechanical manifest and token fixes stay in place', () => {
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  const pkg = JSON.parse(readRepoFile('package.json'))
  const theme = readRepoFile('theme.js')
  assert.equal(manifest.version, pkg.version)
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
