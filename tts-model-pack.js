// Pocket TTS's weights belong to News data, not the platform. Setup asks the
// existing News job to prepare the pinned model pack once, then the browser
// player reads those files from same-origin app storage. This avoids both a
// platform speech service and production CSP exceptions for Hugging Face.

export const TTS_MODEL_PACK = Object.freeze({
  tokenizer: { file: 'tokenizer.model', bytes: 59_339, storedBytes: 59_339 },
  voice: { file: 'alba.safetensors', bytes: 512_088, storedBytes: 512_088 },
  model: {
    file: 'model.safetensors.gz',
    bytes: 235_738_516,
    storedBytes: 185_356_309,
    compression: 'gzip',
  },
})

export const TTS_MODEL_PACK_BYTES = Object.values(TTS_MODEL_PACK)
  .reduce((total, asset) => total + asset.bytes, 0)

export const TTS_MODEL_PACK_STORED_BYTES = Object.values(TTS_MODEL_PACK)
  .reduce((total, asset) => total + asset.storedBytes, 0)

export const TTS_MODEL_PACK_FORMAT = 'gzip-v1'

const POLL_INTERVAL_MS = 900
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` }
}

function storageUrl(appId, file) {
  return `/api/storage/apps/${appId}/tts/${file}`
}

export function ttsModelAssetUrls(appId) {
  return {
    tokenizer: storageUrl(appId, TTS_MODEL_PACK.tokenizer.file),
    voice: storageUrl(appId, TTS_MODEL_PACK.voice.file),
    model: storageUrl(appId, TTS_MODEL_PACK.model.file),
  }
}

export async function readTtsModelPackStatus(appId, token, signal) {
  try {
    const response = await fetch(storageUrl(appId, 'status.json'), {
      headers: authHeaders(token),
      cache: 'no-store',
      signal,
    })
    if (!response.ok) return null
    return await response.json()
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return null
  }
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Prepare the model pack as part of the user's explicit Listening choice.
 * The request marker is app data and fetch.sh consumes it before its ordinary
 * digest path, so this earns no new platform endpoint or service.
 */
export async function prepareTtsModelPack(appId, token, { signal, onProgress } = {}) {
  const existing = await readTtsModelPackStatus(appId, token, signal)
  if (existing?.state === 'ready' && existing?.pack_format === TTS_MODEL_PACK_FORMAT) {
    onProgress?.({ ...existing, progress: 100 })
    return existing
  }

  const requestId = globalThis.crypto?.randomUUID?.()
    || `tts-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const request = {
    request_id: requestId,
    requested_at: new Date().toISOString(),
  }
  const marker = await fetch(storageUrl(appId, 'install-request.json'), {
    method: 'PUT',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!marker.ok) throw new Error('News could not save the listening setup request.')

  onProgress?.({ state: 'queued', progress: 0, message: 'Starting listening setup…' })
  const launch = await fetch(`/api/apps/${appId}/run-job`, {
    method: 'POST',
    headers: authHeaders(token),
    signal,
  })
  if (!launch.ok) throw new Error(`News could not start listening setup (HTTP ${launch.status}).`)

  const deadline = Date.now() + INSTALL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await wait(POLL_INTERVAL_MS, signal)
    const status = await readTtsModelPackStatus(appId, token, signal)
    if (!status || status.request_id !== requestId) continue
    onProgress?.(status)
    if (status.state === 'ready') return status
    if (status.state === 'error') {
      throw new Error(status.message || 'News could not prepare the listening model.')
    }
  }
  throw new Error('Listening setup took too long. Please try again.')
}

async function fetchAsset(asset, url, token, signal, onBytes, completedStoredBytes) {
  const response = await fetch(url, {
    headers: authHeaders(token),
    cache: 'force-cache',
    signal,
  })
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('The speech model is not prepared. Save Listening in Settings to set it up.')
    }
    throw new Error(`The speech model could not be loaded (HTTP ${response.status}).`)
  }

  if (!response.body) {
    throw new Error('This browser cannot stream the local speech model.')
  }

  let transferred = 0
  const countingStream = new TransformStream({
    transform(chunk, controller) {
      transferred += chunk.length
      onBytes?.(completedStoredBytes + transferred)
      controller.enqueue(chunk)
    },
  })
  let body = response.body.pipeThrough(countingStream)
  if (asset.compression === 'gzip') {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot unpack the local speech model. Update the browser and try again.')
    }
    body = body.pipeThrough(new DecompressionStream('gzip'))
  }

  const output = new Uint8Array(asset.bytes)
  const reader = body.getReader()
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.length > output.length) {
        throw new Error('A speech model file was larger than expected. Please update News.')
      }
      output.set(value, offset)
      offset += value.length
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== asset.bytes) {
    throw new Error('A speech model file was incomplete. Run Listening setup again.')
  }
  return output
}

export async function loadTtsModelAssets(appId, token, { signal, onProgress } = {}) {
  const urls = ttsModelAssetUrls(appId)
  let completed = 0
  const reportBytes = (bytes) => {
    const percent = Math.max(1, Math.min(88, Math.round(bytes / TTS_MODEL_PACK_STORED_BYTES * 88)))
    onProgress?.(percent)
  }
  const tokenizer = await fetchAsset(
    TTS_MODEL_PACK.tokenizer, urls.tokenizer, token, signal, reportBytes, completed,
  )
  completed += TTS_MODEL_PACK.tokenizer.storedBytes
  const voice = await fetchAsset(
    TTS_MODEL_PACK.voice, urls.voice, token, signal, reportBytes, completed,
  )
  completed += TTS_MODEL_PACK.voice.storedBytes
  const model = await fetchAsset(
    TTS_MODEL_PACK.model, urls.model, token, signal, reportBytes, completed,
  )
  return { tokenizer, voice, model }
}
