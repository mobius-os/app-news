import { POCKET_TTS_WORKER_SOURCE } from './browser-tts-worker-source.js'
import { streamTtsModelPack } from './tts-model-pack.js'

let sharedEngine = null
let sharedEngineKey = ''

const WEBGPU_REQUIRED_MESSAGE = 'Listening needs WebGPU with fp16 support. On Apple devices, use iOS or macOS 26 or later.'

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

function restoredError(value, fallback = 'Speech stopped unexpectedly.') {
  const error = new Error(value?.message || fallback)
  error.name = value?.name || 'Error'
  return error
}

async function requirePocketTtsWebGpu(signal) {
  if (signal?.aborted) throw abortError()
  if (!globalThis.navigator?.gpu) throw new Error(WEBGPU_REQUIRED_MESSAGE)
  let adapter
  try {
    adapter = await globalThis.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch {
    throw new Error(WEBGPU_REQUIRED_MESSAGE)
  }
  if (signal?.aborted) throw abortError()
  if (!adapter?.features?.has('shader-f16')) throw new Error(WEBGPU_REQUIRED_MESSAGE)
}

class PocketTtsWorkerRuntime {
  constructor() {
    this.worker = null
    this.workerUrl = ''
    this.loadPending = null
    this.chunks = new Map()
    this.generations = new Map()
    this.nextChunkId = 1
    this.nextRequestId = 1
  }

  ensureWorker() {
    if (this.worker) return this.worker
    if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
      throw new Error('This browser cannot run the speech model away from the page.')
    }
    this.workerUrl = URL.createObjectURL(new Blob(
      [POCKET_TTS_WORKER_SOURCE],
      { type: 'text/javascript' },
    ))
    const worker = new Worker(this.workerUrl)
    worker.onmessage = (event) => this.onMessage(event.data)
    worker.onerror = (event) => this.failAll(new Error(event.message || 'The speech worker stopped.'))
    this.worker = worker
    return worker
  }

  onMessage(message) {
    if (!message || typeof message !== 'object') return
    if (message.type === 'load-ready') {
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl)
      this.workerUrl = ''
      return
    }
    if (message.type === 'load-progress') {
      this.loadPending?.onProgress?.(message.progress)
      return
    }
    if (message.type === 'chunk-accepted') {
      const pending = this.chunks.get(message.chunkId)
      this.chunks.delete(message.chunkId)
      pending?.resolve()
      return
    }
    if (message.type === 'load-complete') {
      const pending = this.loadPending
      this.loadPending = null
      pending?.resolve({ backend: message.backend })
      return
    }
    if (message.type === 'audio') {
      const generation = this.generations.get(message.requestId)
      if (!generation) return
      Promise.resolve()
        .then(() => generation.onChunk?.(message.samples))
        .then(() => this.worker?.postMessage({
          type: 'audio-ack',
          audioId: message.audioId,
        }))
        .catch((error) => {
          generation.cleanup()
          generation.reject(error)
          this.generations.delete(message.requestId)
          this.worker?.postMessage({ type: 'cancel-generate' })
        })
      return
    }
    if (message.type === 'generate-complete') {
      const generation = this.generations.get(message.requestId)
      this.generations.delete(message.requestId)
      generation?.cleanup()
      generation?.resolve()
      return
    }
    if (message.type === 'generate-error') {
      const generation = this.generations.get(message.requestId)
      this.generations.delete(message.requestId)
      generation?.cleanup()
      generation?.reject(restoredError(message.error))
      return
    }
    if (message.type === 'worker-error') {
      const error = restoredError(message.error)
      if (message.requestId && this.generations.has(message.requestId)) {
        const generation = this.generations.get(message.requestId)
        this.generations.delete(message.requestId)
        generation.cleanup()
        generation.reject(error)
      } else {
        this.failAll(error)
      }
    }
  }

  failAll(error) {
    if (this.loadPending) this.loadPending.reject(error)
    this.loadPending = null
    for (const pending of this.chunks.values()) pending.reject(error)
    this.chunks.clear()
    for (const generation of this.generations.values()) {
      generation.cleanup()
      generation.reject(error)
    }
    this.generations.clear()
  }

  sendChunk(value) {
    const worker = this.ensureWorker()
    const chunkId = this.nextChunkId++
    const bytes = value?.bytes
    if (!(bytes instanceof ArrayBuffer)) {
      return Promise.reject(new Error('The speech cache returned an invalid chunk.'))
    }
    const accepted = new Promise((resolve, reject) => {
      this.chunks.set(chunkId, { resolve, reject })
    })
    worker.postMessage({
      type: 'asset-chunk',
      chunkId,
      assetId: value.assetId,
      index: value.index,
      bytes,
    }, [bytes])
    return accepted
  }

  async load({ signal, onProgress } = {}) {
    const worker = this.ensureWorker()
    if (this.loadPending) throw new Error('The speech model is already loading.')
    let resolveLoad
    let rejectLoad
    const loaded = new Promise((resolve, reject) => {
      resolveLoad = resolve
      rejectLoad = reject
    })
    this.loadPending = { resolve: resolveLoad, reject: rejectLoad, onProgress }
    const cancel = () => {
      this.dispose()
      rejectLoad(abortError())
    }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      worker.postMessage({ type: 'load-start' })
      await streamTtsModelPack({
        signal,
        onChunk: (value) => this.sendChunk(value),
        onProgress,
      })
      worker.postMessage({ type: 'load-finish' })
      return await loaded
    } catch (error) {
      this.dispose()
      throw error
    } finally {
      signal?.removeEventListener('abort', cancel)
    }
  }

  generate(text, { signal, onChunk } = {}) {
    const worker = this.ensureWorker()
    if (signal?.aborted) return Promise.reject(abortError())
    const requestId = `speech-${this.nextRequestId++}`
    return new Promise((resolve, reject) => {
      const cancel = () => {
        worker.postMessage({ type: 'cancel-generate' })
        this.generations.delete(requestId)
        reject(abortError())
      }
      signal?.addEventListener('abort', cancel, { once: true })
      this.generations.set(requestId, {
        resolve,
        reject,
        onChunk,
        cleanup: () => signal?.removeEventListener('abort', cancel),
      })
      worker.postMessage({ type: 'generate', requestId, text })
    })
  }

  dispose() {
    const error = abortError()
    try { this.worker?.postMessage({ type: 'dispose' }) } catch {}
    this.worker?.terminate()
    this.worker = null
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl)
    this.workerUrl = ''
    this.failAll(error)
  }
}

class BrowserPocketTts {
  constructor() {
    this.runtime = new PocketTtsWorkerRuntime()
    this.loaded = false
    this.loading = null
    this.generating = false
    this.backend = null
  }

  async load({ signal, onProgress } = {}) {
    if (this.loaded) return { backend: this.backend }
    if (signal?.aborted) throw abortError()
    if (!this.loading) {
      // Reject an unsupported browser before reading the 186 MB device pack.
      this.loading = requirePocketTtsWebGpu(signal)
        .then(() => this.runtime.load({
          signal,
          onProgress: (percent) => onProgress?.(percent < 90 ? 89 : percent),
        }))
        .then((result) => {
          this.loaded = true
          this.backend = result.backend
          return result
        })
        .finally(() => { this.loading = null })
    }
    return this.loading
  }

  async generate(text, { signal, onChunk } = {}) {
    if (!this.loaded) throw new Error('The browser speech model is not ready.')
    if (this.generating) throw new Error('The browser speech model is already speaking.')
    if (signal?.aborted) throw abortError()
    this.generating = true
    try {
      await this.runtime.generate(text, { signal, onChunk })
    } finally {
      this.generating = false
    }
  }

  reset() {
    this.runtime.dispose()
    this.runtime = new PocketTtsWorkerRuntime()
    this.loaded = false
    this.loading = null
    this.generating = false
    this.backend = null
  }
}

export function browserSpeechEngine(appId, token) {
  const key = `${appId}:${token}`
  if (sharedEngine && sharedEngineKey !== key) releaseBrowserSpeechEngine()
  if (!sharedEngine) {
    sharedEngine = new BrowserPocketTts()
    sharedEngineKey = key
  }
  return sharedEngine
}

export function releaseBrowserSpeechEngine() {
  sharedEngine?.reset()
  sharedEngine = null
  sharedEngineKey = ''
}
