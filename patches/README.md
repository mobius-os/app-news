# Rebuilding the embedded XN browser runtime

The generated `browser-tts-xn-module.js` and `browser-tts-xn-wasm-*.js` files
come from `LaurentMazare/xn-ptts`
commit `4398678425e1b3d48d525024257830aec989bc58` and its locked `xn` 0.1.21
dependency.

1. Build with Rust 1.97.1 and `wasm-pack` 0.13.1.
2. In `.cargo/config.toml`, use `target-feature=+simd128` for
   `wasm32-unknown-unknown` (remove `+relaxed-simd`).
3. Vendor `xn` 0.1.21, apply `xn-ptts-baseline-simd.patch`, and select the
   vendored crate with Cargo's `[patch.crates-io]` table.
4. Run `wasm-pack build --target web --release`, then:
   `wasm-opt -Oz --enable-simd ptts_wasm_bg.wasm -o ptts_wasm_bg.baseline.wasm`.
5. Confirm `wasm-validate ptts_wasm_bg.baseline.wasm` succeeds without enabling
   Relaxed SIMD.
6. Run `node scripts/embed-xn-runtime.mjs <ptts_wasm.js> <baseline.wasm>` and
   `npm run build:tts-worker`. The embed step splits the Wasm across two source
   files so each remains below Möbius's per-file app limit.
7. Re-audit the locked `wasm32-unknown-unknown` Cargo dependency graph and
   regenerate `licenses/XN-RUNTIME-LICENSES.md` from every packaged license,
   copying workspace-level notices from their pinned source revisions.

The embed script accepts only the reviewed Wasm SHA-256 recorded in
`THIRD_PARTY_NOTICES.md`; it fails rather than blessing different input.
