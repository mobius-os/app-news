import React from 'react'
import {
  SOURCE_TYPE_OPTIONS,
  updatePreference,
  updateTtsPreference,
} from '../preferences.js'
import {
  activeVoiceModel,
  openVoiceApp,
  openVoiceStore,
  voiceSetupState,
} from '../speech-capability.js'
import { VOICE_ICON_DATA_URL } from '../voice-icon.js'

export function SourcePreferenceFields({ value, onChange }) {
  const toggleType = (id) => {
    const selected = value.source_types.includes(id)
    const next = selected
      ? value.source_types.filter((item) => item !== id)
      : [...value.source_types, id]
    // Keep at least one source family selected; the UI explains the choice
    // rather than silently accepting a configuration that cannot be honoured.
    if (next.length === 0) return
    onChange(updatePreference(value, { source_types: next }))
  }

  return (
    <div className="nw-preference-fields">
      <fieldset className="nw-choice-fieldset">
        <legend className="nw-visually-hidden">Source types</legend>
        <div className="nw-choice-grid">
          {SOURCE_TYPE_OPTIONS.map((option) => {
            const selected = value.source_types.includes(option.id)
            return (
              <button
                type="button"
                key={option.id}
                className={`nw-choice-card${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => toggleType(option.id)}
              >
                <span className="nw-choice-check" aria-hidden="true">{selected ? '✓' : ''}</span>
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            )
          })}
        </div>
      </fieldset>

      <div className="nw-source-inputs">
        <label className="nw-field-label" htmlFor="nw-include-sources">Include</label>
        <input
          id="nw-include-sources"
          className="nw-text-input"
          value={value.include_sources}
          onChange={(event) => onChange(updatePreference(value, { include_sources: event.target.value }))}
          placeholder="Reuters, BBC, Rest of World, official statistics"
        />

        <label className="nw-field-label" htmlFor="nw-exclude-sources">Exclude</label>
        <input
          id="nw-exclude-sources"
          className="nw-text-input"
          value={value.exclude_sources}
          onChange={(event) => onChange(updatePreference(value, { exclude_sources: event.target.value }))}
          placeholder="tabloids, press releases, paywalled opinion"
        />
      </div>
    </div>
  )
}

function voiceDependencyCopy(state, catalog) {
  switch (state) {
    case 'checking':
      return { title: 'Checking Voice…', body: '', action: null }
    case 'needs_voice':
      return {
        title: 'Choose a voice',
        body: 'Download and select a voice in Voice.',
        action: { label: 'Open Voice', onClick: openVoiceApp },
      }
    case 'needs_app':
      return {
        title: 'Add Voice',
        body: 'Install Voice to listen to digests.',
        action: { label: 'Open App Store', onClick: openVoiceStore },
      }
    default:
      return {
        title: 'Voice unavailable',
        body: catalog?.message || 'News could not check Voice.',
        action: null,
      }
  }
}

export function TtsPreferenceFields({
  value,
  onChange,
  catalog,
  onRefresh,
}) {
  const selected = activeVoiceModel(catalog)
  const checking = catalog?.state === 'checking'
  const setupState = voiceSetupState(catalog)
  const dependency = voiceDependencyCopy(setupState, catalog)
  const voiceLabel = selected?.voice || selected?.name || 'Selected voice'
  const voiceDetail = [voiceLabel, selected?.language].filter(Boolean).join(' · ')

  if (setupState !== 'ready') {
    return (
      <div className="nw-voice-dependency" aria-busy={checking || undefined}>
        <img
          src={VOICE_ICON_DATA_URL}
          className="nw-voice-dependency__icon"
          width={58}
          height={58}
          alt=""
        />
        <div className="nw-voice-dependency__body">
          <strong>{dependency.title}</strong>
          {dependency.body && (
            <p role={setupState === 'unavailable' ? 'status' : undefined}>
              {dependency.body}
            </p>
          )}
          {!checking && (
            <div className="nw-voice-dependency__actions">
              {dependency.action && (
                <button
                  type="button"
                  className="nw-voice-store-button"
                  onClick={dependency.action.onClick}
                >
                  {dependency.action.label}
                </button>
              )}
              <button
                type="button"
                className="nw-voice-recheck-button"
                onClick={() => onRefresh?.()}
              >
                Check again
              </button>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="nw-listen-card">
      <button
        type="button"
        role="switch"
        aria-checked={value.tts.enabled}
        className={`nw-switch-row${value.tts.enabled ? ' is-on' : ''}`}
        onClick={() => onChange(updateTtsPreference(value, { enabled: !value.tts.enabled }))}
      >
        <span>
          <strong>Listen to digests</strong>
          <small>{voiceDetail || 'Selected in Voice'}</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      <div className="nw-tts-actions">
        <button type="button" className="nw-link-btn" onClick={openVoiceApp}>Change voice</button>
      </div>
    </div>
  )
}
