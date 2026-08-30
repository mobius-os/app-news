const INITIAL_SECONDS_PER_WORD = 0.38
const MIN_SECONDS_PER_WORD = 0.28
const MAX_SECONDS_PER_WORD = 0.75
const MIN_CALIBRATION_WORDS = 12
const MIN_PART_SECONDS = 0.4

export const PLAYBACK_RATES = Object.freeze([1, 1.25, 1.5, 2])

export function normalizePlaybackRate(value) {
  const rate = Number(value)
  return PLAYBACK_RATES.includes(rate) ? rate : 1
}

const PAUSE_AFTER_MS = {
  eyebrow: 480,
  title: 900,
  summary: 650,
  section: 900,
  subsection: 650,
  paragraph: 500,
  list: 260,
  quote: 650,
  callout: 650,
  caption: 500,
  'section-end': 1_000,
}

/**
 * Preserve the report's hierarchy without making every independently
 * synthesized block sound like a stop. List items stay close together, while
 * entering or leaving the list gets the audible boundary the group needs.
 */
export function speechPauseMs(kind, nextKind) {
  const base = PAUSE_AFTER_MS[kind] ?? PAUSE_AFTER_MS.paragraph
  if (kind === 'list') {
    return nextKind === 'list' ? base : PAUSE_AFTER_MS.paragraph
  }
  if (nextKind === 'list') return Math.max(base, PAUSE_AFTER_MS.paragraph)
  return base
}

export function addSpeechPauses(parts) {
  return parts.map((part, index) => ({
    ...part,
    pauseMs: speechPauseMs(part?.kind, parts[index + 1]?.kind),
  }))
}

export function countSpokenWords(text) {
  return String(text || '').match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0
}

function estimatedPartSeconds(words, secondsPerWord) {
  return words > 0 ? Math.max(MIN_PART_SECONDS, words * secondsPerWord) : 0
}

function pauseSeconds(part, index, total) {
  return index < total - 1
    ? Math.max(0, Number(part?.pauseMs) || 0) / 1000
    : 0
}

export function estimateSpeechDuration(
  parts,
  secondsPerWord = INITIAL_SECONDS_PER_WORD,
) {
  return parts.reduce((total, part, index) => (
    total
      + estimatedPartSeconds(countSpokenWords(part?.text), secondsPerWord)
      + pauseSeconds(part, index, parts.length)
  ), 0)
}

/**
 * Start with an honest whole-report estimate, then learn the current voice's
 * rate from completed audio without making the player understand TTS internals.
 */
export function createSpeechTimeline(parts) {
  const wordCounts = parts.map((part) => countSpokenWords(part?.text))
  let generatedWords = 0
  let generatedSpeechSeconds = 0

  return {
    initialDuration: estimateSpeechDuration(parts, INITIAL_SECONDS_PER_WORD),
    completePart(index, actualSpeechSeconds, queuedSeconds) {
      generatedWords += wordCounts[index] || 0
      generatedSpeechSeconds += Math.max(0, Number(actualSpeechSeconds) || 0)
      const learnedRate = generatedWords >= MIN_CALIBRATION_WORDS
        ? Math.max(
          MIN_SECONDS_PER_WORD,
          Math.min(MAX_SECONDS_PER_WORD, generatedSpeechSeconds / generatedWords),
        )
        : INITIAL_SECONDS_PER_WORD
      let remaining = 0
      for (let next = index + 1; next < parts.length; next += 1) {
        remaining += estimatedPartSeconds(wordCounts[next], learnedRate)
        remaining += pauseSeconds(parts[next], next, parts.length)
      }
      return Math.max(0, Number(queuedSeconds) || 0) + remaining
    },
  }
}

function playbackResume(value) {
  const resume = value?.resume
  if (!resume || typeof resume !== 'object') return null
  const reportKey = typeof resume.reportKey === 'string' ? resume.reportKey.trim() : ''
  const nextSegment = Number(resume.nextSegment)
  if (!reportKey || !Number.isInteger(nextSegment) || nextSegment < 0) return null
  return { reportKey, nextSegment }
}

export function normalizePlaybackSettings(value) {
  const settings = { rate: normalizePlaybackRate(value?.rate) }
  const resume = playbackResume(value)
  if (resume) settings.resume = resume
  return settings
}

export function playbackSettingsWithRate(value, rate) {
  return {
    ...normalizePlaybackSettings(value),
    rate: normalizePlaybackRate(rate),
  }
}

export function playbackSettingsWithResume(value, resume) {
  const settings = normalizePlaybackSettings(value)
  const normalized = playbackResume({ resume })
  if (normalized) return { ...settings, resume: normalized }
  const { resume: _discarded, ...withoutResume } = settings
  return withoutResume
}

export function resumeSegmentFor(value, reportKey, segmentCount) {
  const resume = playbackResume(value)
  const total = Math.max(0, Math.floor(Number(segmentCount) || 0))
  return resume?.reportKey === reportKey && resume.nextSegment < total
    ? resume.nextSegment
    : null
}

/** A compact content identity keeps a same-day regenerated report from
 * resuming into the wrong paragraph without retaining report text in settings.
 */
export function speechReportKey(date, segments) {
  const identity = [
    String(date || 'report'),
    ...(Array.isArray(segments) ? segments : []).map((segment) => (
      `${segment?.kind || ''}\u0000${segment?.text || ''}\u0000${segment?.pauseAfterMs || 0}`
    )),
  ].join('\u0001')
  let hash = 0x811c9dc5
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${String(date || 'report')}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
