import { JaxPocketTtsRuntime } from './jax-pocket-tts-vendor.js'
import { loadTtsModelAssets } from './tts-model-pack.js'

let sharedEngine = null
let sharedEngineKey = ''

function abortError() {
  return new DOMException('Aborted', 'AbortError')
}

class BrowserPocketTts {
  constructor(appId, token) {
    this.appId = appId
    this.token = token
    this.runtime = new JaxPocketTtsRuntime()
    this.loaded = false
    this.loading = null
    this.generating = false
    this.backend = null
  }

  async load({ signal, onProgress } = {}) {
    if (this.loaded) return { backend: this.backend }
    if (signal?.aborted) throw abortError()
    if (!this.loading) {
      this.loading = loadTtsModelAssets(this.appId, this.token, { signal, onProgress })
        .then((assets) => this.runtime.load({
          signal,
          // Download progress owns 1–88. The runtime then reports model
          // hydration at 90–100 without making another network request.
          onProgress: (percent) => onProgress?.(percent < 90 ? 89 : percent),
          tokenizerBytes: assets.tokenizer,
          voiceBytes: assets.voice,
          modelBytes: assets.model,
        }))
        .then((result) => {
          this.loaded = true
          this.backend = result.backend
          return result
        })
        .finally(() => {
          this.loading = null
        })
    }
    return this.loading
  }

  async generate(text, { signal, onChunk } = {}) {
    if (!this.loaded) throw new Error('The browser speech model is not ready.')
    if (this.generating) throw new Error('The browser speech model is already speaking.')
    if (signal?.aborted) throw abortError()
    this.generating = true
    try {
      await this.runtime.generate(text, { signal, onChunk, temperature: 0.7 })
    } finally {
      this.generating = false
    }
  }

  reset() {
    this.runtime.dispose()
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
    sharedEngine = new BrowserPocketTts(appId, token)
    sharedEngineKey = key
  }
  return sharedEngine
}

export function releaseBrowserSpeechEngine() {
  sharedEngine?.reset()
  sharedEngine = null
  sharedEngineKey = ''
}
