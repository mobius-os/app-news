import React, { useState } from 'react'

// Native tap-card UI for the agent's in-report questions. Mirrors the shell
// QuestionCard's shape ({question, header, multiSelect, options:[{label,
// description}]}) but is a single-file, install-safe copy — no sibling
// imports, no streaming/answeredMap plumbing. The card collects an answer
// per question, and on submit calls onAnswer({ "<question text>": "<chosen
// label(s)>" }), then flips to a local "answered" state. The answers are
// persisted by the caller for the NEXT run (not a live agent) — the note
// copy says so.
export function ReportQuestions({ questions, onAnswer }) {
  const [picks, setPicks] = useState({})        // question -> label | [labels]
  const [answered, setAnswered] = useState(false)
  // In-flight + failure state for the save. The card flips to the permanent
  // "answered" view ONLY after onAnswer reports a durable write; a failed
  // save keeps the options interactive so the partner can retry.
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  if (!Array.isArray(questions) || questions.length === 0) return null

  const allAnswered = questions.every((q) => {
    const p = picks[q.question]
    return q.multiSelect ? Array.isArray(p) && p.length > 0 : !!p
  })

  const choose = (q, label) => {
    if (answered) return
    setPicks((prev) => {
      if (q.multiSelect) {
        const cur = Array.isArray(prev[q.question]) ? prev[q.question] : []
        const next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        return { ...prev, [q.question]: next }
      }
      return { ...prev, [q.question]: label }
    })
  }

  const submit = async () => {
    if (!allAnswered || answered || saving) return
    const answers = {}
    for (const q of questions) {
      const p = picks[q.question]
      answers[q.question] = Array.isArray(p) ? p.join(', ') : (p || '')
    }
    // Don't flip to "answered" until the write is confirmed durable. onAnswer
    // resolves true when the answers reached the server or the offline queue;
    // a failed write resolves false, and we keep the card interactive with a
    // retry rather than silently dropping the partner's answer.
    setSaving(true)
    setSaveError('')
    let durable = false
    try {
      durable = (await onAnswer?.(answers)) === true
    } catch {
      durable = false
    }
    setSaving(false)
    if (durable) {
      setAnswered(true)
    } else {
      setSaveError('Couldn’t save your answers — try again.')
    }
  }

  return (
    <div className={`nw-rq${answered ? ' nw-rq--answered' : ''}`}>
      <p className="nw-rq__title">A few questions for next time</p>
      <p className="nw-rq__note">
        Your answers guide my next digest — they won’t change this one.
      </p>
      {questions.map((q, qi) => {
        const isMulti = q.multiSelect
        const cur = picks[q.question]
        const selected = (label) =>
          isMulti ? (Array.isArray(cur) && cur.includes(label)) : cur === label
        return (
          <div key={qi} className="nw-rq__q">
            {q.header && <div className="nw-rq__header">{q.header}</div>}
            <div className="nw-rq__text">{q.question}</div>
            {!answered && (
              <div className="nw-rq__hint">
                {isMulti ? 'Select all that apply' : 'Choose one'}
              </div>
            )}
            <div
              className="nw-rq__opts"
              role={isMulti ? 'group' : 'radiogroup'}
              aria-label={q.question}
            >
              {q.options.map((opt, oi) => {
                const on = selected(opt.label)
                const dim = answered && !on
                return (
                  <button
                    key={oi}
                    type="button"
                    role={isMulti ? 'checkbox' : 'radio'}
                    aria-checked={on}
                    className={`nw-rq__opt${on ? ' nw-rq__opt--on' : ''}${dim ? ' nw-rq__opt--dim' : ''}`}
                    onClick={answered ? undefined : () => choose(q, opt.label)}
                    disabled={answered}
                    title={opt.description || ''}
                  >
                    {opt.label}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {answered ? (
        <div className="nw-rq__done">Saved — I’ll use this for my next digest.</div>
      ) : (
        <>
          <button
            type="button"
            className="nw-rq__submit"
            onClick={submit}
            disabled={!allAnswered || saving}
          >
            {saving ? 'Saving…' : 'Save for next time'}
          </button>
          {saveError && <div className="nw-rq__error" role="alert">{saveError}</div>}
        </>
      )}
    </div>
  )
}
