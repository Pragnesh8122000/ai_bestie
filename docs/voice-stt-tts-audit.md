# Voice audit: speech-to-text and text-to-speech

Snapshot: `main @ dc671a0` plus the working-tree changes described here · 2026-09-26.
Companion document: `docs/voice-tts-changes.pdf` explains each code change with diagrams.

This audit covers the whole voice path. It lists the defects found, what was fixed, what is still
open, the best practices behind each decision (with sources), and the alternatives that were
considered but not adopted. Every number here was measured on this repository, unless the text
says otherwise.

---

## 1. Method

1. Read the whole pipeline: `ImmersiveVoiceMode.tsx`, `voiceCapture.ts`, `speech.ts`,
   `speechText.ts`, `chatStore.ts`, `routes/tts.ts`, `ttsService.ts`, `routes/transcriptions.ts`,
   `transcriptionService.ts`, `chatService.ts`, `Persona.ts`, config and deployment docs.
2. Measured the real Kokoro model in-process (sherpa-onnx-node 1.13.4, `kokoro-multi-lang-v1_0`,
   CPU): load time, memory, cold vs. warm inference, real-time factor (RTF, inference time divided
   by audio length) at 1, 2 and 4 threads, event-loop lag during inference, and parallel requests
   on one instance.
3. Measured how the model reads problem text (emoji, URLs, currency, dates, abbreviations) by
   comparing audio length against a normalized version of the same sentence.
4. Built a repeatable benchmark, `npm run bench-tts -w server`. It streams representative replies
   through the real client chunker, synthesizes every chunk with the real model, and places the
   results on a timeline to report time to first audio (TTFA) and silence between chunks.
5. Swept the chunking parameters over six replies at three inference speeds (0.4×, 0.62× and
   0.85× real time) and chose the values from that data.
6. Verified end to end against a live server: 3 sequential chunks, a burst of 12 concurrent
   requests, and client disconnects. The existing `verify-voice.mts` integration check was run in
   all 3 failure modes. The Web Audio playback path was run in real headless Chromium against the
   live server.
7. Used **laya** (local classifier) as asked. The outcome is in §10.

### Environment and caveats

- Apple M5 (10 cores), Node 24.18. The machine was shared with other workloads during parts of
  the run. Load average went from about 2 to 7.6, which roughly halved single-thread throughput
  (RTF 0.62 when idle, 1.17 under load). The benchmark therefore takes the best of 3 runs and fits
  a model, so every strategy is compared under the same conditions.
- Production runs on Render (Linux, fractional CPU, 512 MB on the free tier). That hardware was
  not available, so its numbers are estimates and are labelled as such.
- Nothing was listened to. No audio output was available, so voice quality claims rest on audio
  length, published voice grades and code inspection, not on listening tests.

---

## 2. How voice works today (after this change)

```
User speaks
  └─ ImmersiveVoiceMode → voiceCapture.startVoiceTurn()
       ├─ browser SpeechRecognition (listenOnce, free)                 ── transcript
       └─ on Brave 'network' error: recorded clip → POST /api/transcriptions → OpenAI whisper-1 (paid)
chatStore.sendMessage(transcript, {voiceMode})
  └─ POST …/messages/stream (SSE) → chatService → Persona prompt (+VOICE MODE layer) → Gemini/OpenRouter
       tokens ─► SpeechChunker (client)      sizes chunks so each is synthesized while the previous plays
                   └─ tts.speakChunk()       queue: prefetch depth 2, abortable fetch, 35 s timeout, 1 safe retry
                        └─ POST /api/tts ─► ttsQueue (bounded) ─► Kokoro (sherpa-onnx, in-process) ─► WAV
                   ◄─ WAV ─ decodeAudioData ─► audioPlayer: one AudioContext, back-to-back scheduling
                        fallbacks: <audio> element (context locked) · browser speechSynthesis (server down)
```

---

## 3. Measurements

### 3.1 Kokoro model (sherpa-onnx, CPU, `af_heart`, speed 0.95)

| Metric | Value |
| --- | --- |
| Model load (`createAsync`) | 0.4–0.9 s (warm OS file cache) |
| Extra resident memory after load | about 600 MB (588–632 MB over 5 runs); process RSS about 940 MB |
| RTF, 1 thread (idle machine) | 0.67 short · 0.61 medium · 0.61 long |
| RTF, 2 threads (idle machine) | 0.44 · 0.39 · 0.38 |
| RTF, 4 threads (idle machine) | 0.43 · 0.36 · 0.30 |
| First inference vs. warm, same text | 1092 vs. 960 ms (idle); within noise under load |
| Event-loop lag during `generateAsync` | at most 27 ms, so inference does **not** block Node |
| 2 parallel requests on one instance | both finish in about 3.4 s vs. 3.1 s alone (native threads run in parallel) |
| Built-in silence per chunk | about 65 ms lead-in and 95 ms tail |
| Audio format | 24 kHz mono 16-bit PCM WAV, sent as binary (no base64) |

### 3.2 Text the voice reads badly (audio length, raw vs. normalized)

| Input | Raw | Normalized | Verdict |
| --- | --- | --- | --- |
| `I'm here 😊` | 2355 ms | 793 ms | the emoji name is spoken, so **fix** |
| `Check https://example.com/some/long/path?x=1 for details.` | 7218 ms | 1543 ms | the URL is spelled out, so **fix** |
| `Call Dr. Smith.` | 1435 ms | 1238 ms | also split into two chunks mid-sentence, so **fix the splitter** |
| `It was 2026-09-26.` | 3892 ms | 2809 ms | read oddly, but rare in chat, so left alone |
| `It costs $5.` / `3:30pm` / `50%` / `&` / `e.g.` / `Wow!!!` | ≈ equal | — | read correctly already, so **no rewrite** |
| `मुझे बहुत अच्छा लगा` (Hindi) on the English voice | 1575 ms | — | could not be judged by ear; Kokoro's Hindi voices are grade C |

### 3.3 Streaming pipeline (`npm run bench-tts -w server`, averages over 6 replies)

The timeline assumes: LLM first token 700 ms, 250 characters per second, 80 ms round trip,
20 Mbit/s download. Inference time comes from a fit to the best of 3 measurements in the same run,
so every strategy faces the same machine load.

| Strategy | Inference speed | TTFA | Silence per reply | Worst single gap |
| --- | --- | --- | --- | --- |
| Whole reply at once | 0.65× | 8419 ms | 0 | 0 |
| **Before**: 1 sentence, then 2 at a time, `<audio>`, prefetch 1 | 0.65× | 2634 ms | 2384 ms | 4751 ms |
| Old chunks + new playback (Web Audio, prefetch 2) | 0.65× | 2599 ms | 1979 ms | 4602 ms |
| **After**: SpeechChunker + Web Audio + prefetch 2 | 0.65× | **1693 ms** | **400 ms** | **1607 ms** |
| Before | 1.17× (overloaded) | 4035 ms | 5148 ms | 9573 ms |
| After | 1.17× (overloaded) | 2462 ms | 4349 ms | 4160 ms |

Per reply at 0.65×, TTFA is equal or better on every reply (the long reply goes from 7.96 s to
2.49 s), and silence between chunks drops on every reply (for example "Oh no!…" goes from 2.8 s to
0.43 s). The sweep also tried alternatives at 0.62×:

| Chunking option | TTFA | Silence per reply |
| --- | --- | --- |
| Before (legacy) | 2676 ms | 2096 ms |
| **Chosen**: merge only 1-word openers, first chunk ≤ 80 characters, growth ×1.6, minimum 60 | **1774 ms** | 438 ms |
| Hold the first chunk to ≥ 5 words | 2369 ms | 310 ms |
| "15-word minimum chunk" guideline | 4637 ms | 3 ms |

Result at a typical 0.65×: **TTFA −36%, silence between chunks −83%, worst gap −66%.** When the
host synthesizes slower than real time (1.17×), TTFA and the worst gap still improve (−39%, −57%),
but total silence can't be removed. The long reply is split into more chunks, so the unavoidable
wait is spread over more boundaries. That is a hardware limit (§8). The trade-off of smaller
chunks is more boundaries where the intonation resets. Each chunk is still a whole sentence or
clause.

### 3.4 Live server and browser checks

- Sequential chunks returned `audio/wav` at 24 kHz. The emoji and URL sentence came back as 2.2 s
  of audio instead of 7–9 s.
- A burst of 12 concurrent requests (queue limit 8) produced 7 × 200, 3 × `503 TTS_BUSY` with
  `Retry-After: 1` sent at once, and 2 × `503 TTS_TIMEOUT` after 10 s. The backlog stayed bounded.
- Two queued requests from a client that disconnected were logged as `cancelled` with 0 ms of
  inference, so they never reached the model. A request that was already running finished, because
  native inference cannot be interrupted (§8).
- The logs contain ids, lengths and timings only. A search of the log for any request text found
  no matches.
- In real headless Chromium, the AudioContext ran at 48 kHz and the 24 kHz WAVs decoded to exact
  durations (1.146 s against the server's 1146 ms). Chunk 3 was scheduled at 5.5604 s, exactly
  where chunk 2 ended (2.26 + 3.3004), so the gap was **0 ms**. Stop halted the playing chunk
  immediately, and no later chunk started.
- `verify-voice.mts` against the live server: PASS in all 3 modes (healthy, first chunk fails,
  middle chunk fails). One voice per reply, no leaked blob URLs.

---

## 4. Defects found

Severity: H = users hit it, M = likely under load or on some browsers, L = quality or observability.

### Text-to-speech

| # | Sev | Defect | Evidence | Status |
| --- | --- | --- | --- | --- |
| T1 | H | Client `/api/tts` fetch had **no timeout and no abort**. One hung request stalled the whole queue: `pumping` stayed true, so later replies stayed silent too. This is the "speech gets stuck" symptom. | Code: `fetchItem` awaited `fetch` without a signal | **Fixed** |
| T2 | H | **Stop and new messages did not cancel synthesis.** In-flight requests kept running, and the server checked abort only before joining its mutex and after inference, so stale chunks were still synthesized ahead of the new reply's first chunk. | Code: `synthesize` / `enqueue` | **Fixed** (client abort, server drops jobs at dequeue) |
| T3 | H | **Chunk sizes caused the pauses.** A tiny first chunk ("Oh no!", 0.7 s) was followed by a two-sentence chunk that took about 3 s to synthesize, leaving roughly 2.8 s of silence. | Benchmark: 2.4 s of silence per reply, 4.8 s worst | **Fixed** (SpeechChunker) |
| T4 | M | One `<audio>` element per chunk. The next chunk started only from the `ended` event, a **new AudioContext was created for every chunk** just for the level meter, and the element was routed through that context, which is silent if it starts suspended under autoplay rules. Nothing watched for a stuck element. | Code: `startPlaybackLevelMeter` | **Fixed** (shared AudioContext, scheduled buffers, watchdogs) |
| T5 | M | Browser-voice fallback utterances ran up to 320 characters (about 20 s). Chrome stops after about 15 s **without firing `onend`**, which left the queue waiting forever. | Chromium issue 41294170 | **Fixed** (at most 200 characters per utterance, plus a watchdog) |
| T6 | M | The server queue was an unbounded promise chain: no maximum depth, no wait timeout, no inference timeout. | Code: `enqueue` | **Fixed** (`ttsQueue.ts`) |
| T7 | M | Emoji were read aloud by name and bare URLs were spelled out. | §3.2 | **Fixed** (client, server and voice prompt) |
| T8 | L | "Dr." and "e.g." ended a sentence, so one sentence became two requests and the intonation reset midway. | Code: `findSentenceEnd` | **Fixed** |
| T9 | L | Threads were hard-coded to 1, leaving cores idle. 2 threads are 37% faster. | §3.1 | **Fixed** (`TTS_NUM_THREADS=auto`, cgroup-aware) |
| T10 | L | No health endpoint and no structured metrics. | — | **Fixed** (`/api/tts/health`, JSON logs) |
| T11 | L | No warm-up, so the first reply paid first-run costs. | 50–130 ms measured | **Fixed** (cheap; the gain is small here) |
| T12 | M | The fp32 Kokoro model needs about 600 MB more RAM, more than the 512 MB of a Render free instance. Production likely falls back to the browser voice or gets killed for running out of memory. | §3.1 | **Open**: hosting decision (§9) |
| T13 | L | The `lang` field was accepted but ignored, so Hindi or Gujarati script went to the English voice. | Code | **Partly fixed** (routed to a device voice when one exists) |
| T14 | L | Stale comments: the service header said v0_19, and the route said the signal "flows into onProgress". | Code | **Fixed** |

### Speech-to-text

| # | Sev | Defect | Evidence | Status |
| --- | --- | --- | --- | --- |
| S1 | H | **The Brave fallback could never succeed.** It recorded for the full 20 s turn cap (raised from 8 s in dc671a0), but the server rejects clips over 12 s with **413 AUDIO_TOO_LONG**. | `DEFAULT_MAX_MS = 20_000` vs. `TRANSCRIPTION_MAX_DURATION_MS = 12000`; git history | **Fixed** (at most 11.5 s) |
| S2 | H | The fallback recorded a **fixed window** (8 s, later 20 s) however early the user stopped talking, so every Brave turn waited out the whole window before the upload. | Code: `wait(maxMs − elapsed)` | **Fixed** (energy-based end of speech, 1.2 s pause) |
| S3 | M | Every turn opens `getUserMedia` and a `MediaRecorder` even when browser recognition works. The mic is captured twice, Opus is encoded for nothing, and on iOS it switches the audio session to play-and-record, which can move TTS to the earpiece. This happens during the barge-in probe while TTS is playing. | Code; field report [6] | **Open**: recommendation R6 |
| S4 | M | Barge-in can be triggered by the persona's own voice through speakers. `SpeechRecognition` does its own capture, so the `getUserMedia` echo cancellation does not apply. | AGENTS.md (known) | **Open**: recommendation R7 |
| S5 | L | Language is fixed: `en-US` recognition and Whisper `language: 'en'`. Hindi speech is not supported. | Code | Open (product decision) |
| S6 | L | The fallback is paid (OpenAI whisper-1). Free options now exist (§9). | — | Open: recommendation R8 |

---

## 5. What was changed (summary; details and diagrams in the PDF)

| Area | Change | Files |
| --- | --- | --- |
| Chunking | `SpeechChunker`: a one-word opener ("Yes!") is merged with the next sentence, and the first chunk is cut at a clause past 80 characters. Later chunks take whole sentences up to 1.6× the previous chunk (minimum 60, maximum 280 characters); a sentence is split at a clause only when it alone exceeds that budget. | `client/src/utils/speechChunker.ts`, `chatStore.ts` |
| Normalization | Drop emoji (including ZWJ sequences, skin tones and flags); reduce bare URLs to the site name; don't split sentences at abbreviations. Currency, times and percentages are left alone, per §3.2. | `speechText.ts`, `server/src/services/ttsText.ts` |
| Playback | One shared AudioContext unlocked on the first gesture. Decoded WAVs are scheduled end to end with one analyser for the orb. A clock-stall watchdog is added. The `<audio>` fallback is used while the context is locked. | `client/src/utils/audioPlayer.ts`, `tts.ts` |
| Queue & cancellation | Prefetch depth 2. An AbortController per request, aborted on stop or a new reply. 35 s timeout. At most one retry, and only for a network `TypeError` or a 503 with `Retry-After`; cancelled requests are never retried. Correlation headers (numbers only). Watchdogs for `<audio>` and utterances. Browser-voice utterances capped at 200 characters. | `tts.ts`, `browserVoice.ts` |
| Language | Detects Devanagari and Gujarati script. Such a chunk goes to a device voice for that language if the device has one; otherwise behaviour is unchanged. | `speechText.ts`, `tts.ts`, `browserVoice.ts` |
| Server queue | Bounded FIFO: concurrency 1, 8 waiting, 10 s wait limit. A job whose client disconnected is dropped before inference. Answers 503 with `Retry-After` when busy. 20 s inference timeout; the slot stays held until the native call returns. | `server/src/services/ttsQueue.ts`, `ttsService.ts`, `routes/tts.ts` |
| Server runtime | `TTS_NUM_THREADS=auto` (cgroup CPU grant, at most 2), warm-up inference, `/api/tts/health`, one JSON log line per chunk (no text), emoji-only input returns silence instead of an error. | `ttsService.ts`, `config/index.ts` |
| Prompt | The voice-mode layer asks for contractions and no emoji, links or code. Text chat is unchanged. | `server/src/models/Persona.ts` |
| STT fallback | The recording stops at end of speech and never exceeds 11.5 s. | `client/src/utils/voiceCapture.ts` |
| Tooling | `npm run bench-tts -w server`: repeatable benchmark. | `server/src/scripts/bench-tts.mts` |

`speech.ts` was split so that no file exceeds 500 lines. `speech.ts` keeps STT and re-exports the
TTS API unchanged, so no caller changed.

---

## 6. Evaluation of each instruction

| Instruction | Outcome |
| --- | --- |
| 1 Load once and warm up | Kokoro was already loaded once at boot. Warm-up added; it is cheap and measured 50–130 ms. |
| 2 Sentence-aware incremental synthesis | Already present (streaming chunks). Improved sizing. |
| 3 Balanced chunks, 20–60 words | **Tested and rejected for this repo.** A 15-word minimum removed gaps but raised TTFA to 4.6 s (vs. 1.8 s chosen, 2.7 s before). Growth-limited sizes won (§3.3). |
| 4 Prefetch 2–3 | Prefetch is now 2 (was 1). Together with Web Audio it cut average silence from 2.38 s to 1.98 s even with the old chunks, and on the long reply from 1.8 s to 0.02 s. |
| 5 One ordered queue, Web Audio | Implemented, and verified gapless in Chromium. |
| 6 Backpressure | Client look-ahead of 2, server queue of 8, then 503 with `Retry-After`. |
| 7 Cancellation | Implemented: AbortController per request, session (generation) ids, server drops jobs at dequeue, late audio ignored. |
| 8 Bounded concurrency, don't block the event loop | Bounded queue added. The event loop was not blocked (≤ 27 ms lag), so no worker thread is needed. |
| 9 Runtime review | Kept Kokoro on ONNX via sherpa-onnx on CPU. PyTorch doesn't apply (Node, no GPU). int8 was rejected before on quality grounds (AGENTS.md) and not re-litigated. CoreML is macOS-only and production is Linux. Only threads were tuned. |
| 10 Binary transport, sample rate | Already binary WAV. Verified 24 kHz preserved and decoded correctly. Compression is a recommendation (R3). |
| 11 Timeouts and fallback | Client 35 s; server 10 s wait and 20 s inference. Existing browser-voice fallback kept. |
| 12 Cache safe audio | **Not implemented.** The app speaks no static phrases, and replies are personal, so a global cache would add risk with no benefit. |
| N1 Voice choice | Kept `af_heart`, Kokoro's only grade-A American female voice (af_bella is A−) [9]. Not A/B'd by ear. |
| N2 Speed 0.92–1.02 | Already 0.95, configurable and clamped. Unchanged. |
| N3 Normalization | Emoji, URLs and abbreviations added. Markdown, lists and code were already handled. Currency, times, % and & measured fine and were deliberately left alone. |
| N4 Keep punctuation | Clause cuts keep their comma. No commas or ellipses are added. |
| N5 Voice-specific prompt | One line added to the VOICE MODE layer only. |
| N6 Blending and phonemes | Not added. No measured mispronunciation to fix, and the addon's lexicon support is already enabled. |
| N7 Languages | Script detection plus device-voice routing. Kokoro cannot fix weak Hindi: its Hindi voices are grade C, and there is no Gujarati. Better engines are in §9. |
| Reliability items | Structured logs without text, health endpoint, retry only when transient, no retry when cancelled, blob URLs revoked, queued jobs dropped on disconnect, bounded memory. All covered by tests. |

---

## 7. Best practices (from research), and how the code follows them

1. **Start audio at the first sentence or clause; make the first chunk smaller than later ones.**
   Sentence-boundary pipelining is the standard way to cut perceived latency, and the first chunk
   exists only to start audio quickly [1][2]. *Applied:* a clause-sized first chunk, then growing
   chunks.
2. **Size later chunks so synthesis keeps ahead of playback.** Chunk N+1 is ready in time only if
   its synthesis takes no longer than chunk N's playback. At a given RTF, each chunk can therefore
   be at most about 1/RTF times longer than the one before. *Applied:* growth ×1.6, tuned by the
   sweep. This is original analysis, confirmed by the benchmark.
3. **Treat punctuation as infrastructure, with a forced split when no boundary comes** [2].
   *Applied:* sentence → clause → word fallback, plus an abbreviation list.
4. **Schedule decoded buffers on one AudioContext with a running `nextStartTime` cursor for
   gapless playback** [3][4]. *Applied:* `audioPlayer.scheduleBuffer`.
5. **Unlock audio in a user gesture and resume a suspended context before speaking.** Chrome
   starts contexts created before a gesture as suspended [5]. iOS needs one unlock and suspends
   between gestures [6][7]. *Applied:* unlock on the first pointer, key or touch; `ensureRunning()`
   before each chunk; fall back to `<audio>`.
6. **Never trust a single `ended`/`onend` event.** Chrome's `speechSynthesis` stops after about
   15 s without `onend` [8]. *Applied:* watchdogs and utterances of at most 200 characters.
7. **Bound every queue and time out every wait; drop work whose requester has gone.** *Applied:*
   client prefetch 2, server queue 8, timeouts, abort at dequeue.
8. **Match ONNX Runtime threads to the container's CPU grant, not the host's cores.** ORT sizes its
   pool from the host, which oversubscribes small CPU quotas [10]. *Applied:* reads cgroup
   `cpu.max`, caps at 2, and uses 1 when the grant is unknown.
9. **Log timings, not content.** *Applied:* one JSON line per chunk with ids, lengths, queue wait,
   inference time, audio length, RTF and error category.
10. **Prefer on-device and free recognition where it is available.** Chrome 139 and later can run
    Web Speech on-device (`processLocally`, `SpeechRecognition.available()` / `install()`) [11].
    *Not applied yet:* R8.

---

## 8. Remaining limitations

- **Running inference cannot be interrupted.** `onProgress` crashes the process in
  sherpa-onnx-node 1.13.x (see the `ttsService.ts` header). A Stop wastes at most one in-progress
  chunk of CPU (≤ 8 s on 1 thread for a 280-character chunk). Queued chunks are dropped.
- **Gaps are unavoidable when the host is slower than real time.** At 1.17× (single thread,
  overloaded) the worst gap is still 4.2 s. More or dedicated CPU is the only fix (R1).
- **Smaller chunks mean more intonation resets.** Short replies are now spoken in 3–5 pieces
  instead of 2–3. Each piece is still a whole sentence or clause.
- **Before the first user gesture**, Web Audio can be locked. Playback then uses `<audio>`, which
  iOS may also block, as before.
- **Server order across parallel connections is not guaranteed.** Two requests fired together can
  reach the queue in either order. Playback order is always correct; only latency is affected.
- **Hinglish** (Hindi in Latin script) cannot be detected and stays on the English voice.
  Devanagari or Gujarati text uses a device voice only if the OS has one.
- Barge-in echo (S4) and double mic capture (S3) remain.
- Voice quality was not judged by ear (§1).
- Client test runs sometimes print jsdom XHR `AggregateError` noise. It also appeared on the
  untouched baseline, all tests pass, and it is unrelated to this change.

---

## 9. Alternatives considered but not implemented

| # | Option | Benefit | Cost / hardware | Effort | Why not now |
| --- | --- | --- | --- | --- | --- |
| R1 | Dedicated TTS host with ≥ 2 vCPU and ≥ 1.5 GB RAM (Render Standard/Pro or a separate service) | Removes the out-of-memory problem (T12). RTF drops to about 0.4 with 2 threads. | Paid plan | S | Needs a hosting and budget decision |
| R2 | Upgrade sherpa-onnx-node 1.13.4 → 1.13.8 and re-test `onProgress` | Stream audio within a chunk, cancel mid-inference, lower TTFA | Free | S–M | The crash was severe; needs a soak test before use |
| R3 | Compress TTS audio (Opus) | WAV is 48 KB/s: a 10 s chunk is 480 KB, about 2 s on a 2 Mbit/s mobile link. Opus is about 3–4 KB/s. | New encoder dependency | M | New dependency; only matters on slow links |
| R4 | Kokoro int8 (132–147 MB) | About half the RAM, fits smaller instances | Free | S | Rejected earlier for quality; needs an A/B by ear |
| R5 | Smaller CPU models: Kyutai Pocket TTS (sherpa `pocket`, 98 MB int8), Kitten nano v0.8 (31 MB int8) | Much less RAM and CPU | Free; check licence | M | Different voice character; untested quality and licence |
| R6 | Record the mic only when the fallback may be needed (or release it before TTS on iOS) | Fixes S3: less CPU, no iOS earpiece routing | Free | M | Risks losing the first words of a Brave fallback; needs device testing |
| R7 | Barge-in filter: require about 2 words or 300 ms of interim speech, and ignore interim text that matches the words currently being spoken | Fewer self-interruptions [6] | Free | S–M | Needs tuning with real speakers and mics |
| R8 | Free STT fallback: Chrome on-device recognition [11], or offline ASR in the sherpa-onnx addon already installed (Whisper or Moonshine models) | Removes paid OpenAI usage and keeps audio private | CPU and RAM on the server for offline ASR | M | New model files and RAM; the Brave on-device path is unverified |
| R9 | Hindi voice: Piper `hi_IN-priyamvada-medium` (female, 21 MB int8, same API) | Real Hindi phonetics | **CC-BY-NC-SA 4.0 (non-commercial)** [12] | M | Licence incompatible with a commercial product |
| R10 | Hindi: Kokoro v1.0 Hindi voices (`hf_alpha`, `hf_beta`) | Same engine | A second model instance (+about 600 MB); **grade C** [9] | M | Poor quality for the cost |
| R11 | Indian languages including Gujarati: AI4Bharat Indic Parler-TTS (20 Indic languages) [13], or Sarvam Bulbul (**paid API, needs credentials**) | Much better Indic speech | Parler: about 0.9B parameters, GPU recommended, separate Python service. Sarvam: per-character billing. | L | Large infrastructure change or paid service; flagged only |
| R12 | Gujarati: `vits-mimic3-gu_IN-cmu-indic_low` (79 MB) | Some Gujarati TTS | Free; check licence | M | "low"-quality model |

---

## 10. Using laya (local classifier)

| Use | Result | Action taken |
| --- | --- | --- |
| Screen fetched web pages for prompt injection (custom yes/no question) | Scored plain technical docs at 0.70–0.95, so false positives | Read the text myself: benign |
| Same screen with the `guard` preset | One page scored 0.11 (clean); a combined excerpt was flagged "jailbreak 1.0" | Unreliable on imperative technical prose; content verified by hand |
| Triage of 23 instruction items by layer and risk | All answers were low-confidence, and most were mislabelled "prompt" | Triaged manually (§6) |
| `log_triage` on 19 test and build log lines | Flagged the jsdom XHR errors as errors | Verified by hand: pre-existing and flaky, also seen on the baseline |

Laya saved no tokens here: every answer needed checking by hand. It is kept in the loop only as a
first pass on bulk logs.

---

## 11. Configuration, deployment and rollback

- **Validation:** server tests 79 → 103 and client tests 228 → 275, all passing. Lint, type-check
  and build are clean. The live-server, Chromium and `verify-voice.mts` checks are in §3.4.
- **Nothing is required.** New optional settings, with defaults: `TTS_NUM_THREADS=auto`,
  `TTS_CONCURRENCY=1`, `TTS_MAX_QUEUE=8`, `TTS_QUEUE_TIMEOUT_MS=10000`,
  `TTS_INFERENCE_TIMEOUT_MS=20000`, `TTS_WARMUP=true` (documented in `docs/deployment.md`).
- To get the thread speed-up, give the service ≥ 2 dedicated vCPUs. To actually run neural TTS in
  production, give it ≥ 1.5 GB RAM (T12).
- Monitor `GET /api/tts/health` (`lastRtf` near or above 1 means the host is too slow) and the
  `evt: "tts.synth"` log lines.
- The local `node_modules` was missing the locked ESLint plugins; `npm install` fixed that and left
  `package-lock.json` unchanged.
- **Rollback.** There is no model or runtime change. Revert the commit to go back to the old
  behaviour. Without a deploy: `TTS_NUM_THREADS=1` restores the old threading and
  `TTS_WARMUP=false` disables warm-up. Setting `TTS_MAX_QUEUE` and `TTS_QUEUE_TIMEOUT_MS` very
  high approximates the old unbounded queue.

---

## Sources

1. sfortis/openai_tts #66: sentence-level pipelining to reduce first-audio latency. https://github.com/sfortis/openai_tts/issues/66
2. The Voice Layer, "Streaming text-to-speech: chunking, prosody, and the time-to-first-audio problem". https://thevoicelayer.com/posts/streaming-text-to-speech-chunking-prosody-and-the-time-to-first-audio-problem
3. Boris Smus, *Web Audio API*, ch. 2 (precise scheduling). https://webaudioapi.com/book/Web_Audio_API_Boris_Smus_html/ch02.html
4. KevinBonnoron/sirene #16: progressive client-side playback with a scheduling cursor. https://github.com/KevinBonnoron/sirene/issues/16
5. Chrome autoplay policy. https://developer.chrome.com/blog/autoplay
6. Sam Eddy, "iOS Safari audio sessions: fifteen commits to a working voice mode". https://samueleddy.com/writing/ios-safari-audio-sessions/
7. Matt Montag, "Unlock JavaScript Web Audio in Safari and Chrome". https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos
8. Chromium issue 41294170: "Speech Synthesis stops abruptly after about 15 seconds". https://issues.chromium.org/issues/41294170
9. hexgrad/Kokoro-82M, VOICES.md (voice grades). https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
10. ONNX Runtime thread management, and container oversubscription reports. https://onnxruntime.ai/docs/performance/tune-performance/threading.html · https://github.com/mmornati/proton-faces/issues/79
11. W3C Web Speech API explainer: on-device speech recognition. https://github.com/WebAudio/web-speech-api/blob/main/explainers/on-device-speech-recognition.md
12. rhasspy/piper-voices, `hi_IN/priyamvada/medium` MODEL_CARD (CC-BY-NC-SA 4.0). https://huggingface.co/rhasspy/piper-voices/blob/main/hi/hi_IN/priyamvada/medium/MODEL_CARD
13. AI4Bharat Indic Parler-TTS. https://huggingface.co/ai4bharat/indic-parler-tts
14. k2-fsa/sherpa-onnx `tts-models` release (model names and sizes quoted above). https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models
