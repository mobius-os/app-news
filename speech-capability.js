import { applySpeechHints, sanitizeSpeechHints } from './report-schema.mjs'

const SPEECH_CAPABILITY = 'media.speech'
export const SPEECH_DOCUMENT_MAX_TEXT_CHARS = 50_000
const SPEECH_DOCUMENT_MAX_SEGMENTS = 512

function capabilityApi() {
  const capabilities = globalThis.mobius?.capabilities
  if (!capabilities?.available?.(SPEECH_CAPABILITY, 1)) {
    throw new Error('This version of Möbius cannot generate shared speech yet.')
  }
  return capabilities
}

function bindAbort(session, signal) {
  if (!signal) return () => {}
  const cancel = () => session.cancel()
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  return () => signal.removeEventListener('abort', cancel)
}

export function isSpeechCancellation(error) {
  return error?.name === 'AbortError'
    || error?.code === 'aborted'
}

export async function readVoiceCatalog(signal) {
  return capabilityApi().invoke(SPEECH_CAPABILITY, { operation: 'catalog' }, { signal })
}

export function activeVoiceModel(catalog) {
  return catalog?.activeModel || null
}

export function openVoiceApp() {
  globalThis.parent?.postMessage?.({ type: 'moebius:open-app', appId: 'voice' }, '*')
}

function oversizedBlock(index, maxTextChars) {
  const error = new RangeError(
    `Report block ${index + 1} exceeds the ${maxTextChars.toLocaleString()}-character speech limit.`,
  )
  error.code = 'speech_block_too_long'
  return error
}

/**
 * Partition one ordered Speech Document into the fewest contiguous documents
 * accepted by the host. A semantic block is never split or dropped. Both the
 * visible text and its agent-authored spoken form count toward the limit.
 */
export function batchSpeechDocument(document, {
  maxTextChars = SPEECH_DOCUMENT_MAX_TEXT_CHARS,
  maxSegments = SPEECH_DOCUMENT_MAX_SEGMENTS,
} = {}) {
  if (!document || document.version !== 1) {
    throw new TypeError('Speech Document version 1 is required.')
  }
  if (!Array.isArray(document.segments) || document.segments.length === 0) {
    throw new TypeError('Speech Document segments are required.')
  }
  if (!Number.isInteger(maxTextChars) || maxTextChars < 1
    || !Number.isInteger(maxSegments) || maxSegments < 1) {
    throw new TypeError('Speech Document batch limits must be positive integers.')
  }

  const hints = sanitizeSpeechHints(document.hints)
  const batches = []
  let segments = []
  let rawChars = 0
  let spokenChars = 0

  const finish = () => {
    if (!segments.length) return
    batches.push({
      version: 1,
      locale: document.locale || '',
      hints,
      segments,
    })
    segments = []
    rawChars = 0
    spokenChars = 0
  }

  document.segments.forEach((segment, index) => {
    if (!segment || typeof segment.text !== 'string') {
      throw new TypeError(`Report block ${index + 1} requires text.`)
    }
    const rawLength = segment.text.length
    if (rawLength > maxTextChars) throw oversizedBlock(index, maxTextChars)
    let spokenText
    try {
      spokenText = applySpeechHints(segment.text, hints, maxTextChars)
    } catch (error) {
      if (error?.code === 'speech_text_too_long') throw oversizedBlock(index, maxTextChars)
      throw error
    }
    const spokenLength = spokenText.length
    if (segments.length > 0 && (
      segments.length >= maxSegments
      || rawChars > maxTextChars - rawLength
      || spokenChars > maxTextChars - spokenLength
    )) finish()

    segments.push(segment)
    rawChars += rawLength
    spokenChars += spokenLength
  })
  finish()
  return batches
}

export async function synthesizeSpeech({
  text,
  document,
  modelId,
  signal,
  onAudio,
  onLoading,
  onBoundary,
}) {
  const session = capabilityApi().open(SPEECH_CAPABILITY, {
    operation: 'synthesize', text, document, modelId,
  })
  const unbind = bindAbort(session, signal)
  const stopAudio = session.on('audio', (value) => {
    if (value?.samples instanceof Float32Array) onAudio?.(value.samples)
  })
  const stopLoading = session.on('loading', (value) => onLoading?.(value))
  const stopBoundary = session.on('boundary', (value) => onBoundary?.(value))
  try {
    return await session.result
  } finally {
    stopAudio()
    stopLoading()
    stopBoundary()
    unbind()
  }
}
