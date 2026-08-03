import React from 'react'
import {
  SOURCE_TYPE_OPTIONS,
  updatePreference,
  updateTtsPreference,
} from '../preferences.js'
import { TtsModelPackProgress } from './TtsModelPackProgress.jsx'

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
  packStatus,
  onDownload,
}) {
  const packState = packStatus?.state || 'idle'
  const ready = packState === 'ready'
  const busy = packState === 'queued' || packState === 'preparing'
  const unavailable = packState === 'unavailable'
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
          <small>Read reports aloud with Pocket TTS.</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      {!value.tts.enabled ? (
        <p className="nw-tts-off-note">
          {ready
            ? 'Off. The voice remains on this device.'
            : 'Off. Nothing is downloaded.'}
        </p>
      ) : (
        <div className="nw-tts-details">
          <div className="nw-impact-card">
            <span className="nw-impact-mark" aria-hidden="true">↓</span>
            <div>
              <strong>154 MB on each device</strong>
              <p>Nothing is stored on the server.</p>
            </div>
          </div>
          <p className="nw-field-note nw-language-note">
            English Alba voice. Pocket TTS also supports French, German,
            Spanish, Portuguese, and Italian; News does not include those voices yet.
          </p>

          {unavailable ? (
            <div className="nw-setup-error" role="status">
              {packStatus?.message || 'Listening storage is unavailable in this browser.'}
            </div>
          ) : packState === 'checking' ? (
            <button type="button" className="nw-btn nw-tts-download" disabled>Checking download…</button>
          ) : ready ? (
            <TtsModelPackProgress
              state="ready"
              progress={100}
              message={packStatus?.message || 'Listening ready on this device'}
            />
          ) : (
            <>
              <button
                type="button"
                className="nw-btn nw-tts-download"
                onClick={onDownload}
                disabled={busy || unavailable || !onDownload}
              >
                {busy
                  ? 'Downloading…'
                  : 'Download voice · 154 MB'}
              </button>
              <TtsModelPackProgress {...packStatus} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
