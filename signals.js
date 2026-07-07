// Reflection signal emitters. Thin wrappers over window.mobius.signal that
// never throw if the runtime is absent, plus a deduped error emitter.
//
// This app owns its copy (library, not framework) — the dedupe shape mirrors
// app-tandem's signals.js.

export function signal(name, payload = {}) {
  try {
    window.mobius?.signal?.(name, payload)
  } catch {}
}

// Identical errors within this window are emitted once. The reports-listing
// poll (15s while a generation is active, 60s while the tab is visible) would
// otherwise flood signals.jsonl with the same "report listing failed" row every
// tick during an outage — Reflection reads only the last few error messages, so
// one row per distinct failure carries the same information. Window is wider
// than the 15s poll so a single outage collapses to one signal.
const ERROR_DEDUPE_MS = 60_000
const lastErrorAt = new Map()

export function signalError(message, source) {
  const msg = String(message || 'Unknown error.')
  const src = String(source || 'unknown')
  const key = `${src}|${msg}`
  const now = Date.now()
  const prev = lastErrorAt.get(key)
  if (prev != null && now - prev < ERROR_DEDUPE_MS) return
  lastErrorAt.set(key, now)
  signal('error', { message: msg, source: src })
}
