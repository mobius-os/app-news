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
import { useVoiceCatalog } from './useVoiceCatalog.js'

const STEPS = [
  { label: 'Interests', title: 'What should your digest follow?' },
  { label: 'Sources', title: 'Which sources should it use?' },
  { label: 'Listening', title: 'Would you like to listen?' },
]

export function SetupFlow({ appId, token, initialPreferences, onComplete }) {
  const [step, setStep] = useState(0)
  const [topics, setTopics] = useState(STARTER_TOPICS)
  const [preferences, setPreferences] = useState(() => normalizePreferences(initialPreferences))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const { catalog: speechCatalog, refresh: refreshSpeechCatalog } = useVoiceCatalog(token)
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
        <h1>{current.title}</h1>

        {step === 0 && (
          <div className="nw-setup-step">
            <p className="nw-setup-lede">Topics, people, places, and questions all work.</p>
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
            <p className="nw-field-note">You can change this later.</p>
            {topicsRequireConfirmation && (
              <div className="nw-setup-error" role="alert">
                News couldn't verify the saved interests. Edit them or use the draft shown here.
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
            <p className="nw-setup-lede">A balanced mix is already selected.</p>
            <SourcePreferenceFields value={preferences} onChange={setPreferences} />
          </div>
        )}

        {step === 2 && (
          <div className="nw-setup-step">
            <TtsPreferenceFields
              value={preferences}
              onChange={(next) => { setPreferences(next); setError('') }}
              catalog={speechCatalog}
              onRefresh={refreshSpeechCatalog}
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
