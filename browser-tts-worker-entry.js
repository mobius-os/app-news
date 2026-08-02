import { JaxPocketTtsRuntime } from './jax-pocket-tts-vendor.js'

const MODEL_BYTES = 235_738_516

let runtime = new JaxPocketTtsRuntime()
let tokenizerBytes = null
let voiceBytes = null
let modelBytes = null
let modelOffset = 0
let modelWriter = null
let modelReaderTask = null
let messageChain = Promise.resolve()
let generationController = null
let nextAudioId = 1
const audioAcks = new Map()

function post(type, value = {}, transfer = []) {
  globalThis.postMessage({ type, ...value }, transfer)
}

function errorValue(error) {
  return {
    name: error?.name || 'Error',
    message: error?.message || 'Speech stopped unexpectedly.',
  }
}

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

function resetAssets() {
  tokenizerBytes = null
  voiceBytes = null
  modelBytes = null
  modelOffset = 0
  modelWriter = null
  modelReaderTask = null
}

async function beginLoad() {
  if (!globalThis.navigator?.gpu) {
    throw new Error('Listening needs WebGPU with fp16 support. On Apple devices, use iOS or macOS 26 or later.')
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot unpack the local speech model.')
  }
  // jax-js yields once before hydrating weights. Workers do not expose rAF,
  // so provide the same event-loop yield without patching the vendored build.
  globalThis.requestAnimationFrame ||= (callback) => setTimeout(
    () => callback(globalThis.performance?.now?.() || Date.now()),
    0,
  )
  resetAssets()
  modelBytes = new Uint8Array(MODEL_BYTES)
  const decompressor = new DecompressionStream('gzip')
  modelWriter = decompressor.writable.getWriter()
  modelReaderTask = (async () => {
    const reader = decompressor.readable.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (modelOffset + value.length > modelBytes.length) {
          throw new Error('The speech model expanded beyond its pinned size.')
        }
        modelBytes.set(value, modelOffset)
        modelOffset += value.length
      }
    } finally {
      reader.releaseLock()
    }
  })()
  post('load-ready')
}

async function acceptChunk(message) {
  const bytes = new Uint8Array(message.bytes)
  if (message.assetId === 'tokenizer') tokenizerBytes = bytes
  else if (message.assetId === 'voice') voiceBytes = bytes
  else if (message.assetId === 'model') await modelWriter.write(bytes)
  else throw new Error(`Unknown speech asset ${message.assetId}.`)
  post('chunk-accepted', { chunkId: message.chunkId })
}

async function finishLoad() {
  if (!tokenizerBytes || !voiceBytes || !modelWriter || !modelReaderTask) {
    throw new Error('The speech model package is incomplete.')
  }
  await modelWriter.close()
  await modelReaderTask
  if (modelOffset !== MODEL_BYTES) {
    throw new Error('The speech model did not expand to its pinned size.')
  }
  const result = await runtime.load({
    tokenizerBytes,
    voiceBytes,
    modelBytes,
    onProgress: (progress) => post('load-progress', { progress }),
  })
  resetAssets()
  post('load-complete', result)
}

async function waitForAudioConsumer(audioId) {
  return new Promise((resolve, reject) => audioAcks.set(audioId, { resolve, reject }))
}

async function generate(message) {
  if (generationController) throw new Error('The browser speech model is already speaking.')
  generationController = new AbortController()
  try {
    await runtime.generate(message.text, {
      signal: generationController.signal,
      temperature: 0.7,
      onChunk: async (samples) => {
        const audioId = nextAudioId++
        const consumed = waitForAudioConsumer(audioId)
        post('audio', {
          requestId: message.requestId,
          audioId,
          samples,
        }, [samples.buffer])
        await consumed
      },
    })
    post('generate-complete', { requestId: message.requestId })
  } catch (error) {
    post('generate-error', { requestId: message.requestId, error: errorValue(error) })
  } finally {
    generationController = null
  }
}

function cancelGeneration() {
  generationController?.abort(abortError())
  for (const { reject } of audioAcks.values()) reject(abortError())
  audioAcks.clear()
}

globalThis.onmessage = ({ data: message }) => {
  if (!message || typeof message !== 'object') return
  if (message.type === 'audio-ack') {
    const pending = audioAcks.get(message.audioId)
    audioAcks.delete(message.audioId)
    pending?.resolve()
    return
  }
  if (message.type === 'cancel-generate') {
    cancelGeneration()
    return
  }
  if (message.type === 'dispose') {
    cancelGeneration()
    runtime.dispose()
    runtime = new JaxPocketTtsRuntime()
    resetAssets()
    return
  }

  messageChain = messageChain.then(async () => {
    if (message.type === 'load-start') await beginLoad()
    else if (message.type === 'asset-chunk') await acceptChunk(message)
    else if (message.type === 'load-finish') await finishLoad()
    else if (message.type === 'generate') await generate(message)
  }).catch((error) => {
    post('worker-error', { requestId: message.requestId, error: errorValue(error) })
  })
}
