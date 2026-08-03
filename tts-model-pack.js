// Pocket TTS is a device-only News feature. The trusted Möbius shell keeps
// these public, checksum-pinned chunks in this browser; neither News's opaque
// frame nor the server becomes a second store for the model.

export const TTS_DEVICE_ASSET_CAPABILITY = 'device.asset-cache'

const PAGES_REVISION = '8ae65694efd3658de4cfdbef5fc8aca833248d1c'
const MODEL_REVISION = 'c2d23606a738c5afb5e24e44f9d2f5d6af1b4528'
const VOICE_REVISION = 'e041936c75475d350b405bc870bcf7c22da4e9e6'

const RUNTIME_MODULE_ASSET = Object.freeze({
  id: 'runtime-module',
  url: `https://raw.githubusercontent.com/LaurentMazare/LaurentMazare.github.io/${PAGES_REVISION}/pocket-tts/ptts_wasm.js`,
  bytes: 12_706,
  chunks: [{ bytes: 12_706, sha256: 'd2848ed21ccd4b46cf38e0659f85867bc30c8631305de5fd220f0295185c7c61' }],
})

export const TTS_MODEL_PACKAGE = Object.freeze({
  key: 'pocket-tts-alba-xn-q8-worker-v1',
  assets: [
    RUNTIME_MODULE_ASSET,
    {
      id: 'runtime-wasm',
      url: `https://raw.githubusercontent.com/LaurentMazare/LaurentMazare.github.io/${PAGES_REVISION}/pocket-tts/ptts_wasm_bg.wasm`,
      bytes: 952_895,
      chunks: [{ bytes: 952_895, sha256: '809e783f77a62698dbbb2bad9f49ea02212a21732047b4880481d9f7b4c70e78' }],
    },
    {
      id: 'tokenizer',
      url: `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${VOICE_REVISION}/tokenizer.model`,
      bytes: 59_339,
      chunks: [{ bytes: 59_339, sha256: 'd461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6' }],
    },
    {
      id: 'model',
      url: `https://huggingface.co/lmz/pocket-tts-without-voice-cloning-q8/resolve/${MODEL_REVISION}/tts_b6369a24.gguf`,
      bytes: 146_499_264,
      chunks: [
        ['009adf6a2b4dacc3c383af3c05d2e77e6359f0b6fb06171e642d0494a86d6ed7'],
        ['230fa3d9d28b2d0272adce5ee060ed883c8a7e4a770909186510be5ccf663220'],
        ['9f63df60a54b62a26faa2ffd21551d12df3a7d7c4c79d7fefb86826f48de2e6f'],
        ['4e6918f80cb4ec163d4aec1fd60e9a85cdfcb17cf822d1efa1682c1ef3d1491e'],
        ['84ff405d48429f5c65f649a942ba8669f2d4807fae44274fa138c7b7e1d8bcc3'],
        ['a0dae791d5ce79316d5b5ed74c39d127b2f4bc9a2ff6b23764ddb5d42bc02b0e'],
        ['174ecfbdef86c6939ea4ad7e0d04d1e6c0fae4e8644784cbd7b74e550cd7e799'],
        ['9be2a47dafe17b99cd0ecd810a43893d9981705d83e98475b4375f8845fcc346'],
        ['5d096efec1610ba2551e93dd6c25188f03b8cf100b1502aa04192e8646901b7a'],
        ['f38fe6215d970d5ad0ee115cf882821d89704cf5e58e98a16c071abfe0f1489b'],
        ['57195622c757c30c6a3700579f5eb372227a998c692e7ce73f7dc0f55e1b396c'],
        ['e8cdfa3cd19d167f497bff7ecec435b215b074b376210d360a6f813c0796cfe7'],
        ['12d20c6e2a6471bd0372b7ecbf2d8169c32f43303339a3e603fd123383290a12'],
        ['58552fff3dec2f500b5befe4393c8ac746781b794b33c907310211004e68415f'],
        ['1c0e09cf240a000b9a12ff1cda9af5873e558b7c7ba2c99507c67b83a676b536'],
        ['c1bd1813c202adaab6791326c5234ee25feb340a42be517c3278b391b7ec6236'],
        ['57c0e10e53b737fb8bfddb25367820bfbaf9f80dc684f32c5a76e3a3e1aff647'],
        ['f05a31260759633313b395c2e5634e4b0d547382f5b417788c772c9ac8ba31a1', 3_892_928],
      ].map(([sha256, bytes = 8_388_608]) => ({ bytes, sha256 })),
    },
    {
      id: 'voice',
      url: `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${VOICE_REVISION}/embeddings_v2/alba.safetensors`,
      bytes: 6_148_328,
      chunks: [{ bytes: 6_148_328, sha256: '413fc94e6bd73e1b6f25e850b25652f5163e41d92a403954f86cbbedd0c414d1' }],
    },
  ],
})

export const TTS_MODEL_PACK = Object.freeze({
  tokenizer: { bytes: 59_339, storedBytes: 59_339 },
  voice: { bytes: 6_148_328, storedBytes: 6_148_328 },
  model: { bytes: 146_499_264, storedBytes: 146_499_264 },
  runtime: { bytes: 965_601, storedBytes: 965_601 },
})

export const TTS_MODEL_PACK_BYTES = TTS_MODEL_PACKAGE.assets
  .reduce((total, asset) => total + asset.bytes, 0)
export const TTS_MODEL_PACK_STORED_BYTES = TTS_MODEL_PACK_BYTES

function capabilityApi() {
  const capabilities = globalThis.window?.mobius?.capabilities || globalThis.mobius?.capabilities
  if (!capabilities?.available?.(TTS_DEVICE_ASSET_CAPABILITY, 1)) {
    throw new Error('This version of Möbius cannot keep the listening model on this device yet.')
  }
  return capabilities
}

function openPackage(operation, pkg = TTS_MODEL_PACKAGE) {
  return capabilityApi().open(TTS_DEVICE_ASSET_CAPABILITY, { operation, package: pkg })
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
  return {
    state: result?.state || 'missing',
    progress: result?.state === 'ready' ? 100 : Math.max(0, Math.min(99, Math.round(saved / total * 100))),
    bytes: saved,
    total_bytes: total,
    storage_bytes: TTS_MODEL_PACK_STORED_BYTES,
    persistence: result?.persistence || 'best-effort',
    device_cached: result?.state === 'ready',
    message: result?.state === 'ready' ? readyMessage(result) : '',
  }
}

export async function readTtsModelPackStatus(signal) {
  try {
    const session = openPackage('status')
    const unbind = bindAbort(session, signal)
    try { return statusFrom(await session.result) } finally { unbind() }
  } catch (error) {
    if (error?.name === 'AbortError') throw error
    return { state: 'unavailable', progress: 0, message: error?.message || 'Listening storage is unavailable.' }
  }
}

export function presentTtsModelPackStatus(status) {
  return status?.state === 'ready' ? { ...status, progress: 100 } : (status || { state: 'idle', progress: 0, message: '' })
}

// Removal is package-key scoped. The capability still validates a complete
// descriptor, so the current pinned runtime asset is reused as an inert
// descriptor while deleting obsolete package prefixes.
async function removeLegacyDevicePack(key) {
  try {
    const session = openPackage('remove', { key, assets: [RUNTIME_MODULE_ASSET] })
    await session.result
  } catch {}
}

async function removeLegacyServerPack(appId, token) {
  if (!appId || !token) return
  const names = ['tokenizer.model', 'alba.safetensors', 'model.safetensors', 'model.safetensors.gz', 'status.json', 'install-request.json']
  await Promise.allSettled(names.map((name) => fetch(
    `/api/storage/apps/${appId}/tts/${name}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  )))
}

export async function prepareTtsModelPack(appId, token, { signal, onProgress } = {}) {
  // The old ONNX preview plus the old JAX pack can exceed News's reviewed
  // device-storage budget when combined with XN. Remove ONNX first, preserve
  // the working JAX copy during the new download, then remove JAX only after
  // the XN package is complete.
  await removeLegacyDevicePack('pocket-tts-alba-onnx-int8-worker-v1')
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
    const status = statusFrom(await session.result)
    onProgress?.(status)
    await Promise.allSettled([
      removeLegacyDevicePack('pocket-tts-alba-jax-fp16-v1'),
      removeLegacyServerPack(appId, token),
    ])
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
    transferred += value?.bytes?.byteLength || 0
    onProgress?.(Math.max(1, Math.min(96, Math.round(
      transferred / TTS_MODEL_PACK_STORED_BYTES * 96,
    ))))
    Promise.resolve(onChunk(value))
      .then(() => session.control('next'))
      .catch((error) => { consumerError = error; session.cancel() })
  })
  try {
    await session.ready
    const result = await session.result
    if (consumerError) throw consumerError
    return statusFrom(result)
  } finally {
    unsubscribe()
    unbind()
  }
}
