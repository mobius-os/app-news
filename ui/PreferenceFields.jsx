import React from 'react'
import {
  SOURCE_TYPE_OPTIONS,
  languageInfo,
  updatePreference,
  updateTtsPreference,
} from '../preferences.js'

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
        <legend className="nw-field-label">Coverage mix</legend>
        <p className="nw-field-note">Choose one or both. The curator still checks important claims across sources.</p>
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
        <label className="nw-field-label" htmlFor="nw-include-sources">Always look for</label>
        <p className="nw-field-note">Specific publications, newsletters, or primary sources you trust.</p>
        <input
          id="nw-include-sources"
          className="nw-text-input"
          value={value.include_sources}
          onChange={(event) => onChange(updatePreference(value, { include_sources: event.target.value }))}
          placeholder="For example: Reuters, BBC, Rest of World, official statistics"
        />

        <label className="nw-field-label" htmlFor="nw-exclude-sources">Avoid or ignore</label>
        <p className="nw-field-note">Names or source types the curator should skip unless essential to the story.</p>
        <input
          id="nw-exclude-sources"
          className="nw-text-input"
          value={value.exclude_sources}
          onChange={(event) => onChange(updatePreference(value, { exclude_sources: event.target.value }))}
          placeholder="For example: tabloids, press releases, paywalled opinion"
        />
      </div>
    </div>
  )
}

export function TtsPreferenceFields({ value, onChange }) {
  const info = languageInfo(value.tts.language)
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
          <small>Read reports aloud on demand with Kyutai’s official Pocket TTS.</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      {value.tts.enabled && (
        <div className="nw-tts-details">
          <p className="nw-field-note nw-language-note">
            Pocket TTS officially supports English, French, German, Spanish,
            Portuguese, and Italian. News uses the compact English voice for
            now, so setup stays simple.
          </p>
          <div className="nw-impact-card">
            <span className="nw-impact-mark" aria-hidden="true">≈</span>
            <div>
              <strong>About 1.4 GB server storage, 850 MB memory while speaking</strong>
              <p>
                The compact English model itself is {info.modelSize}; its
                isolated official CPU runtime adds about 1.2 GB. The model
                process is loaded only when listening, and audio is streamed
                rather than saved.
              </p>
            </div>
          </div>
          <p className="nw-privacy-note">Runs on your Möbius server. Your digest text is not sent to a speech API.</p>
          <p className="nw-field-note">Your first listen installs the pinned official runtime and model, so it can take several minutes.</p>
        </div>
      )}
    </div>
  )
}
