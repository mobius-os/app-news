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
          <small>Read reports aloud on demand with Pocket TTS.</small>
        </span>
        <span className="nw-switch" aria-hidden="true"><span /></span>
      </button>

      {!value.tts.enabled ? (
        <p className="nw-tts-off-note">
          {ready
            ? 'Listening is off. The model remains on this device until you clear its browser data.'
            : 'Off by default. Nothing is downloaded to this device or stored on the server.'}
        </p>
      ) : (
        <div className="nw-tts-details">
          <div className="nw-impact-card">
            <span className="nw-impact-mark" aria-hidden="true">↓</span>
            <div>
              <strong>One optional download per device, then listen on demand</strong>
              <p>
                About 154 MB is stored only in this browser and expands
                temporarily while you listen. It adds 0 MB to the server and
                keeps no audio files. Download it once on every device or
                browser profile where you want to listen. A fresh News browser
                frame prepares that saved copy in working memory again, but
                does not download it again; it remains ready while News stays open.
              </p>
            </div>
          </div>
          <p className="nw-field-note nw-language-note">
            Pocket TTS officially supports English, French, German, Spanish,
            Portuguese, and Italian. This browser player uses the English Alba
            voice for now. It runs in a WebAssembly worker with SIMD support,
            without requiring WebGPU.
          </p>
          <p className="nw-privacy-note">Speech runs on this device and your digest text is not sent to a speech API. News uses a compact Q8 model, without PyTorch or scientific dependencies. Browser storage can still be cleared by you or, when persistent storage is not granted, by the browser. Turning listening off does not delete the download.</p>

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
                  : 'Download on this device · about 154 MB'}
              </button>
              <TtsModelPackProgress {...packStatus} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
