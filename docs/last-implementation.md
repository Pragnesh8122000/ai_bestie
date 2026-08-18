# Last Implementation

> This file is overwritten (not appended to) every time a change is made in
> this repo. It always describes only the **most recent** implementation, as
> a fast way to see "what just changed and why" without digging through git
> log or diffs. For full history, use `git log`.

**Date:** 2026-08-18
**What:** Upgraded neural TTS from Kokoro v0_19 to Kokoro v1.0 multi-lang, and fixed sentence-batching so replies sound less robotic.

## Why

The AI's voice sounded flat/robotic. Root causes:
1. `kokoro-en-v0_19` (11 speakers) is Kokoro's oldest, least expressive release.
2. The client flushed **one sentence at a time** to `/api/tts`; each request resets Kokoro's intonation, so multi-sentence replies sounded choppy — a full stop where every sentence starts flat.
3. Speed was pinned at `1.0` with no override.

Considered `pocket-tts` (Kyutai) — rejected for now because it's Python/PyTorch and would need a sidecar process, conflicting with the app's single-process, no-sidecar Render free-tier design. Confirmed the installed `sherpa-onnx-node@1.13.4` already has native PocketTTS (`OfflineTtsPocketModelConfig`) support if we want it later — no version bump needed, just model files.

## What changed

- **`server/src/config/index.ts`** — new `TTS_MODEL_VERSION` (`v1_0` default / `v0_19` legacy), `TTS_SPEED` (default `0.95`), default model path now `server/.tts-models/kokoro-multi-lang-v1_0`.
- **`server/src/services/ttsService.ts`** — version-aware speaker-id allow-lists (v1.0: English female ids 0-10, 20-23; default sid `3` = af_heart), wired in `lexicon-us-en.txt` (v1.0 pronunciation lexicon), `speed` now reads from config (clamped 0.7-1.3). Tried `maxNumSentences`, reverted: the addon logs it's a no-op for Kokoro models — it always treats the request text as one utterance.
- **`client/src/stores/chatStore.ts`** — the real fix for choppiness: the SSE token handler now holds text until **2 complete sentences** (or ~280 chars) are buffered before calling `speakChunk`, instead of flushing after every single sentence. This is what actually lets Kokoro carry prosody across a sentence boundary.
- **`client/src/utils/speech.ts`** — raised the internal chunk cap 220 → 320 chars so `splitChunks` doesn't re-fragment the 2-sentence batches chatStore now sends.
- **`server/src/types/sherpa-onnx-node.d.ts`** — added optional `lexicon` field to the Kokoro model config type.
- **`server/src/scripts/download-tts-model.ts`** — downloads `kokoro-multi-lang-v1_0.tar.bz2` by default; `TTS_MODEL_VERSION=v0_19` still fetches the legacy model for A/B.
- **`server/src/services/ttsService.test.ts`** — rewritten to cover the sid contract for both model versions plus the new `resolveSpeed()`.
- **`README.md`, `docs/deployment.md`** — updated env var docs, model size (~360 MB), default sid/version.

## How to verify / rollback

- Tests: `npm run test -w server` (13 passing) and `npm run test:client` (10 passing).
- Manual synthesis smoke test (real model, real addon): ran `initTts()` + `synthesize()` directly, produced a valid 204 KB WAV at 24kHz — confirmed the v1.0 model loads and speaks with sid 3 (af_heart) and speed 0.95.
- Rollback to old voice without a code change: set `TTS_MODEL_VERSION=v0_19` (and download it via `TTS_MODEL_VERSION=v0_19 npm run download-tts-model -w server`).
- Listen: start the server, toggle voice replies on in the chat header.

## Follow-ups (not done)

- Consider PocketTTS via sherpa-onnx (already supported by the installed addon) for even more natural/streamed voice + cloning, if v1.0 still isn't satisfying.
- Lint is currently broken repo-wide (`eslint.config.js` missing after the ESLint 9 migration) — pre-existing, unrelated to this change, not fixed here.
