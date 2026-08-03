// Pocket TTS is a device-only News feature. The trusted Möbius shell keeps
// these public, checksum-pinned chunks in this browser; neither News's opaque
// frame nor the server becomes a second store for the model.

export const TTS_MODEL_PACK = Object.freeze({
  tokenizer: { bytes: 59_339, storedBytes: 59_339 },
  voice: { bytes: 512_088, storedBytes: 512_088 },
  model: { bytes: 235_738_516, storedBytes: 185_356_309, compression: 'gzip' },
})

export const TTS_MODEL_PACK_BYTES = Object.values(TTS_MODEL_PACK)
  .reduce((total, asset) => total + asset.bytes, 0)

export const TTS_MODEL_PACK_STORED_BYTES = Object.values(TTS_MODEL_PACK)
  .reduce((total, asset) => total + asset.storedBytes, 0)

export const TTS_DEVICE_ASSET_CAPABILITY = 'device.asset-cache'

const MODEL_CHUNKS = [
  [8_388_608, '02462ab48d3c60df4abeb9a26bc9e214cad16eec6e2f16b3501e7a704db533fe'],
  [8_388_608, '75cb5c220566d5c51431e74ad5a3334a2cdaeb94fa8dbf91fcdc16ed569eb6b4'],
  [8_388_608, 'c8157722eaa99b93f07eaa867dda898ff39b80b73999b8e01c3ec62830058c82'],
  [8_388_608, '1f580fd01ee55ea46589e028894269f97f527471fab4752d7d8287ec9b9db653'],
  [8_388_608, '0669e65e93cde6909443bfe265bad214dfe0185e9dcf69b1a873d085e9b4dcda'],
  [8_388_608, '2783dfbc5f3cf09b71920c55f962dfd5174fbea4d6a64707c75ad89cd60a0c18'],
  [8_388_608, 'eb99dd4fa310bbe2f2ac8a999bde5508ea589051a7e878743685d7513aac4795'],
  [8_388_608, 'e552530f48f9105d98d23fcb1d7cb3a839c54cf5788400298c158c5cadefa525'],
  [8_388_608, '46c82fe7d3d29bab73fb231f8b86a1e26281d22421b5569d0d1fa8b1918d44f2'],
  [8_388_608, '5d2601259c761abc3f5a9baf04c25681e285a79b3a373b618bbc2b0041ff6e99'],
  [8_388_608, '4beaf1e98b3f3fbe49eff5ec3db82e828ad6374b42c4ebba305829011deff897'],
  [8_388_608, 'd3ef16fcd01e89edbe2aa1a1e53098979d71f1aad45297be68b9eb5de81ac0d4'],
  [8_388_608, '6f0e6a9c9b592d81afe50a2d1d3551396af6220a206d3396b8c68e593aa0daa8'],
  [8_388_608, '660c65b0765d271fa28e476387c2da4bf6fbef0abae4f4766ba4bb8ce6b2b189'],
  [8_388_608, '873aaba1e3dc89a1fbd070e53cdd6cce7c925fed341e855df2736530d9472756'],
  [8_388_608, '099a82749ea2bfa38b3450a06b2218d498a5af9793d06c6d2e79045dcfb79ce3'],
  [8_388_608, '4af9d15358f9807ef7c4f7a11d6362e8e075fa75fa02e85dd37570c8d4e558cb'],
  [8_388_608, 'ae87720cb83b13f44823a9428de0799d4b366710c582af207d80e1e6706c1659'],
  [8_388_608, '3b63e1ef2a06257874fcb827e31bce4eb5433b43f61e28f943788cbdad745c41'],
  [8_388_608, '01a0149b461c85462dffa2253d86b16c18e6356f1244700a8d514eb914d8aa3f'],
  [8_388_608, 'b0a9d70993575525c5278db26c4c08ec02a549b7c3671d55fe3e49a549b8cb77'],
  [8_388_608, '28e803db8278624722a642b8a62e3a29fd6f4a2b2db88b9bbfa68ba5fc2a4522'],
  [806_933, '5317ed7c45906929b17912870b68bd6a4c2f9a9b781b79d7880bf77409f836ad'],
].map(([bytes, sha256]) => ({ bytes, sha256 }))

export const TTS_MODEL_PACKAGE = Object.freeze({
  key: 'pocket-tts-alba-jax-fp16-v1',
  assets: [
    {
      id: 'tokenizer',
      url: 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf82802feb1f92664f3bcf6a0f01295a678853c/tokenizer.model',
      bytes: 59_339,
      chunks: [{
        bytes: 59_339,
        sha256: 'd461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6',
      }],
    },
    {
      id: 'voice',
      url: 'https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/fbf82802feb1f92664f3bcf6a0f01295a678853c/embeddings/alba.safetensors',
      bytes: 512_088,
      chunks: [{
        bytes: 512_088,
        sha256: 'ad234695323e4030336b6afc8a050c97e3110603e11ecd8226d9562488300a50',
      }],
    },
    {
      id: 'model',
      url: 'https://github.com/mobius-os/app-news/releases/download/tts-assets-v1/pocket-tts-jax-fp16-90ca1cf-gzip-v1.safetensors.gz',
      bytes: 185_356_309,
      chunks: MODEL_CHUNKS,
    },
  ],
})

function capabilityApi() {
  const capabilities = globalThis.window?.mobius?.capabilities
    || globalThis.mobius?.capabilities
  if (!capabilities?.available?.(TTS_DEVICE_ASSET_CAPABILITY, 1)) {
    throw new Error('This version of Möbius cannot keep the listening model on this device yet.')
  }
  return capabilities
}

function openPackage(operation) {
  return capabilityApi().open(TTS_DEVICE_ASSET_CAPABILITY, {
    operation,
    package: TTS_MODEL_PACKAGE,
  })
}

function bindAbort(session, signal) {
  if (!signal) return () => {}
  if (signal.aborted) session.cancel()
  const cancel = () => session.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  return () => signal.removeEventListener('abort', cancel)
}

function readyMessage(result) {
  return result?.persistence === 'persistent'
    ? 'Listening ready on this device'
    : 'Ready on this device · browser storage is best-effort'
}

function statusFrom(result) {
  const total = Number(result?.totalBytes) || TTS_MODEL_PACK_STORED_BYTES
  const saved = Number(result?.cachedBytes) || 0
  const progress = result?.state === 'ready'
    ? 100
    : Math.max(0, Math.min(99, Math.round(saved / total * 100)))
  return {
    state: result?.state || 'missing',
    progress,
    bytes: saved,
    total_bytes: total,
    storage_bytes: TTS_MODEL_PACK_STORED_BYTES,
    persistence: result?.persistence || 'best-effort',
    device_cached: result?.state === 'ready',
    message: result?.state === 'ready' ? readyMessage(result) : '',
  }
}

export async function readTtsModelPackStatus(signal) {
  let session
  try {
    session = openPackage('status')
    const unbind = bindAbort(session, signal)
    try { return statusFrom(await session.result) } finally { unbind() }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return {
      state: 'unavailable',
      progress: 0,
      message: error?.message || 'Listening storage is unavailable in this browser.',
    }
  }
}

export function presentTtsModelPackStatus(status) {
  if (!status) return { state: 'idle', progress: 0, message: '' }
  if (status.state === 'ready') return { ...status, progress: 100 }
  return status
}

async function removeLegacyServerPack(appId, token) {
  if (!appId || !token) return
  const names = [
    'tokenizer.model',
    'alba.safetensors',
    'model.safetensors',
    'model.safetensors.gz',
    'status.json',
    'install-request.json',
  ]
  await Promise.allSettled(names.map((name) => fetch(
    `/api/storage/apps/${appId}/tts/${name}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )))
}

export async function prepareTtsModelPack(appId, token, { signal, onProgress } = {}) {
  const session = openPackage('install')
  const unbind = bindAbort(session, signal)
  const unsubscribe = session.on('progress', (value) => {
    const downloaded = Number(value?.downloadedBytes) || 0
    const total = Number(value?.totalBytes) || TTS_MODEL_PACK_STORED_BYTES
    onProgress?.({
      state: 'preparing',
      progress: Math.max(1, Math.min(99, Math.round(downloaded / total * 100))),
      bytes: downloaded,
      total_bytes: total,
      message: 'Downloading and verifying on this device…',
    })
  })
  onProgress?.({ state: 'preparing', progress: 0, message: 'Checking this device…' })
  try {
    const result = await session.result
    const status = statusFrom(result)
    onProgress?.(status)
    // Old versions cached the same regenerable pack on the server. Delete it
    // only after the browser package is complete, preserving a safe migration.
    await removeLegacyServerPack(appId, token)
    return status
  } finally {
    unsubscribe()
    unbind()
  }
}

export async function streamTtsModelPack({ signal, onChunk, onProgress } = {}) {
  if (typeof onChunk !== 'function') throw new TypeError('A model chunk consumer is required.')
  const session = openPackage('read')
  const unbind = bindAbort(session, signal)
  let consumerError = null
  let transferred = 0
  const unsubscribe = session.on('chunk', (value) => {
    const chunkBytes = value?.bytes?.byteLength || 0
    Promise.resolve()
      .then(() => onChunk(value))
      .then(() => {
        transferred += chunkBytes
        onProgress?.(Math.max(1, Math.min(88, Math.round(
          transferred / TTS_MODEL_PACK_STORED_BYTES * 88,
        ))))
        session.control('next')
      })
      .catch((error) => {
        consumerError = error
        session.cancel()
      })
  })
  try {
    const result = await session.result
    if (consumerError) throw consumerError
    return statusFrom(result)
  } finally {
    unsubscribe()
    unbind()
  }
}
