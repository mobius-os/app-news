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

export function TtsPreferenceFields({ value, onChange, packStatus, onDownload }) {
  const packState = packStatus?.state || 'idle'
  const ready = packState === 'ready'
  const busy = packState === 'queued' || packState === 'preparing'
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
          <small>Read reports aloud on demand with Pocket TTS.</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      {!value.tts.enabled ? (
        <p className="nw-tts-off-note">
          {ready
            ? 'Listening is off. Your existing model download remains in News, ready if you turn it back on.'
            : 'Off by default. Nothing is downloaded or added to News.'}
        </p>
      ) : (
        <div className="nw-tts-details">
          <div className="nw-impact-card">
            <span className="nw-impact-mark" aria-hidden="true">↓</span>
            <div>
              <strong>One optional download, then listen on demand</strong>
              <p>
                News stores about 186 MB of compressed model data. Your browser
                expands it locally when you listen; no audio files are kept.
              </p>
            </div>
          </div>
          <p className="nw-field-note nw-language-note">
            Pocket TTS officially supports English, French, German, Spanish,
            Portuguese, and Italian. This experimental browser player uses the
            English Alba voice for now. WebGPU keeps the model in fp16 and is the
            realistic phone path. The Wasm fallback expands it to float32 and can
            need well over 700 MB of working memory while it runs.
          </p>
          <p className="nw-privacy-note">Speech runs on this device and your digest text is not sent to a speech API. News uses native compression, without PyTorch or scientific dependencies. Turning listening off does not delete an already downloaded pack.</p>

          {packState === 'checking' ? (
            <button type="button" className="nw-btn nw-tts-download" disabled>Checking download…</button>
          ) : ready ? (
            <TtsModelPackProgress state="ready" progress={100} message="Listening download ready" />
          ) : (
            <>
              <button
                type="button"
                className="nw-btn nw-tts-download"
                onClick={onDownload}
                disabled={busy || !onDownload}
              >
                {busy ? 'Downloading…' : 'Download now · about 186 MB'}
              </button>
              <TtsModelPackProgress {...packStatus} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
