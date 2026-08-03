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

The browser runtime uses jax-js WebGPU with fp16 weights. News does not attempt
the jax-js Wasm backend because converting this model to float32 can use too
much working memory for a phone-first reader. It is a community browser path,
not an officially supported Kyutai browser distribution.

The fp16 model weights are fetched only after the owner explicitly selects
**Download on this device** for Listening. They come from
`ekzhang/jax-js-models` at commit
`90ca1cf21ddd4d3daef539d4c90104f727b71169`. The tokenizer and Alba voice are
fetched from Kyutai's `pocket-tts-without-voice-cloning` repository at commit
`fbf82802feb1f92664f3bcf6a0f01295a678853c`.

- Official Pocket TTS: <https://github.com/kyutai-labs/pocket-tts>
- Official model: <https://huggingface.co/kyutai/pocket-tts-without-voice-cloning>
- jax-js model conversion: <https://huggingface.co/ekzhang/jax-js-models>

The Kyutai model, tokenizer, and voice are licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Attribution: **Pocket TTS by Kyutai**. The model card also documents its
intended scope and prohibited uses; read it before deploying the model beyond
News's private reader.

This redistributed derivative was converted to fp16 for jax-js by Eric Zhang,
then repacked without weight changes as a deterministic gzip asset by Möbius
News. It is hosted in the `app-news` GitHub Release `tts-assets-v1`; those
modifications are not endorsed by Kyutai. Listening verifies every bounded
chunk before keeping the roughly 186 MB package in the current browser only.
The server relays cross-origin byte ranges transiently and retains 0 MB. The
reader stream-decompresses and hydrates the model inside a Web Worker for
browser-side inference. No PyTorch or scientific runtime is installed on the
News server.
