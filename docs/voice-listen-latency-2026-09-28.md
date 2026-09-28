# Voice listening and response-latency follow-up

Date: 2026-09-28. This follow-up covers immersive voice turn capture through first audible TTS.
The earlier Kokoro/chunking measurements remain in `voice-stt-tts-audit.md`; chunking was not
retuned in this pass.

## Reproduced cut-off causes

| Path / initiating trigger                                                      | Masking condition                                                                     | Visible symptom                                                                                                | What disconfirms this as the cause                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Safari/WebKit emits a `final` result for an unfinished phrase and then `onend` | The old restart only accepted an interim tail; a final result bypassed the 1.2s timer | The turn resolves at the pause and words after it become a separate/lost turn                                  | A complete final result still resolves immediately; no extra wait occurs on that path |
| Recognition remains open after a result, then the user takes a natural pause   | Fixed 1.2s commit treats every phrase the same                                        | The recognizer is stopped during a mid-sentence pause                                                          | If `onend` already fired with complete text, the timer was not involved               |
| Recorded fallback sees 1.2s below the fixed activity threshold                 | Short answers benefited from the low window, hiding the long-sentence failure         | Brave/unsupported-browser recording stops before speech resumes; soft trailing words can be counted as silence | Native recognition does not use this energy detector                                  |
| Recorded fallback reaches the 11.5s server-safe cap                            | Most short turns stop on energy first                                                 | A sentence longer than the cap is uploaded without its tail                                                    | A shorter clipped turn points to pause/energy handling, not this cap                  |
| WebKit ends an attempt early                                                   | The recognizer is inactive during the fixed 250ms restart delay                       | The first word after the pause can land in the dead gap                                                        | No `onend`/`no-speech` means there was no restart gap                                 |
| Persona audio leaks into the barge-in recognizer                               | Headphones or strong acoustic echo cancellation hide it                               | The assistant aborts its own reply, which looks like a slow or incomplete answer                               | A cutoff before the persona starts speaking cannot be barge-in                        |

Regression coverage is in `speech.test.ts`, `voiceCapture.test.ts`, `bargeIn.test.ts`,
`ChatPage.test.tsx`, `chatStore.stream.test.ts`, `tts.test.ts`, and `llmService.test.ts`.

## Changes and measured deltas

| Stage                                                   |                                                 Before |                                                                                                   After | Evidence                                                       |
| ------------------------------------------------------- | -----------------------------------------------------: | ------------------------------------------------------------------------------------------------------: | -------------------------------------------------------------- |
| Brave's doomed Web Speech probe                         |                  4,342.7ms to the real `network` error |                                                             0.2ms Brave detection, then direct fallback | Headless Brave 153 Web Speech events via `chrome-devtools-axi` |
| WebKit restart dead time                                |                                                  250ms |                                                                                                    80ms | Deterministic Web Speech event harness                         |
| Native silence window                                   |                                          Fixed 1,200ms | 1,600ms normally; 2,400ms when text is visibly unfinished; clean final text still completes immediately | Fake-timer regression tests                                    |
| Fallback silence after a short / longer utterance       |                                          Fixed 1,200ms |                                           1,200ms / 2,200ms; quieter trailing speech refreshes activity | Energy-detector regression tests                               |
| Long fallback clip                                      |                              11.5s client / 12s server |                                                                               29.5s client / 30s server | Client capture and server route tests                          |
| Voice-mode retry backoff after a known provider failure |                        1,000ms before the next attempt |                                             0ms; move to the next configured model/provider immediately | `llmService.test.ts`                                           |
| Pre-LLM database work                                   |                  Append, then separate context re-read |                                                      Atomic append returns the updated context document | `chatService.ts`                                               |
| Current Kokoro TTFA model                               | 1,693ms at 0.65× RTF (includes assumed 700ms LLM TTFT) |                                                                           Unchanged; no chunking change | Existing `npm run bench-tts -w server` audit                   |

The real Brave fallback utility path previously took 11,858ms when the analyser detected no
speech: the 11.5s clip ceiling plus a mocked 350ms transcription response. With a 2s diagnostic
turn after the change it took 2,359.6ms including the same 350ms mock; this is a bounded-path
check, not a production Whisper benchmark.

## End-to-end timing

`voiceLatency.ts` now measures one clock from:

1. last detected speech,
2. transcript ready (including Whisper upload for fallback),
3. first LLM token received by the client, and
4. first TTS playback start.

In development builds, each completed turn emits a `voice-turn-latency` browser event, a
`performance.measure`, and a content-free `voice.turn.latency` console JSON line with the three
stage durations and total. Production builds publish none of these. No transcript or reply text is
included. This instrumentation is shared by Safari, Chrome, and the Brave fallback, so dev traces
identify the dominant stage rather than inferring it from the orb state.

Live Safari automation was not available through the required Chrome DevTools runner. Safari's
event pattern is covered at the Web Speech API boundary (including premature final + `onend`), and
the dev-build event provides the requested real Safari end-to-end number on the next device run;
this report does not invent a Safari hardware measurement.
