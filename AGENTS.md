# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- The repository uses npm workspaces; run `npm test` and `npm run build` from the root for the complete server/client validation.
- Treat `docs/deployment.md` as authoritative for Google Identity Services environment/origin setup and one-off database migrations.
- Conversation switching, stale-stream isolation, and the one authoritative chat-generation quota are behaviorally pinned in `client/src/stores/chatStore*.test.ts` and `server/src/middleware/auth.test.ts`.
- Immersive voice keeps browser recognition as its free path, but Brave's runtime `'network'` error falls back through `client/src/utils/voiceCapture.ts` to the authenticated, bounded `/api/transcriptions` endpoint. That optional path requires `OPENAI_API_KEY`, sends audio to OpenAI, and can incur usage charges; limits/privacy are authoritative in `docs/deployment.md` and guarded by the transcription route/tests.
- A flex child with `flex-1 overflow-y-auto` (e.g. `ChatWindow.tsx`'s transcript) also needs `min-h-0`, or it refuses to shrink below its content height and the scroll silently never clips — a classic flexbox trap. `ChatWindow.test.tsx`'s "scrollable history" suite guards this by compiling the project's real Tailwind utilities and asserting on `getComputedStyle` (not class-name substrings), since jsdom has no layout engine of its own.
- `personaStore.fetchPersonas()` is the only way `personas` (as opposed to `archetypes`) gets populated outside of opening/switching a conversation; `SwitchPersonaPage.tsx` calls it explicitly. Persona creation is intentionally disabled without deleting stored persona data.
- Production SPA refreshes depend on `vercel.json`'s final catch-all rewrite to `/index.html`; keep the `/api` and `/avatars` proxy rules before it so auth restoration owns protected-route redirects.
- `server/src/services/llmService.ts` tries Gemini then OpenRouter, each over its own env-configurable model list (`server/src/config/index.ts`). OpenRouter has no catch-all free-router alias (`openrouter/free` is not a real model id) — each free model needs its own `:free` id; verify current ones against `GET https://openrouter.ai/api/v1/models` before changing defaults, not the docs pages alone (LLM summarizers can invent plausible-looking free model names).
- Voice-reply (TTS) playback is driven by `chatStore.ts`'s SSE `'token'` handler calling `speechText.ts`'s `takeSpeech`, which by default batches two sentences before flushing to the audio queue (for prosody continuity). Pass `minUtterances: 1` for a reply's first chunk when latency to first audio matters more than prosody — see `ttsHasSpokenFirstChunk` in `chatStore.ts`.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
