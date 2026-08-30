export function concatAudioFrames(frames, sampleCount = undefined) {
  const length = Number.isFinite(sampleCount)
    ? Math.max(0, Math.floor(sampleCount))
    : frames.reduce((total, frame) => total + (frame?.length || 0), 0)
  const samples = new Float32Array(length)
  let offset = 0
  for (const frame of frames) {
    if (!(frame instanceof Float32Array) || !frame.length) continue
    samples.set(frame, offset)
    offset += frame.length
  }
  return samples
}

function audibleWindow(samples, windowSamples, threshold, reverse = false) {
  const thresholdSquared = threshold * threshold
  if (reverse) {
    for (let end = samples.length; end > 0; end -= windowSamples) {
      const start = Math.max(0, end - windowSamples)
      let energy = 0
      for (let index = start; index < end; index += 1) energy += samples[index] ** 2
      if (energy / Math.max(1, end - start) >= thresholdSquared) return end
    }
    return -1
  }
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples)
    let energy = 0
    for (let index = start; index < end; index += 1) energy += samples[index] ** 2
    if (energy / Math.max(1, end - start) >= thresholdSquared) return start
  }
  return -1
}

/**
 * Pocket TTS finishes every independent prompt with several audio frames so
 * the decoder can complete the final phoneme. Keep a rolling tail and remove
 * only quiet boundary audio, preserving padding around real speech. This lets
 * News keep semantic prompts without stacking model silence and UI pauses.
 */
export function createSpeechBoundaryTrimmer({
  sampleRate,
  onSamples,
  // Quiet final consonants—especially the sibilants in dates and names—can
  // sit below the old threshold even though they are clearly audible. Keep
  // them; the short, retained tail below still removes the model's long stop.
  threshold = 0.001,
  windowMs = 10,
  fadeMs = 8,
  leadingPaddingMs = 40,
  trailingPaddingMs = 100,
  trailingHoldMs = 520,
}) {
  const rate = Math.max(1, Math.floor(Number(sampleRate) || 1))
  const windowSamples = Math.max(1, Math.round(rate * windowMs / 1000))
  const leadingPadding = Math.max(0, Math.round(rate * leadingPaddingMs / 1000))
  const trailingPadding = Math.max(0, Math.round(rate * trailingPaddingMs / 1000))
  const trailingHold = Math.max(1, Math.round(rate * trailingHoldMs / 1000))
  const fadeSamples = Math.max(0, Math.round(rate * fadeMs / 1000))
  let started = false
  let emitted = false
  let leadingFrames = []
  let leadingSamples = 0
  let tailFrames = []
  let tailSamples = 0

  const emit = (samples, final = false) => {
    if (!samples.length) return
    const fadeIn = !emitted
    const edge = Math.min(fadeSamples, samples.length)
    const output = edge && (fadeIn || final) ? samples.slice() : samples
    if (edge > 1 && fadeIn) {
      for (let index = 0; index < edge; index += 1) {
        output[index] *= index / (edge - 1)
      }
    }
    if (edge > 1 && final) {
      const offset = output.length - edge
      for (let index = 0; index < edge; index += 1) {
        output[offset + index] *= (edge - 1 - index) / (edge - 1)
      }
    }
    onSamples(output)
    emitted = true
  }

  const queueTail = (samples) => {
    if (!samples.length) return
    tailFrames.push(samples)
    tailSamples += samples.length
    // Emit whole model frames while retaining at least the reviewed tail.
    while (tailFrames.length > 1 && tailSamples - tailFrames[0].length >= trailingHold) {
      const frame = tailFrames.shift()
      tailSamples -= frame.length
      emit(frame)
    }
  }

  const reset = () => {
    started = false
    emitted = false
    leadingFrames = []
    leadingSamples = 0
    tailFrames = []
    tailSamples = 0
  }

  return {
    push(samples) {
      if (!(samples instanceof Float32Array) || !samples.length) return
      if (started) {
        queueTail(samples)
        return
      }
      leadingFrames.push(samples)
      const firstAudible = audibleWindow(samples, windowSamples, threshold)
      if (firstAudible < 0) {
        leadingSamples += samples.length
        return
      }
      const allLeading = concatAudioFrames(
        leadingFrames,
        leadingSamples + samples.length,
      )
      const speechAt = leadingSamples + firstAudible
      started = true
      leadingFrames = []
      leadingSamples = 0
      queueTail(allLeading.slice(Math.max(0, speechAt - leadingPadding)))
    },
    flush() {
      if (!started) {
        reset()
        return 0
      }
      const tail = concatAudioFrames(tailFrames, tailSamples)
      const lastAudible = audibleWindow(tail, windowSamples, threshold, true)
      const keep = lastAudible < 0
        ? Math.min(tail.length, trailingPadding)
        : Math.min(tail.length, lastAudible + trailingPadding)
      if (keep) emit(tail.slice(0, keep), true)
      reset()
      return keep
    },
  }
}
