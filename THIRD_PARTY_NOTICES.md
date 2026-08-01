# Third-party notices

## Pocket TTS browser pilot

News's optional browser player adapts the WebAssembly runtime and JavaScript
worker from Laurent Mazare's `xn-ptts` project at commit
`4398678425e1b3d48d525024257830aec989bc58`.

- Upstream: <https://github.com/LaurentMazare/xn-ptts>
- License: MIT OR Apache-2.0
- Adapted wasm-bindgen JavaScript SHA-256:
  `83a2ffa5113d015638eb0046cb5cdd57a3266fd318c97a313e45ee6b5a7771dc`
- Embedded WebAssembly SHA-256:
  `bbeb3e3c7e6857880b0a8ef3d7d5e2b4bd565a468526fbb248444fff970a65dd`

The optional q8 model weights are fetched on first use from
`lmz/pocket-tts-without-voice-cloning-q8` at commit
`c2d23606a738c5afb5e24e44f9d2f5d6af1b4528`. The tokenizer and Alba voice are
fetched from Kyutai's official `pocket-tts-without-voice-cloning` repository at
commit `e041936c75475d350b405bc870bcf7c22da4e9e6`.

- Official Pocket TTS: <https://github.com/kyutai-labs/pocket-tts>
- Official model: <https://huggingface.co/kyutai/pocket-tts-without-voice-cloning>
- Compact q8 derivative: <https://huggingface.co/lmz/pocket-tts-without-voice-cloning-q8>

The browser runtime and compact weights are an experimental community path,
not an officially supported Kyutai browser distribution. They are downloaded
only after the reader presses Listen.
