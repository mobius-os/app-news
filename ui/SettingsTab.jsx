import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  DEFAULT_PROVIDER,
  DEFAULT_MODEL,
  DEFAULT_SCHEDULE,
  DEFAULT_TOPICS,
  EFFORT_LEVELS,
  FALLBACK_GROUPS,
  defaultEffort,
} from '../constants.js'
import {
  parseSchedule,
  buildCron,
  timeValue,
  normalizeSeededTopics,
  buildProviderGroups,
  getBrowserTimezone,
} from '../domain.js'
import {
  getText,
  getJSON,
  putText,
  putJSON,
  classifyWriteOutcome,
  readTopicsCache,
  writeTopicsCache,
} from '../storage.js'
import {
  TOPICS_PLACEHOLDER,
  normalizePreferences,
} from '../preferences.js'
import { ModelPicker } from './ModelPicker.jsx'
import { EffortStepper } from './EffortStepper.jsx'
import { BackgroundAgentList } from './BackgroundAgentList.jsx'
import { agentSlotLabel, canReorderAgentSlots, reorderAgentSlots } from './backgroundAgentOrder.js'
import { SourcePreferenceFields, TtsPreferenceFields } from './PreferenceFields.jsx'
import {
  isTtsModelPackCancellation,
  prepareTtsModelPack,
  presentTtsModelPackStatus,
  readTtsModelPackStatus,
} from '../tts-model-pack.js'

function effortForProvider(provider, value) {
  const levels = EFFORT_LEVELS[provider] || []
  return levels.some((level) => level.value === value)
    ? value
    : defaultEffort(provider)
}

function agentPayload({
  primaryMode,
  provider,
  model,
  effort,
  secondaryMode,
  fallbackProvider,
  fallbackModel,
  fallbackEffort,
}) {
  const primaryOverride = primaryMode === 'app'
  const secondaryOverride = secondaryMode === 'app'
  return {
    primary_agent_mode: primaryOverride ? 'app' : 'system',
    provider: primaryOverride ? (provider || null) : null,
    model: primaryOverride ? (model || null) : null,
    effort: primaryOverride ? (effortForProvider(provider, effort) || null) : null,
    secondary_agent_mode: secondaryOverride ? 'app' : 'system',
    fallback_provider: secondaryOverride ? (fallbackProvider || null) : null,
    fallback_model: secondaryOverride && fallbackProvider ? (fallbackModel || null) : null,
    fallback_effort: secondaryOverride && fallbackProvider
      ? (effortForProvider(fallbackProvider, fallbackEffort) || null)
      : null,
  }
}

export function SettingsTab({
  appId,
  token,
  online,
  initialPreferences,
  onPreferencesChange,
  onSetupComplete,
}) {
  const [topics, setTopics] = useState('')
  const [preferences, setPreferences] = useState(() => normalizePreferences(initialPreferences))
  // agent state: provider + model picked together; effort follows provider.
  const [provider, setProvider] = useState(DEFAULT_PROVIDER)
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [effort, setEffort] = useState(defaultEffort(DEFAULT_PROVIDER))
  const [primaryAgentMode, setPrimaryAgentMode] = useState('system')
  const [fallbackProvider, setFallbackProvider] = useState('')
  const [fallbackModel, setFallbackModel] = useState('')
  const [fallbackEffort, setFallbackEffort] = useState('')
  const [secondaryAgentMode, setSecondaryAgentMode] = useState('system')
  // Provider groups (shape: { key, label, models: [{id, name}] }).
  // Populated from `GET /api/auth/providers/models` on mount; falls
  // back to FALLBACK_GROUPS when the endpoint is missing (older
  // mobius) or unreachable. We initialise to null (rather than the
  // fallback) so the picker can show a "Loading models…" hint
  // distinct from the fallback render.
  const [providerGroups, setProviderGroups] = useState(null)
  // null = still loading; otherwise a Set of provider ids that
  // are authenticated. Null is treated as "show everything as
  // connected" so the picker isn't blocked if the status endpoint
  // errors. Same fallback as the shell's ChatSettingsPanel.
  const [connectedProviders, setConnectedProviders] = useState(null)
  const [schedule, setSchedule] = useState(DEFAULT_SCHEDULE)
  const [loading, setLoading] = useState(true)
  // True when the brief currently in the textarea was NOT read live from
  // the server this session (offline cache fallback, or bundled default
  // because there was no cache). Saving a stale brief offline would queue
  // an overwrite of the real server copy, so Save is gated until the user
  // either loads it live or edits it themselves (an intentional change).
  const [topicsStale, setTopicsStale] = useState(false)
  const [topicsToast, setTopicsToast] = useState('')
  // Separate error channel so a refused/lost save paints red (matching
  // scheduleError/runNowError below), never a green "Saved" — the two never
  // show at once because each save clears the other.
  const [topicsError, setTopicsError] = useState('')
  const [preferencesToast, setPreferencesToast] = useState('')
  const [preferencesError, setPreferencesError] = useState('')
  const [preferencesTarget, setPreferencesTarget] = useState('')
  const [ttsSetup, setTtsSetup] = useState({ state: 'idle', progress: 0, message: '' })
  const [agentToast, setAgentToast] = useState('')
  const [agentError, setAgentError] = useState('')
  const [scheduleToast, setScheduleToast] = useState('')
  const [scheduleError, setScheduleError] = useState('')
  // Run-now affordance state. The button delegates to the same
  // /api/apps/<id>/run-job endpoint the Reports tab uses for
  // "Generate report now" — Settings just gets a compact entry-point
  // next to the schedule info so the owner can pull a digest on demand.
  const [runNowBusy, setRunNowBusy] = useState(false)
  const [runNowToast, setRunNowToast] = useState('')
  const [runNowError, setRunNowError] = useState('')
  // Sync in-flight guard for Run-now. `runNowBusy` (state) drives
  // both the button label and `disabled`, but setState is async —
  // two rapid clicks can both clear the runNowBusy check from their
  // closures before disabled propagates to the DOM. The ref flips
  // synchronously, before the first `await`, so the second click's
  // POST never fires.
  const runNowRef = useRef(false)
  // Newest-wins guard for agent-setting saves. Rapid picks (A then B) race: if
  // A's slow save resolves as a failure AFTER B's fast save already persisted,
  // A's rollback would revert the UI to the state before A, discarding B's
  // durable choice. Each save captures a monotonically increasing token; a
  // response whose token is no longer the latest is stale and applies neither
  // its toast nor its rollback. Mirrors the shell's patchChat 'ok'/'stale'/
  // 'fail' guard.
  const saveAgentSeqRef = useRef(0)
  // Time pickers can emit another change while a prior schedule update is
  // still in flight. Keep those writes ordered so the last time the user
  // chose is also the last value persisted by the server.
  const scheduleSaveChainRef = useRef(Promise.resolve())
  const scheduleSaveSeqRef = useRef(0)

  useEffect(() => {
    (async () => {
      // Start this alongside the ordinary Settings reads, but do not make the
      // whole form wait for a browser cache that may be unavailable.
      const ttsStatusPromise = readTtsModelPackStatus()
      const [tRes, aRes, pRes, mRes, sRes] = await Promise.all([
        getText(`/api/storage/apps/${appId}/topics.txt`, token, appId),
        getJSON(`/api/storage/apps/${appId}/agent.json`, token, appId),
        getJSON(`/api/auth/providers/status`, token),
        getJSON(`/api/auth/providers/models`, token),
        getJSON(`/api/storage/apps/${appId}/schedule.json`, token, appId),
      ])
      // Brief: prefer the live server read and refresh the offline
      // cache from it. When the read fails (offline / transient), fall
      // back to the cached brief so the textarea shows the user's real
      // brief — NOT DEFAULT_TOPICS, which a subsequent Save would
      // otherwise persist over the real brief on reconnect. Only fall
      // all the way back to the bundled default when there's no cache.
      if (tRes.ok) {
        const liveTopics = normalizeSeededTopics(tRes.data)
        setTopics(liveTopics)
        writeTopicsCache(appId, liveTopics)
        setTopicsStale(false)
      } else {
        const cached = readTopicsCache(appId)
        setTopics(cached != null ? cached : DEFAULT_TOPICS)
        // No live read landed — mark the brief stale so an offline Save
        // can't overwrite the server copy with an un-loaded value.
        setTopicsStale(true)
      }
      setSchedule(parseSchedule(sRes.ok ? sRes.data : null))
      // Stitch the model list into PROVIDER_ORDER, or fall back if
      // the endpoint isn't there (older mobius / offline).
      const groups = mRes.ok ? buildProviderGroups(mRes.data) : FALLBACK_GROUPS
      setProviderGroups(groups)
      // Build the connected set FIRST so we can compute a sensible
      // default for an un-seeded agent.json (first model of the
      // first connected provider).
      let connected = null
      if (pRes.ok && pRes.data && typeof pRes.data === 'object') {
        connected = new Set(
          Object.entries(pRes.data)
            .filter(([, v]) => v && v.authenticated)
            .map(([k]) => k),
        )
        setConnectedProviders(connected)
      }
      // Resolve provider + model from the stored agent.json, falling
      // back to the first model of the first connected provider, then
      // to the bundled defaults.
      const stored = aRes.ok && aRes.data ? aRes.data : null
      const storedProvider = stored && typeof stored.provider === 'string'
        ? stored.provider : null
      const storedModel = stored && typeof stored.model === 'string'
        ? stored.model : null
      const storedEffort = stored && typeof stored.effort === 'string'
        ? stored.effort : null
      const storedFallbackProvider = stored && typeof stored.fallback_provider === 'string'
        ? stored.fallback_provider : null
      const storedFallbackModel = stored && typeof stored.fallback_model === 'string'
        ? stored.fallback_model : null
      const storedFallbackEffort = stored && typeof stored.fallback_effort === 'string'
        ? stored.fallback_effort : null
      // New installs inherit the ordered Background agents from Möbius
      // Settings. Preserve a legacy News pin as an app override so this
      // migration never silently changes an existing owner's curator.
      const storedPrimaryMode = stored?.primary_agent_mode
      const legacyPrimaryOverride = !storedPrimaryMode
        && Boolean(storedProvider || storedModel || storedEffort)
      setPrimaryAgentMode(
        storedPrimaryMode === 'app' || storedPrimaryMode === 'custom' || legacyPrimaryOverride
          ? 'app'
          : 'system',
      )
      const storedSecondaryMode = stored?.secondary_agent_mode
      const legacySecondaryOverride = !storedSecondaryMode
        && Boolean(storedFallbackProvider || storedFallbackModel || storedFallbackEffort)
      setSecondaryAgentMode(
        storedSecondaryMode === 'app' || storedSecondaryMode === 'custom' || legacySecondaryOverride
          ? 'app'
          : 'system',
      )
      const knownProvider = groups.find(g => g.key === storedProvider)
      if (knownProvider) {
        setProvider(knownProvider.key)
        // Trust the persisted model id even if it isn't in the fetched
        // list — the user (or a future shell update) may know about a
        // model we haven't surfaced yet. fetch.sh just passes --model
        // through; the CLI is the source of truth. The optional chain on
        // models[0] tolerates a model-less group rather than throwing.
        setModel(storedModel || knownProvider.models?.[0]?.id || '')
        setEffort(effortForProvider(knownProvider.key, storedEffort))
      } else {
        // No (valid) saved agent.json — pick the first model of the
        // first CONNECTED provider so the user lands on something
        // that will actually run. Falls back to the first model of
        // the first group when nothing is connected.
        let chosen = null
        if (connected) {
          for (const g of groups) {
            if (connected.has(g.key) && g.models?.length) { chosen = g; break }
          }
        }
        if (!chosen) chosen = groups.find(g => g.models?.length) || null
        if (chosen) {
          setProvider(chosen.key)
          setModel(chosen.models[0].id)
          setEffort(defaultEffort(chosen.key))
        }
      }
      const knownFallback = groups.find(g => g.key === storedFallbackProvider)
      if (knownFallback) {
        setFallbackProvider(knownFallback.key)
        setFallbackModel(storedFallbackModel || knownFallback.models?.[0]?.id || '')
        setFallbackEffort(effortForProvider(knownFallback.key, storedFallbackEffort))
      }
      setLoading(false)
      setTtsSetup(presentTtsModelPackStatus(await ttsStatusPromise))
    })()
  }, [appId, token])

  // A write is durable only when it landed online ({synced}) or was queued
  // offline for guaranteed later drain ({queued}). Any other shape — most
  // notably putText/putJSON's failure return {ok:false, status} — is a LOST
  // write: the value reached neither the server nor the offline queue.
  // toastFor classifies the result so callers never report a failed write as
  // success, never clear the stale guard on failure, and never overwrite the
  // offline cache with a value the server didn't accept. `durable` drives both
  // the message and which toast color the caller paints (green vs red), so a
  // dead-letter (durableWrite's {ok:false, deadLetter:true} — the server
  // REFUSED the value, 413/400/403) can never read as a green "Saved". The
  // classification itself lives in the pure, tested classifyWriteOutcome.
  const toastFor = classifyWriteOutcome

  // Show a save outcome on exactly one channel: the green success toast for a
  // durable write, the red error toast for a lost/refused one. Clearing the
  // other channel keeps the two from ever showing together.
  const showTopicsOutcome = (outcome) => {
    if (outcome.durable) { setTopicsError(''); setTopicsToast(outcome.msg); setTimeout(() => setTopicsToast(''), 2000) }
    else { setTopicsToast(''); setTopicsError(outcome.msg); setTimeout(() => setTopicsError(''), 3000) }
  }

  const saveTopics = useCallback(async () => {
    const res = await putText(
      `/api/storage/apps/${appId}/topics.txt`, token, topics, appId,
    )
    const outcome = toastFor(res)
    if (outcome.durable) {
      // Confirmed durable (synced or queued): the brief in the textarea is
      // now the intended value — keep the offline cache in lockstep so a
      // later offline open shows it, and drop the stale guard.
      writeTopicsCache(appId, topics)
      setTopicsStale(false)
      window.mobius?.signal?.('item_updated', {
        type: 'editorial_brief',
        chars: topics.length,
        reset: false,
      })
      onSetupComplete?.()
    }
    // On failure, leave topicsStale and the cache untouched so the form stays
    // dirty and a retry (or reconnect) still saves the real edit.
    showTopicsOutcome(outcome)
  }, [appId, token, topics, onSetupComplete])

  const savePreferences = useCallback(async (target, override = null) => {
    setPreferencesTarget(target)
    setPreferencesToast('')
    setPreferencesError('')
    const next = normalizePreferences({ ...(override || preferences), onboarding_completed: true })
    const result = await putJSON(
      `/api/storage/apps/${appId}/preferences.json`, token, next, appId,
    )
    const outcome = toastFor(result)
    if (outcome.durable) {
      setPreferences(next)
      onPreferencesChange?.(next)
      setPreferencesToast(target === 'listening' && next.tts.enabled ? 'Listening ready ✓' : outcome.msg)
      window.mobius?.signal?.('item_updated', {
        type: 'digest_preferences',
        source_types: next.source_types,
        tts_enabled: next.tts.enabled,
        language: next.tts.language,
      })
      onSetupComplete?.()
      setTimeout(() => setPreferencesToast(''), 2200)
    } else {
      setPreferencesError(outcome.msg)
      setTimeout(() => setPreferencesError(''), 3200)
    }
    return outcome.durable
  }, [appId, token, preferences, onPreferencesChange, onSetupComplete])

  const downloadTts = useCallback(async () => {
    if (!preferences.tts.enabled) return
    setPreferencesTarget('listening')
    setPreferencesToast('')
    setPreferencesError('')
    setTtsSetup({ state: 'queued', progress: 0, message: 'Starting download…' })
    try {
      await prepareTtsModelPack(appId, token, {
        onProgress: (status) => setTtsSetup({
          state: status.state || 'preparing',
          progress: status.progress || 0,
          message: status.message || '',
        }),
      })
      await savePreferences('listening', preferences)
    } catch (caught) {
      if (isTtsModelPackCancellation(caught)) {
        setTtsSetup({ state: 'idle', progress: 0, message: '' })
        return
      }
      const message = caught?.message || 'News could not download the listening model.'
      setTtsSetup((current) => ({ ...current, state: 'error', message }))
      setPreferencesError(message)
    }
  }, [appId, token, preferences, savePreferences])

  const resetTopics = useCallback(async () => {
    setTopics(DEFAULT_TOPICS)
    const res = await putText(
      `/api/storage/apps/${appId}/topics.txt`, token, DEFAULT_TOPICS, appId,
    )
    const outcome = toastFor(res, 'Reset to default ✓')
    if (outcome.durable) {
      writeTopicsCache(appId, DEFAULT_TOPICS)
      setTopicsStale(false)
      window.mobius?.signal?.('item_updated', {
        type: 'editorial_brief',
        chars: DEFAULT_TOPICS.length,
        reset: true,
      })
      onSetupComplete?.()
    } else {
      // The reset didn't persist. Mark the brief stale so Save stays gated
      // offline and we don't leave the cache claiming a default that the
      // server never accepted.
      setTopicsStale(true)
    }
    showTopicsOutcome(outcome)
  }, [appId, token, onSetupComplete])

  const saveAgent = useCallback(async (nextProvider, nextModel) => {
    const prevProvider = provider
    const prevModel = model
    const prevEffort = effort
    const nextEffort = effortForProvider(nextProvider, effort)
    const seq = ++saveAgentSeqRef.current
    const prevMode = primaryAgentMode
    setPrimaryAgentMode('app')
    setProvider(nextProvider)
    setModel(nextModel)
    setEffort(nextEffort)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: 'app', provider: nextProvider, model: nextModel, effort: nextEffort,
        secondaryMode: secondaryAgentMode,
        fallbackProvider, fallbackModel, fallbackEffort,
      }),
      appId,
    )
    // A newer pick started after this one — this response is stale. Applying
    // its toast or (worse) its rollback would clobber the newer pick's state,
    // so drop it entirely.
    if (seq !== saveAgentSeqRef.current) return
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
    }
    else {
      setProvider(prevProvider)
      setModel(prevModel)
      setEffort(prevEffort)
      setPrimaryAgentMode(prevMode)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
    }
  }, [appId, token, provider, model, effort, primaryAgentMode, secondaryAgentMode, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const saveEffort = useCallback(async (nextValue) => {
    const prevEffort = effort
    const nextEffort = effortForProvider(provider, nextValue)
    const seq = ++saveAgentSeqRef.current
    setEffort(nextEffort)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: 'app', provider, model, effort: nextEffort,
        secondaryMode: secondaryAgentMode,
        fallbackProvider, fallbackModel, fallbackEffort,
      }),
      appId,
    )
    if (seq !== saveAgentSeqRef.current) return
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
    }
    else {
      setEffort(prevEffort)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
    }
  }, [appId, token, provider, model, effort, secondaryAgentMode, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const savePrimaryMode = useCallback(async (nextMode) => {
    if (nextMode === primaryAgentMode) return
    const previous = primaryAgentMode
    const seq = ++saveAgentSeqRef.current
    setPrimaryAgentMode(nextMode)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: nextMode, provider, model, effort,
        secondaryMode: secondaryAgentMode,
        fallbackProvider, fallbackModel, fallbackEffort,
      }),
      appId,
    )
    if (seq !== saveAgentSeqRef.current) return
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
    } else {
      setPrimaryAgentMode(previous)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
    }
  }, [appId, token, primaryAgentMode, secondaryAgentMode, provider, model, effort, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const chooseDefaultFallback = useCallback(() => {
    if (!providerGroups || providerGroups.length === 0) return null
    const connected = (group) => !connectedProviders || connectedProviders.has(group.key)
    return (
      providerGroups.find(g => g.key !== provider && connected(g) && g.models?.length) ||
      providerGroups.find(g => g.key !== provider && g.models?.length) ||
      null
    )
  }, [providerGroups, connectedProviders, provider])

  const saveFallbackAgent = useCallback(async (nextProvider, nextModel, nextMode = 'app') => {
    const prevProvider = fallbackProvider
    const prevModel = fallbackModel
    const prevEffort = fallbackEffort
    const nextEffort = nextProvider ? effortForProvider(nextProvider, fallbackEffort) : ''
    const seq = ++saveAgentSeqRef.current
    const prevMode = secondaryAgentMode
    setSecondaryAgentMode(nextMode)
    setFallbackProvider(nextProvider)
    setFallbackModel(nextModel)
    setFallbackEffort(nextEffort)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: primaryAgentMode, provider, model, effort,
        secondaryMode: nextMode,
        fallbackProvider: nextProvider, fallbackModel: nextModel, fallbackEffort: nextEffort,
      }),
      appId,
    )
    if (seq !== saveAgentSeqRef.current) return
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
    }
    else {
      setFallbackProvider(prevProvider)
      setFallbackModel(prevModel)
      setFallbackEffort(prevEffort)
      setSecondaryAgentMode(prevMode)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
    }
  }, [appId, token, primaryAgentMode, secondaryAgentMode, provider, model, effort, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const saveFallbackEffort = useCallback(async (nextValue) => {
    if (!fallbackProvider) return
    const prevEffort = fallbackEffort
    const nextEffort = effortForProvider(fallbackProvider, nextValue)
    const seq = ++saveAgentSeqRef.current
    setFallbackEffort(nextEffort)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: primaryAgentMode, provider, model, effort,
        secondaryMode: 'app', fallbackProvider, fallbackModel, fallbackEffort: nextEffort,
      }),
      appId,
    )
    if (seq !== saveAgentSeqRef.current) return
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
    }
    else {
      setFallbackEffort(prevEffort)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
    }
  }, [appId, token, primaryAgentMode, provider, model, effort, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const reorderAgents = useCallback(async (fromIndex, toIndex) => {
    const slots = [
      { mode: primaryAgentMode, provider, model, effort },
      { mode: secondaryAgentMode, provider: fallbackProvider, model: fallbackModel, effort: fallbackEffort },
    ]
    const ordered = reorderAgentSlots(slots, fromIndex, toIndex)
    if (ordered === slots) return false
    const [nextPrimary, nextSecondary] = ordered
    const previous = { primary: slots[0], secondary: slots[1] }
    const next = {
      primaryAgentMode: nextPrimary.mode,
      provider: nextPrimary.provider,
      model: nextPrimary.model,
      effort: nextPrimary.effort,
      secondaryAgentMode: nextSecondary.mode,
      fallbackProvider: nextSecondary.provider,
      fallbackModel: nextSecondary.model,
      fallbackEffort: nextSecondary.effort,
    }
    const seq = ++saveAgentSeqRef.current
    setPrimaryAgentMode(next.primaryAgentMode)
    setProvider(next.provider)
    setModel(next.model)
    setEffort(next.effort)
    setSecondaryAgentMode(next.secondaryAgentMode)
    setFallbackProvider(next.fallbackProvider)
    setFallbackModel(next.fallbackModel)
    setFallbackEffort(next.fallbackEffort)
    const res = await putJSON(
      `/api/storage/apps/${appId}/agent.json`, token,
      agentPayload({
        primaryMode: next.primaryAgentMode,
        provider: next.provider,
        model: next.model,
        effort: next.effort,
        secondaryMode: next.secondaryAgentMode,
        fallbackProvider: next.fallbackProvider,
        fallbackModel: next.fallbackModel,
        fallbackEffort: next.fallbackEffort,
      }),
      appId,
    )
    if (seq !== saveAgentSeqRef.current) return false
    const outcome = toastFor(res)
    if (outcome.durable) {
      setAgentError('')
      setAgentToast(outcome.msg)
      onSetupComplete?.()
      setTimeout(() => setAgentToast(''), 2000)
      return true
    } else {
      setPrimaryAgentMode(previous.primary.mode)
      setProvider(previous.primary.provider)
      setModel(previous.primary.model)
      setEffort(previous.primary.effort)
      setSecondaryAgentMode(previous.secondary.mode)
      setFallbackProvider(previous.secondary.provider)
      setFallbackModel(previous.secondary.model)
      setFallbackEffort(previous.secondary.effort)
      setAgentToast('')
      setAgentError(outcome.msg)
      setTimeout(() => setAgentError(''), 3000)
      return false
    }
  }, [appId, token, primaryAgentMode, provider, model, effort, secondaryAgentMode, fallbackProvider, fallbackModel, fallbackEffort, onSetupComplete])

  const toggleFallback = useCallback((enabled) => {
    if (enabled && secondaryAgentMode === 'app') return
    if (!enabled && secondaryAgentMode === 'system') return
    if (!enabled) {
      saveFallbackAgent('', '', 'system')
      return
    }
    const chosen = chooseDefaultFallback()
    if (chosen) {
      saveFallbackAgent(chosen.key, chosen.models?.[0]?.id || '')
      return
    }
    setAgentToast('')
    setAgentError('Connect another provider before enabling a fallback.')
    setTimeout(() => setAgentError(''), 4000)
  }, [secondaryAgentMode, chooseDefaultFallback, saveFallbackAgent])

  const saveSchedule = useCallback((nextSchedule) => {
    const seq = ++scheduleSaveSeqRef.current
    setScheduleToast('Saving…')
    setScheduleError('')
    const task = async () => {
      const timezone = nextSchedule.timezone || getBrowserTimezone()
      try {
        const cron = buildCron(nextSchedule.hour, nextSchedule.minute)
        const response = await fetch(`/api/apps/${appId}/schedule`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ cron, job: 'fetch.sh', timezone }),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const mirror = await putJSON(
          `/api/storage/apps/${appId}/schedule.json`,
          token,
          { ...nextSchedule, timezone, cron },
          appId,
        )
        if (!toastFor(mirror).durable) throw new Error('Schedule mirror was not saved')
        if (seq !== scheduleSaveSeqRef.current) return
        setSchedule((current) => ({ ...current, timezone }))
        setScheduleToast('Saved ✓')
        window.mobius?.signal?.('item_updated', {
          type: 'schedule',
          hour: nextSchedule.hour,
          minute: nextSchedule.minute,
        })
        onSetupComplete?.()
        setTimeout(() => {
          if (seq === scheduleSaveSeqRef.current) setScheduleToast('')
        }, 2600)
      } catch (e) {
        if (seq !== scheduleSaveSeqRef.current) return
        setScheduleToast('')
        setScheduleError(online ? 'Could not update the schedule.' : 'You’re offline — reconnect to save.')
      }
    }
    const queued = scheduleSaveChainRef.current.catch(() => {}).then(task)
    scheduleSaveChainRef.current = queued
    return queued
  }, [appId, token, online, onSetupComplete])

  const onScheduleChange = useCallback((e) => {
    const [h, m] = e.target.value.split(':').map(Number)
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const next = { ...schedule, hour: h, minute: m }
      setSchedule(next)
      saveSchedule(next)
    }
  }, [schedule, saveSchedule])

  const handleRunNow = useCallback(async () => {
    // Use the ref (not the state) as the sync guard — two clicks in
    // the same tick read the same closure, so the state-based check
    // can race past itself before disabled propagates to the DOM.
    if (runNowRef.current) return
    runNowRef.current = true
    setRunNowBusy(true)
    setRunNowError('')
    setRunNowToast('')
    try {
      const result = await fetch(`/api/apps/${appId}/run-job`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!result.ok) {
        setRunNowError(`Could not start job (HTTP ${result.status}).`)
        // Same 'error' shape signalError emits on the Reports tab's generate
        // failure, so Reflection's error feed reads uniformly across both
        // on-demand entry points (source distinguishes which button).
        window.mobius?.signal?.('error', { message: `run-job failed: HTTP ${result.status}`, source: 'run_now' })
      } else {
        setRunNowToast('Started — your digest will appear in Reports shortly.')
        // On-demand pull accepted. Reuse the Reports tab's generate_started
        // name (ReportsTab handleGenerate) so a "Run now" digest is counted as
        // the same on-demand event, not a parallel one.
        window.mobius?.signal?.('generate_started')
        setTimeout(() => setRunNowToast(''), 4000)
      }
    } catch (e) {
      setRunNowError('Could not reach the server.')
      window.mobius?.signal?.('error', { message: e?.message || 'Could not reach the server', source: 'run_now' })
    } finally {
      setRunNowBusy(false)
      runNowRef.current = false
    }
  }, [appId, token])

  const fallbackMatchesPrimary = !!fallbackProvider
    && primaryAgentMode === 'app'
    && secondaryAgentMode === 'app'
    && fallbackProvider === provider
    && (fallbackModel || '') === (model || '')
    && effortForProvider(fallbackProvider, fallbackEffort) === effortForProvider(provider, effort)
  const agentSlots = [
    { mode: primaryAgentMode, provider, model, effort },
    { mode: secondaryAgentMode, provider: fallbackProvider, model: fallbackModel, effort: fallbackEffort },
  ]
  const canReorderAgents = canReorderAgentSlots(agentSlots)
  const agentLabels = [
    agentSlotLabel(agentSlots[0], providerGroups, 'Settings default primary agent'),
    agentSlotLabel(agentSlots[1], providerGroups, 'Settings default secondary agent'),
  ]

  const effortLabel = (selectedProvider, value) => (
    (EFFORT_LEVELS[selectedProvider] || []).find((level) => level.value === value)?.label || value
  )

  if (loading) return <div className="nw-loading">Loading settings…</div>

  return (
    <div className="nw-settings-wrap">
      <div className="nw-settings-section nw-settings-section--editorial">
        {/* Label: "Editorial brief" rather than the old "What to search
            for". The textarea now carries most of the editorial intent
            (topics, sources, voice, framing), while system-prompt.md is
            kept as a thin technical schema. "Editorial brief" sets the
            expectation that this is prose, not a keyword list. */}
        <label className="nw-label" htmlFor="nw-editorial-brief">Editorial brief</label>
        {/* Fixed, non-editable helper: this is the "make it yours" framing
            that used to live as the first paragraph of the brief itself.
            Surfaced here so it guides the editor without the curator reading
            it back as part of the brief each morning. Keep it conversational
            and short — formatting/HTML guidance stays in system-prompt.md. */}
        <p className="nw-note">
          This is what the curator reads every morning to decide what to write
          and how. Make it yours — the more specific and opinionated you are,
          the better the digest. Plain English; the formatting is handled for you.
        </p>
        <textarea
          id="nw-editorial-brief"
          name="editorial_brief"
          className="nw-topics-textarea"
          value={topics}
          // A user edit is intentional content, so it's safe to save even
          // if the live read never landed — clear the stale guard.
          onChange={(e) => { setTopics(e.target.value); setTopicsStale(false) }}
          // 12 rows by default so the editorial brief has room to
          // breathe; the user can still drag the resize handle.
          rows={12}
          spellCheck={true}
          placeholder={TOPICS_PLACEHOLDER}
        />
        <div className="nw-btn-row">
          {/* Block saving an un-loaded brief while offline: the textarea
              is showing a cached/default fallback, not the live server
              copy, so a queued save would overwrite the real brief on
              reconnect. */}
          <button
            className="nw-btn"
            onClick={saveTopics}
            disabled={topicsStale && !online}
            title={topicsStale && !online ? 'Reconnect to load and save your brief' : undefined}
          >
            Save
          </button>
          <button className="nw-link-btn" onClick={resetTopics}>Reset to default</button>
          {topicsStale && !online && (
            <span className="nw-status-hint">Offline — showing your cached brief</span>
          )}
          {topicsToast && <span className="nw-toast">{topicsToast}</span>}
          {topicsError && <span className="nw-error-toast">{topicsError}</span>}
        </div>
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Sources</label>
        <p className="nw-note">
          Set the overall mix, then name anything the curator should always
          look for or usually leave out.
        </p>
        <SourcePreferenceFields value={preferences} onChange={setPreferences} />
        <div className="nw-btn-row has-top">
          <button className="nw-btn" onClick={() => savePreferences('sources')}>Save sources</button>
          {preferencesTarget === 'sources' && preferencesToast && <span className="nw-toast">{preferencesToast}</span>}
          {preferencesTarget === 'sources' && preferencesError && <span className="nw-error-toast">{preferencesError}</span>}
        </div>
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Listening</label>
        <p className="nw-note">Private text to speech on this device.</p>
        <TtsPreferenceFields
          value={preferences}
          packStatus={ttsSetup}
          onDownload={downloadTts}
          onChange={(next) => {
            setPreferences(next)
            setPreferencesToast('')
            setPreferencesError('')
            // Turning listening off never deletes the already downloaded
            // pack. Turning it on saves immediately when the pack already
            // exists; otherwise Download now is the explicit commit action.
            if (!next.tts.enabled || ttsSetup.state === 'ready') {
              savePreferences('listening', next)
            }
          }}
        />
        <div className="nw-btn-row has-top nw-listening-feedback">
          {preferencesTarget === 'listening' && preferencesToast && <span className="nw-toast">{preferencesToast}</span>}
          {preferencesTarget === 'listening' && preferencesError && <span className="nw-error-toast">{preferencesError}</span>}
        </div>
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Background agents</label>
        <p className="nw-note">
          Tried in order. Drag to change priority. Each row follows Möbius
          Settings by default, or can use its own model for News.
        </p>
        {providerGroups === null ? (
          <div className="nw-note">Loading models…</div>
        ) : (
          <BackgroundAgentList
            onMove={reorderAgents}
            itemLabels={agentLabels}
            reorderDisabled={!canReorderAgents}
            reorderDisabledReason="Choose an app override for both rows before changing priority; inherited Settings agents are already ordered in Möbius Settings."
          >
            <div key="primary">
              <ModelPicker
                provider={primaryAgentMode === 'system' ? '' : provider}
                model={primaryAgentMode === 'system' ? '' : model}
                groups={providerGroups}
                connectedProviders={connectedProviders}
                onChange={saveAgent}
                onSettingsDefault={() => savePrimaryMode('system')}
                useSettingsDefault={primaryAgentMode === 'system'}
                title="News primary model"
                navKey="news-primary-model"
                effortLabel={primaryAgentMode === 'system' ? '' : effortLabel(provider, effort)}
                efforts={EFFORT_LEVELS[provider] || []}
                effort={effort}
                effortControl={primaryAgentMode === 'system' ? null : (
                  <EffortStepper provider={provider} value={effort} onChange={saveEffort} />
                )}
              />
            </div>
            <div key="secondary">
              <ModelPicker
                provider={secondaryAgentMode === 'system' ? '' : fallbackProvider}
                model={secondaryAgentMode === 'system' ? '' : fallbackModel}
                groups={providerGroups}
                connectedProviders={connectedProviders}
                onChange={saveFallbackAgent}
                onSettingsDefault={() => toggleFallback(false)}
                useSettingsDefault={secondaryAgentMode === 'system'}
                title="News secondary model"
                navKey="news-secondary-model"
                effortLabel={secondaryAgentMode === 'system' ? '' : effortLabel(fallbackProvider, fallbackEffort)}
                efforts={EFFORT_LEVELS[fallbackProvider] || []}
                effort={fallbackEffort}
                effortControl={secondaryAgentMode === 'system' ? null : (
                  <EffortStepper provider={fallbackProvider} value={fallbackEffort} onChange={saveFallbackEffort} />
                )}
              />
              {secondaryAgentMode === 'app' && fallbackMatchesPrimary && (
                <p className="nw-fallback-warning" role="status">
                  This override matches the primary exactly, so it cannot recover a failed run. Choose another provider, model, or effort.
                </p>
              )}
            </div>
          </BackgroundAgentList>
        )}
        {agentToast && (
          <div className="nw-btn-row has-top">
            <span className="nw-toast">{agentToast}</span>
          </div>
        )}
        {agentError && (
          <div className="nw-btn-row has-top">
            <span className="nw-error-toast">{agentError}</span>
          </div>
        )}
      </div>

      <div className="nw-settings-section">
        <label className="nw-label">Schedule</label>
        <p className="nw-note">
          Pick when the digest job should run each day. Displayed timezone:
          {` ${schedule.timezone || getBrowserTimezone()}`}.
        </p>
        <div className="nw-btn-row">
          <input
            type="time"
            value={timeValue(schedule)}
            onChange={onScheduleChange}
            className="nw-model-select nw-time-input"
            aria-label="Daily digest time"
            disabled={!online}
            title={!online ? 'Reconnect to change the schedule' : 'Changes save automatically'}
          />
          <button
            className="nw-btn-secondary"
            onClick={handleRunNow}
            disabled={runNowBusy || !online}
            aria-busy={runNowBusy}
            title={!online ? 'Online required to trigger a fetch' : undefined}
          >
            {runNowBusy ? 'Running…' : 'Run now'}
          </button>
          {scheduleToast && <span className="nw-toast">{scheduleToast}</span>}
          {scheduleError && <span className="nw-error-toast">{scheduleError}</span>}
          {runNowToast && <span className="nw-toast">{runNowToast}</span>}
          {runNowError && <span className="nw-error-toast">{runNowError}</span>}
        </div>
      </div>
    </div>
  )
}
