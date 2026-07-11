import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideGenerateOutcome, selectRefreshTriggers } from '../domain.js'
import { isErrorReport } from '../report-schema.mjs'
import { EFFORT_LEVELS, defaultEffort } from '../constants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const repo = join(HERE, '..')
const readRepoFile = (name) => readFileSync(join(repo, name), 'utf8')

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
  assert.ok(reports.includes('const ready = handle.ready ? await handle.ready.catch(() => false) : true'))
  assert.ok(reports.includes('navRef.current?.close?.()'))
  assert.ok(reports.includes('if (ready === false)'))

  assert.ok(picker.includes("window.mobius.nav.open('news-model-picker'"))
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
  assert.match(theme, /\.nw-picker-backdrop\s*\{[\s\S]*padding-bottom:\s*max\(16px,\s*env\(safe-area-inset-bottom\)\)/)
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
  assert.ok(settings.includes("JSON.stringify({ cron, job: 'fetch.sh', timezone })"))
  assert.ok(settings.includes('{ ...schedule, timezone, cron }'))
  assert.ok(settings.includes('item_updated'))
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
  assert.ok(settings.includes('fallback_effort: fallbackProvider ? effortForProvider(fallbackProvider, fallbackEffort) : null'))
  assert.ok(settings.includes('fallback_effort: nextProvider ? nextEffort : null'))
  assert.ok(settings.includes('fallback_effort: fallbackProvider ? nextEffort : null'))
  // newest-wins guard: a stale response applies neither its toast nor rollback.
  assert.ok(settings.includes('saveAgentSeqRef'))
  assert.ok(settings.includes('seq !== saveAgentSeqRef.current'))
  assert.ok(settings.includes("type: 'editorial_brief'"))
  assert.ok(settings.includes('reset: false'))
  assert.ok(settings.includes('reset: true'))
})

test('settings writes agent.json with exactly the six effort-aware keys', () => {
  const settings = readRepoFile(join('ui', 'SettingsTab.jsx'))
  const writes = [...settings.matchAll(/agent\.json`, token,\n\s+\{\n([\s\S]*?)\n\s+\},\n\s+appId,/g)]
  assert.equal(writes.length, 4, 'primary, effort, fallback, and fallback-effort saves')
  const expected = ['provider', 'model', 'effort', 'fallback_provider', 'fallback_model', 'fallback_effort']
  for (const [, body] of writes) {
    const keys = [...body.matchAll(/^\s+([a-z_]+):/gm)].map((m) => m[1])
    assert.deepEqual(keys, expected)
  }
  assert.ok(settings.includes('stored.effort'))
  assert.ok(settings.includes('stored.fallback_effort'))
  assert.ok(settings.includes('<EffortStepper'))
  const primaryModeKey = ['primary', 'agent', 'mode'].join('_')
  const secondaryModeKey = ['secondary', 'agent', 'mode'].join('_')
  assert.ok(!settings.includes(primaryModeKey))
  assert.ok(!settings.includes(secondaryModeKey))
})

test('fetch.sh resolves and retries a configured fallback agent', () => {
  const sh = readRepoFile('fetch.sh')
  assert.ok(sh.includes('GLOBAL_AGENT_FILE="/data/shared/agent-settings.json"'))
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
  const primaryModeKey = ['primary', 'agent', 'mode'].join('_')
  const secondaryModeKey = ['secondary', 'agent', 'mode'].join('_')
  assert.ok(!sh.includes(primaryModeKey))
  assert.ok(!sh.includes(secondaryModeKey))
})

test('mechanical manifest and token fixes stay in place', () => {
  const manifest = JSON.parse(readRepoFile('mobius.json'))
  const theme = readRepoFile('theme.js')
  assert.equal(manifest.version, '1.14.0')
  assert.equal(manifest.embeds_agent, true)
  assert.ok(manifest.source_files.includes('ui/EffortStepper.jsx'))
  assert.deepEqual(manifest.offline, { reads: true, writes: 'queued', execution: 'none' })
  assert.ok(!/color:\s*#fff/.test(theme))
  assert.ok(!/color:\s*var\(--bg\)/.test(theme))
  assert.ok(theme.includes('color: var(--accent-fg)'))
  assert.ok(theme.includes('min-height: 44px; min-width: 44px'))
  assert.ok(theme.includes('.nw-empty__mark'))
})
