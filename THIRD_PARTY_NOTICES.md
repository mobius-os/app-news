# Third-party notices

## Pocket TTS browser pilot

News's optional browser player adapts the Pocket TTS demo from `jax-js` at
commit `2340e61bacee574172f7c44653fae0f21d1da46f` and bundles these MIT-licensed
packages inside the app:

- `@jax-js/jax` 0.1.20
- `@jax-js/loaders` 0.1.2
- `@bufbuild/protobuf` 2.10.2
- `sentencepiece-buf` 0.2.1-0

Upstream: <https://github.com/ekzhang/jax-js>

The browser runtime prefers WebGPU with fp16 weights and falls back to the
jax-js Wasm backend with float32 weights. It is a community browser path, not
an officially supported Kyutai browser distribution.

The fp16 model weights are fetched only after the owner explicitly selects
**Download now** for Listening. They come from
`ekzhang/jax-js-models` at commit
`90ca1cf21ddd4d3daef539d4c90104f727b71169`. The tokenizer and Alba voice are
fetched from Kyutai's `pocket-tts-without-voice-cloning` repository at commit
`fbf8280`.

- Official Pocket TTS: <https://github.com/kyutai-labs/pocket-tts>
- Official model: <https://huggingface.co/kyutai/pocket-tts-without-voice-cloning>
- jax-js model conversion: <https://huggingface.co/ekzhang/jax-js-models>

The converted fp16 model is redistributed, with attribution, as a deterministic
gzip asset in the `app-news` GitHub Release `tts-assets-v1`. Listening setup
downloads and verifies that pinned asset; the final pack occupies about 186 MB
in News's own app storage. The reader stream-decompresses it for browser-side
inference. No PyTorch or scientific runtime is installed on the News server.
