import { BROWSER_TTS_WORKER_SOURCE } from './browser-tts-worker-source.js'

let sharedEngine = null

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

class BrowserPocketTts {
  constructor() {
    this.worker = null
    this.workerUrl = ''
    this.loaded = false
    this.loading = null
    this.loadCallbacks = null
    this.generation = null
  }

  ensureWorker() {
    if (this.worker) return
    this.workerUrl = URL.createObjectURL(new Blob(
      [BROWSER_TTS_WORKER_SOURCE],
      { type: 'text/javascript' },
    ))
    this.worker = new Worker(this.workerUrl, { type: 'module' })
    this.worker.onmessage = (event) => this.onMessage(event.data || {})
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The browser speech worker stopped unexpectedly.')
      this.rejectPending(error)
      this.reset()
    }
  }

  rejectPending(error) {
    this.loadCallbacks?.reject(error)
    this.generation?.reject(error)
    this.loadCallbacks = null
    this.generation = null
    this.loading = null
  }

  onMessage(message) {
    if (message.type === 'progress') {
      this.loadCallbacks?.onProgress?.(Number.isFinite(message.pct) ? message.pct : null)
      return
    }
    if (message.type === 'loaded') {
      this.loaded = true
      this.loadCallbacks?.resolve(message)
      this.loadCallbacks = null
      return
    }
    if (message.type === 'chunk') {
      this.generation?.onChunk?.(new Float32Array(message.data))
      return
    }
    if (message.type === 'done') {
      this.generation?.resolve(message)
      this.generation = null
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.message || 'Pocket TTS could not generate speech.')
      if (this.generation) {
        this.generation.reject(error)
      } else {
        this.loadCallbacks?.reject(error)
      }
      this.reset()
    }
  }

  async load({ signal, onProgress } = {}) {
    if (this.loaded) return
    if (signal?.aborted) throw abortError()
    if (!this.loading) {
      this.ensureWorker()
      this.loading = new Promise((resolve, reject) => {
        this.loadCallbacks = { resolve, reject, onProgress }
        this.worker.postMessage({ type: 'load', quant: 'q8' })
      })
    } else if (this.loadCallbacks) {
      this.loadCallbacks.onProgress = onProgress
    }
    const onAbort = () => {
      this.rejectPending(abortError())
      this.reset()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await this.loading
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async generate(text, { signal, onChunk } = {}) {
    if (!this.loaded) throw new Error('The browser speech model is not ready.')
    if (this.generation) throw new Error('The browser speech model is already speaking.')
    if (signal?.aborted) throw abortError()
    const onAbort = () => {
      this.generation?.reject(abortError())
      this.generation = null
      this.reset()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await new Promise((resolve, reject) => {
        this.generation = { resolve, reject, onChunk }
        this.worker.postMessage({ type: 'generate', text, voiceName: 'alba', temperature: 0.7 })
      })
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  reset() {
    this.worker?.terminate()
    this.worker = null
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl)
    this.workerUrl = ''
    this.loaded = false
    this.loading = null
    this.loadCallbacks = null
    this.generation = null
  }
}

export function browserSpeechEngine() {
  if (!sharedEngine) sharedEngine = new BrowserPocketTts()
  return sharedEngine
}

export function releaseBrowserSpeechEngine() {
  sharedEngine?.reset()
  sharedEngine = null
}
