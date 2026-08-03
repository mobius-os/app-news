# Third-party notices

## Pocket TTS XN Q8 browser reader

News's optional browser player uses the XN Pocket TTS implementation from
[`LaurentMazare/xn-ptts`](https://github.com/LaurentMazare/xn-ptts) at commit
`4398678425e1b3d48d525024257830aec989bc58`. XN is dual licensed under MIT or
Apache-2.0. The browser-ready Wasm-bindgen JavaScript and WebAssembly files are
pinned from `LaurentMazare/LaurentMazare.github.io` at commit
`8ae65694efd3658de4cfdbef5fc8aca833248d1c`.

The Q8 model is pinned from `lmz/pocket-tts-without-voice-cloning-q8` at commit
`c2d23606a738c5afb5e24e44f9d2f5d6af1b4528`. It is a community quantization by
Laurent Mazare of Kyutai's Pocket TTS model and is not endorsed by Kyutai. The
tokenizer and Alba v2 voice are pinned from Kyutai's
`pocket-tts-without-voice-cloning` repository at commit
`e041936c75475d350b405bc870bcf7c22da4e9e6`.

- Official Pocket TTS: <https://github.com/kyutai-labs/pocket-tts>
- Official model: <https://huggingface.co/kyutai/pocket-tts-without-voice-cloning>
- Q8 model: <https://huggingface.co/lmz/pocket-tts-without-voice-cloning-q8>

The Kyutai model, tokenizer, and voice are licensed under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/).
Attribution: **Pocket TTS by Kyutai**. The model card also documents its
intended scope and prohibited uses; read it before deploying the model beyond
News's private reader.

Listening verifies every bounded chunk before keeping the approximately 154 MB
package in the current browser only. The server relays cross-origin byte ranges
transiently and retains 0 MB. The reader opens and runs the Q8 model in a
dedicated WebAssembly worker. No PyTorch or scientific runtime is installed on
the News server, and no generated audio is retained.
