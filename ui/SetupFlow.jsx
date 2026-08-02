import React, { useEffect, useRef, useState } from 'react'
import {
  STARTER_TOPICS,
  TOPICS_PLACEHOLDER,
  normalizePreferences,
  setupTopicsDraft,
} from '../preferences.js'
import {
  classifyWriteOutcome,
  getText,
  putJSON,
  putText,
  readTopicsCache,
  writeTopicsCache,
} from '../storage.js'
import { SourcePreferenceFields, TtsPreferenceFields } from './PreferenceFields.jsx'
import {
  prepareTtsModelPack,
  presentTtsModelPackStatus,
  readTtsModelPackStatus,
} from '../tts-model-pack.js'

const STEPS = [
  { label: 'Interests', eyebrow: 'Make it yours', title: 'What should your digest follow?' },
  { label: 'Sources', eyebrow: 'Shape the mix', title: 'Where should the curator look?' },
  { label: 'Listening', eyebrow: 'Optional', title: 'Would you like to listen, too?' },
]

export function SetupFlow({ appId, token, initialPreferences, onComplete }) {
  const [step, setStep] = useState(0)
  const [topics, setTopics] = useState(STARTER_TOPICS)
  const [preferences, setPreferences] = useState(() => normalizePreferences(initialPreferences))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [ttsSetup, setTtsSetup] = useState({ state: 'idle', progress: 0, message: '' })
  const [topicsRequireConfirmation, setTopicsRequireConfirmation] = useState(false)
  const topicsFirstFocusRef = useRef(true)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const result = await getText(`/api/storage/apps/${appId}/topics.txt`, token, appId)
      if (cancelled) return
      const draft = setupTopicsDraft({
        liveOk: result.ok,
        liveText: result.data,
        cachedText: readTopicsCache(appId),
      })
      setTopics(draft.topics)
      setTopicsRequireConfirmation(draft.requiresConfirmation)
      if (result.ok) writeTopicsCache(appId, draft.topics)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [appId, token])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const status = await readTtsModelPackStatus()
      if (cancelled) return
      setTtsSetup(presentTtsModelPackStatus(status))
    })()
    return () => { cancelled = true }
  }, [appId, token])

  const downloadTts = async () => {
    if (!preferences.tts.enabled) return
    setError('')
    setTtsSetup({ state: 'queued', progress: 0, message: 'Starting download…' })
    try {
      await prepareTtsModelPack(appId, token, {
        onProgress: (status) => setTtsSetup({
          state: status.state || 'preparing',
          progress: status.progress || 0,
          message: status.message || '',
        }),
      })
    } catch (caught) {
      const message = caught?.message || 'News could not download the listening model. Please try again.'
      setTtsSetup((current) => ({ ...current, state: 'error', message }))
      setError(message)
    }
  }

  const finish = async () => {
    if (topicsRequireConfirmation) {
      setStep(0)
      setError('Confirm the displayed interests before setup saves them.')
      return
    }
    if (!topics.trim()) {
      setStep(0)
      setError('Add a few interests so the curator has something useful to follow.')
      return
    }
    if (preferences.tts.enabled && ttsSetup.state !== 'ready') {
      setStep(2)
      setError('Download the listening model first, or turn listening off for now.')
      return
    }
    setSaving(true)
    setError('')
    const cleanTopics = topics.trim()
    const topicResult = await putText(`/api/storage/apps/${appId}/topics.txt`, token, cleanTopics, appId)
    const topicOutcome = classifyWriteOutcome(topicResult)
    if (!topicOutcome.durable) {
      setSaving(false)
      setError(topicOutcome.msg)
      return
    }
    const completed = normalizePreferences({ ...preferences, onboarding_completed: true })
    const preferenceResult = await putJSON(
      `/api/storage/apps/${appId}/preferences.json`, token, completed, appId,
    )
    const preferenceOutcome = classifyWriteOutcome(preferenceResult)
    if (!preferenceOutcome.durable) {
      setSaving(false)
      setError('Your interests saved, but the source and listening choices did not. Please try once more.')
      return
    }

    writeTopicsCache(appId, cleanTopics)
    window.mobius?.signal?.('item_updated', {
      type: 'digest_setup',
      source_types: completed.source_types,
      tts_enabled: completed.tts.enabled,
    })
    onComplete(completed)
  }

  if (loading) return <div className="nw-setup-loading">Preparing your News setup…</div>
  const current = STEPS[step]

  return (
    <main className="nw-setup-shell">
      <div className="nw-setup-topline">
        <span className="nw-setup-brand">NEWS</span>
        <span className="nw-setup-count">{step + 1} of {STEPS.length}</span>
      </div>
      <div className="nw-setup-progress" aria-label={`Setup step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((item, index) => (
          <span key={item.label} className={index <= step ? 'is-active' : ''} />
        ))}
      </div>

      <section className="nw-setup-card">
        <p className="nw-setup-eyebrow">{current.eyebrow}</p>
        <h1>{current.title}</h1>

        {step === 0 && (
          <div className="nw-setup-step">
            <p className="nw-setup-lede">Write naturally. Topics, people, places, teams, and the level of detail you enjoy all help.</p>
            <label className="nw-field-label" htmlFor="nw-setup-topics">Topics and interests</label>
            <textarea
              id="nw-setup-topics"
              className="nw-setup-textarea"
              value={topics}
              onChange={(event) => {
                setTopics(event.target.value)
                setTopicsRequireConfirmation(false)
                setError('')
              }}
              onFocus={(event) => {
                if (!topicsFirstFocusRef.current) return
                topicsFirstFocusRef.current = false
                event.target.select()
                window.requestAnimationFrame(() => event.target.select())
              }}
              placeholder={TOPICS_PLACEHOLDER}
              rows={8}
            />
            <p className="nw-field-note">You can be broad or specific, and change this later in Settings.</p>
            {topicsRequireConfirmation && (
              <div className="nw-setup-error" role="alert">
                News couldn't confirm the saved copy of your interests. Edit the text, or explicitly use the draft shown here, before setup can save.
                <button
                  type="button"
                  className="nw-link-btn"
                  onClick={() => {
                    setTopicsRequireConfirmation(false)
                    setError('')
                  }}
                >
                  Use these interests
                </button>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="nw-setup-step">
            <p className="nw-setup-lede">A balanced default is already selected. Add names only when you have a preference.</p>
            <SourcePreferenceFields value={preferences} onChange={setPreferences} />
          </div>
        )}

        {step === 2 && (
          <div className="nw-setup-step">
            <p className="nw-setup-lede">Pocket TTS reads each report privately on supported devices without storing audio files or a server copy of the model.</p>
            <TtsPreferenceFields
              value={preferences}
              onChange={(next) => { setPreferences(next); setError('') }}
              packStatus={ttsSetup}
              onDownload={downloadTts}
            />
          </div>
        )}

        {error && <div className="nw-setup-error" role="alert">{error}</div>}
        <div className="nw-setup-actions">
          {step > 0 ? (
            <button type="button" className="nw-link-btn" onClick={() => { setStep(step - 1); setError('') }}>Back</button>
          ) : <span />}
          {step < STEPS.length - 1 ? (
            <button
              type="button"
              className="nw-btn nw-setup-next"
              onClick={() => {
                if (step === 0 && topicsRequireConfirmation) {
                  setError('Confirm the displayed interests before continuing.')
                  return
                }
                if (step === 0 && !topics.trim()) {
                  setError('Add a few interests before continuing.')
                  return
                }
                setError('')
                setStep(step + 1)
              }}
            >
              Continue
            </button>
          ) : (
            <button type="button" className="nw-btn nw-setup-next" onClick={finish} disabled={saving}>
              {saving ? 'Saving…' : 'Finish setup'}
            </button>
          )}
        </div>
      </section>
    </main>
  )
}
