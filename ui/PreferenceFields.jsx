import React from 'react'
import {
  SOURCE_TYPE_OPTIONS,
  updatePreference,
  updateTtsPreference,
} from '../preferences.js'
import { activeVoiceModel, openVoiceApp } from '../speech-capability.js'

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
        <label className="nw-field-label" htmlFor="nw-include-sources">Include:</label>
        <input
          id="nw-include-sources"
          className="nw-text-input"
          value={value.include_sources}
          onChange={(event) => onChange(updatePreference(value, { include_sources: event.target.value }))}
          placeholder="Reuters, BBC, Rest of World, official statistics"
        />

        <label className="nw-field-label" htmlFor="nw-exclude-sources">Exclude:</label>
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

export function TtsPreferenceFields({
  value,
  onChange,
  catalog,
}) {
  const selected = activeVoiceModel(catalog)
  const checking = catalog?.state === 'checking'
  const unavailable = catalog?.state === 'unavailable'
  const voiceLabel = selected?.voice || selected?.name || 'Selected voice'
  const voiceDetail = [selected?.language, selected?.engine].filter(Boolean).join(' · ')
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
          <small>Read reports aloud with the voice selected in Voice.</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      {!value.tts.enabled ? (
        <p className="nw-tts-off-note">
          {selected
            ? `Off. ${voiceLabel} remains selected on this device.`
            : 'Off. Set up a voice in Voice when you want listening.'}
        </p>
      ) : (
        <div className="nw-tts-details">
          {selected && (
            <div className="nw-impact-card">
              <span className="nw-impact-mark" aria-hidden="true">✓</span>
              <div>
                <strong>{voiceLabel} is ready</strong>
                <p>{voiceDetail || 'Selected in Voice'} · private on this device.</p>
              </div>
            </div>
          )}

          {!selected && !checking && (
            <div className="nw-impact-card">
              <span className="nw-impact-mark" aria-hidden="true">↗</span>
              <div>
                <strong>Set up a voice in Voice</strong>
                <p>Download a voice and select it for this device, then return to News.</p>
                <button
                  type="button"
                  className="nw-inline-button"
                  onClick={openVoiceApp}
                >
                  Open Voice
                </button>
              </div>
            </div>
          )}

          {unavailable ? (
            <div className="nw-setup-error" role="status">
              {catalog?.message || 'Voice is unavailable in this version of Möbius.'}
            </div>
          ) : selected ? (
            <p className="nw-field-note nw-language-note">Change the active language or voice in Voice; News follows that device-wide choice.</p>
          ) : checking ? (
            <p className="nw-field-note nw-language-note">Checking the voice selected on this device…</p>
          ) : null}
        </div>
      )}
    </div>
  )
}
