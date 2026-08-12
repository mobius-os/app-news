const INITIAL_SECONDS_PER_WORD = 0.38
const MIN_SECONDS_PER_WORD = 0.28
const MAX_SECONDS_PER_WORD = 0.75
const MIN_CALIBRATION_WORDS = 12
const MIN_PART_SECONDS = 0.4

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
  return index < total - 1 ? Math.max(0, Number(part?.pauseMs) || 0) / 1000 : 0
}

export function estimateSpeechDuration(parts, secondsPerWord = INITIAL_SECONDS_PER_WORD) {
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
    initialDuration: estimateSpeechDuration(parts),
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
