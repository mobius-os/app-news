import React, { useState, useEffect, useRef, useCallback } from 'react'

export function ModelPicker({
  provider, model, groups, connectedProviders, onChange,
}) {
  const [open, setOpen] = useState(false)
  const sheetRef = useRef(null)
  const navRef = useRef(null)
  // The trigger that opened the sheet, so focus can be restored to it on
  // close (sheet is a dialog — losing the user's place is a keyboard a11y
  // failure). Kept in a ref so it survives re-renders without re-running
  // the focus effect.
  const triggerRef = useRef(null)
  const activeGroup = groups?.find((g) => g.key === provider)
  const activeModel = activeGroup?.models.find((m) => m.id === model)
  const label = activeModel
    ? `${activeGroup.label} · ${activeModel.name}`
    : model || 'Choose model'

  const closeSheet = useCallback(() => {
    const handle = navRef.current
    navRef.current = null
    setOpen(false)
    try { handle?.close?.() } catch {}
  }, [])

  const openSheet = useCallback(async () => {
    if (open) return
    if (typeof window !== 'undefined' && window.mobius?.nav?.open) {
      const handle = window.mobius.nav.open('news-model-picker', () => {
        navRef.current = null
        setOpen(false)
      })
      navRef.current = handle
      const ready = handle.ready ? await handle.ready.catch(() => false) : true
      if (navRef.current !== handle) return
      if (ready === false) {
        navRef.current = null
        try { handle.close?.() } catch {}
        return
      }
    }
    setOpen(true)
  }, [open])

  // On open, move focus into the sheet so a keyboard user lands inside the
  // dialog (and Escape closes it); on close, return focus to the trigger.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') closeSheet() }
    document.addEventListener('keydown', onKey)
    // Focus the first focusable control in the sheet (the Close button).
    const first = sheetRef.current?.querySelector(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    first?.focus?.()
    return () => {
      document.removeEventListener('keydown', onKey)
      triggerRef.current?.focus?.()
    }
  }, [open, closeSheet])

  useEffect(() => () => {
    try { navRef.current?.close?.() } catch {}
  }, [])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="nw-model-button"
        onClick={openSheet}
      >
        <span className="nw-model-button-main">
          <span className="nw-model-button-label">{label}</span>
          <span className="nw-model-button-sub">
            {model}
          </span>
        </span>
        <span aria-hidden="true" className="nw-model-button-caret">▾</span>
      </button>
      {open && (
        <div className="nw-picker-backdrop" onClick={closeSheet}>
          <div
            ref={sheetRef}
            className="nw-picker-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Choose model"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="nw-picker-head">
              <div className="nw-picker-head-title">Model</div>
              <button type="button" className="nw-link-btn" onClick={closeSheet}>Close</button>
            </div>
            {!groups || groups.length === 0 ? (
              <div className="nw-note">No visible models. Adjust model visibility from chat settings.</div>
            ) : groups.map((group) => {
              const connected = !connectedProviders || connectedProviders.has(group.key)
              return (
                <div key={group.key} className="nw-model-group">
                  <div className="nw-model-group-header">
                    <span>{group.label}</span>
                    {!connected && <span className="nw-model-group-hint">not connected</span>}
                  </div>
                  {group.models.map((m) => {
                    const on = provider === group.key && model === m.id
                    const disabled = !connected && !on
                    return (
                      <button
                        key={`${group.key}-${m.id}`}
                        type="button"
                        className={`nw-model-row${on ? ' is-on' : ''}`}
                        disabled={disabled}
                        onClick={() => {
                          onChange(group.key, m.id)
                          closeSheet()
                        }}
                      >
                        <div className="nw-model-row-main">
                          <span className="nw-model-row-title">{m.name}</span>
                          <span className="nw-model-row-sub">{m.id}</span>
                        </div>
                        {on && <span aria-hidden="true">✓</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}
