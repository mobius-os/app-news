import React from 'react'

export function TtsModelPackProgress({ state, progress = 0, message = '' }) {
  if (!state || state === 'idle') return null
  const bounded = Math.max(0, Math.min(100, Number(progress) || 0))
  const ready = state === 'ready'
  const label = message || (ready ? 'Listening download ready' : 'Preparing listening…')
  return (
    <div className={`nw-tts-setup-status is-${state}`} aria-live="polite">
      <div className="nw-tts-setup-copy">
        <strong>{label}</strong>
        {!ready && <span>{Math.round(bounded)}%</span>}
      </div>
      <span
        className="nw-tts-setup-track"
        role="progressbar"
        aria-label="Listening setup progress"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={String(Math.round(bounded))}
      >
        <span style={{ width: `${ready ? 100 : bounded}%` }} />
      </span>
    </div>
  )
}
