/**
 * Voice helpers. STT uses the browser SpeechRecognition API; TTS now prefers a
 * server-side neural voice (Kokoro via /api/tts) and falls back to the browser
 * speechSynthesis voice if the server is unavailable or the model isn't loaded.
 *
 * The public API is deliberately small and stable — `chatStore.ts` drives it:
 *   setTtsStateListener(speaking => ...)  // one boolean: audio started/ended
 *   beginSpeech()                         // reset queue for a new reply
 *   speakChunk(sentence)                  // enqueue a sentence for speech
 *   stopSpeaking()                        // cancel now, fire false synchronously
 *   listenOnce(lang, onInterim)           // STT, one turn (restarts across pauses)
 *
 * TTS is driven as a streaming sentence queue: the store flushes sentences to
 * `speakChunk` as they complete in the SSE stream, so audio starts within ~1s
 * and the orb reflects actual audio playback.
 */

// Minimal ambient types — the Web Speech API types are not in lib.dom by default.
interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
  length: number;
}
interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function isSTTSupported(): boolean {
  return getRecognitionCtor() !== null;
}

// Server-side neural TTS works on any browser that can fetch+play audio; the
// browser speechSynthesis fallback is a bonus, not a requirement.
export function isTTSSupported(): boolean {
  return (
    typeof window !== 'undefined' && (typeof fetch !== 'undefined' || 'speechSynthesis' in window)
  );
}

/* ------------------------------- TTS ------------------------------- */

type TtsStateListener = (speaking: boolean) => void;
type TtsLevelListener = (level: number) => void;
type QueueItem =
  | { kind: 'remote'; audio: HTMLAudioElement; url: string }
  | { kind: 'local'; utt: SpeechSynthesisUtterance };

let stateListener: TtsStateListener | null = null;
let levelListener: TtsLevelListener | null = null;
let preferredVoice: SpeechSynthesisVoice | null = null;
// Set once the browser voice has actually been used, after which the choice is
// frozen (see loadVoice) so a late `onvoiceschanged` can't swap voices.
let voiceLocked = false;

/**
 * Which engine speaks. Decided once per page-load by the first chunk that
 * actually produces audio, then never changed. Mixing engines (or letting a
 * single failed fetch drop one sentence onto the browser voice) is what made
 * a reply sound like several different people.
 */
type TtsMode = 'unknown' | 'remote' | 'local';
let ttsMode: TtsMode = 'unknown';

// A speech session is one reply. Bumping `speechSession` invalidates every
// in-flight fetch from the previous session so audio from an aborted/new
// stream can't leak in after stopSpeaking() / beginSpeech().
let speechSession = 0;
let textQueue: string[] = [];
let pumping = false;
let speaking = false; // an item is currently playing (drives notifyState(true))
let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
let stopPlaybackMeter: (() => void) | null = null;

/** Register a listener that fires when audio actually starts/stops. */
export function setTtsStateListener(fn: TtsStateListener | null): void {
  stateListener = fn;
}

/** Register a listener for normalized neural-playback amplitude (0..1). */
export function setTtsLevelListener(fn: TtsLevelListener | null): void {
  levelListener = fn;
  if (!fn) stopPlaybackMeter?.();
}

function notifyState(speaking: boolean): void {
  stateListener?.(speaking);
}

function startPlaybackLevelMeter(audio: HTMLAudioElement): void {
  stopPlaybackMeter?.();
  const AudioContextCtor =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor || !levelListener) return;

  try {
    const context = new AudioContextCtor();
    const source = context.createMediaElementSource(audio);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser);
    analyser.connect(context.destination);
    const values = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let stopped = false;
    const read = () => {
      if (stopped) return;
      analyser.getByteFrequencyData(values);
      const average = values.reduce((sum, value) => sum + value, 0) / values.length;
      levelListener?.(Math.min(1, average / 110));
      frame = requestAnimationFrame(read);
    };
    void context.resume().catch(() => {});
    frame = requestAnimationFrame(read);
    stopPlaybackMeter = () => {
      if (stopped) return;
      stopped = true;
      if (frame) cancelAnimationFrame(frame);
      levelListener?.(0);
      source.disconnect();
      analyser.disconnect();
      void context.close().catch(() => {});
      stopPlaybackMeter = null;
    };
  } catch {
    // Playback remains functional when metering is unavailable. The orb keeps
    // its deterministic speaking animation instead.
    levelListener?.(0);
  }
}

// Browser voices, ranked. The companion is female, so male voices are excluded
// outright rather than being allowed in as an "any English voice" fallback —
// picking `en[0]` used to hand Sam a male voice on some machines, and a
// different one on every OS.
const FEMALE_VOICE_NAMES = [
  'samantha', // macOS / iOS default female
  'ava',
  'allison',
  'susan',
  'zoe',
  'karen',
  'moira',
  'tessa',
  'fiona',
  'serena',
  'aria', // Windows / Edge neural
  'jenny',
  'michelle',
  'zira',
  'google us english', // Chrome (female)
  'google uk english female',
];
const MALE_VOICE_NAMES =
  /daniel|alex|fred|tom|david|mark|guy|george|lewis|ryan|oliver|arthur|male|man\b|junior|aaron|bruce|albert|rishi|eddy|reed|rocko|grandpa/i;

function scoreVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  const idx = FEMALE_VOICE_NAMES.findIndex((n) => name.includes(n));
  if (idx === -1) return -1;
  // Earlier in the list = better; prefer local (offline, stable) voices.
  return (FEMALE_VOICE_NAMES.length - idx) * 10 + (v.localService ? 1 : 0);
}

function loadVoice(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  // Once a voice has actually spoken, it is frozen for the session. Chrome
  // populates getVoices() asynchronously and fires `onvoiceschanged` after
  // playback may already have started; re-picking then would swap the voice
  // mid-reply (e.g. Zira → Samantha), which is the very bug this module
  // exists to prevent.
  if (voiceLocked) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return;
  const en = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  const pool = en.length ? en : voices;

  let best: SpeechSynthesisVoice | null = null;
  let bestScore = 0;
  for (const v of pool) {
    const s = scoreVoice(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }

  // No recognised female voice: take the first English voice that isn't a
  // known male one, and only then fall back to whatever exists. Deterministic
  // either way — the same voice for every sentence of every reply.
  preferredVoice = best || pool.find((v) => !MALE_VOICE_NAMES.test(v.name)) || pool[0] || null;
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadVoice();
  // Chrome populates getVoices() asynchronously after this event.
  window.speechSynthesis.onvoiceschanged = () => loadVoice();
}

/**
 * Split text into speakable chunks at sentence/clause boundaries, capped so a
 * single chunk stays short (keeps per-request latency low and gives natural
 * pauses between sentences).
 *
 * The cap is intentionally >= the ~280-char batches chatStore.ts hands to
 * speakChunk (2 sentences at a time): letting 2 sentences reach the TTS
 * model in one request is what gives the neural voice continuous prosody
 * across the sentence boundary instead of resetting intonation on every
 * single sentence, which is what made replies sound choppy/robotic.
 */
function splitChunks(text: string): string[] {
  const parts = text.match(/[^.!?…\n]+[.!?…\n]*\s*|.+/g) || [text];
  const chunks: string[] = [];
  let buf = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if ((buf + ' ' + piece).trim().length > 320) {
      if (buf.trim()) chunks.push(buf.trim());
      buf = piece;
    } else {
      buf = (buf ? buf + ' ' : '') + piece;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

/** Cancel any currently-playing audio (both remote + local fallback). */
function cancelCurrent(): void {
  stopPlaybackMeter?.();
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    if (currentAudioUrl) {
      try {
        URL.revokeObjectURL(currentAudioUrl);
      } catch {
        /* ignore */
      }
      currentAudioUrl = null;
    }
    currentAudio.src = '';
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function cancelItem(item: QueueItem): void {
  if (item.kind === 'remote') {
    try {
      URL.revokeObjectURL(item.url);
    } catch {
      /* ignore */
    }
  }
}

/** Reset the queue for a new reply (cancels any in-progress audio). */
export function beginSpeech(): void {
  speechSession++;
  textQueue = [];
  cancelCurrent();
  speaking = false;
  levelListener?.(0);
  // Intentionally does NOT notifyState — matches the old contract so the orb
  // doesn't flicker at stream start.
}

/** Enqueue a chunk of text (e.g. one sentence) for speech. */
export function speakChunk(text: string, lang = 'en-US'): void {
  if (!text || !text.trim()) return;
  for (const c of splitChunks(text)) textQueue.push(c);
  void pump(lang);
}

/** Speak a complete text at once (non-streaming convenience wrapper). */
export function speak(text: string, lang = 'en-US'): void {
  beginSpeech();
  speakChunk(text, lang);
}

export function stopSpeaking(): void {
  speechSession++;
  textQueue = [];
  cancelCurrent();
  speaking = false;
  levelListener?.(0);
  notifyState(false);
}

/**
 * Pump the text queue: play one chunk at a time, in order, while synthesizing
 * the *next* one concurrently.
 *
 * Playback stays strictly serialized (two sentences must never overlap), but
 * synthesis no longer waits for playback to finish. Previously this loop was
 * fully serial — fetch, play, fetch, play — so every sentence boundary stalled
 * for the whole synthesis time of the next chunk. Measured against the real
 * Kokoro endpoint that was ~2.2-3.2s of dead air at each full stop.
 *
 * Synthesis runs at roughly 0.63x the duration of the audio it produces, so
 * starting chunk N+1 when chunk N begins playing means it is almost always
 * ready before chunk N ends, and the gap collapses to the buffer-swap time.
 *
 * Prefetch depth is deliberately 1. The server synthesizes under a mutex, so
 * queuing more requests would not make any single one arrive sooner, and it
 * would waste CPU on audio that a `stopSpeaking()` is about to discard.
 */
async function pump(lang: string): Promise<void> {
  if (pumping) return;
  pumping = true;
  const mySession = speechSession;
  // Synthesis of the chunk after the one currently playing, if any.
  let prefetch: Promise<QueueItem | null> | null = null;
  try {
    while (mySession === speechSession) {
      const chunk = textQueue.shift();
      if (chunk === undefined) break;

      // Use the in-flight synthesis when it belongs to this chunk, otherwise
      // synthesize now. The first chunk of a reply always takes this second
      // path, which is what pins `ttsMode` before any concurrent fetch starts
      // — the engine choice stays a single, race-free decision.
      const item = await (prefetch ?? fetchItem(chunk, lang, mySession));
      prefetch = null;

      if (mySession !== speechSession) {
        if (item) cancelItem(item);
        break;
      }

      // Kick off the next synthesis *before* awaiting playback, so the CPU
      // works on chunk N+1 while chunk N is audible. This is the whole fix.
      const next = textQueue[0];
      if (next !== undefined) {
        prefetch = fetchItem(next, lang, mySession);
        // A rejected prefetch must not surface as an unhandled rejection while
        // it sits idle during playback; fetchItem already resolves errors to
        // null, but a defensive catch keeps that contract local.
        prefetch = prefetch.catch(() => null);
      }

      if (item) await playItem(item, mySession);
      if (mySession !== speechSession) break;
    }
  } finally {
    pumping = false;
    // Don't leak the blob URL of audio that was synthesized but never played
    // (stream aborted, conversation switched, TTS toggled off).
    if (prefetch) void prefetch.then((i) => i && cancelItem(i));
    if (textQueue.length > 0) {
      // A new chunk arrived during the final await — keep pumping so it isn't
      // stranded (its own pump() call returned early while we were running).
      // This also covers the case where the session was superseded mid-await:
      // the queue then belongs to the *new* session and must still be drained.
      void pump(lang);
    } else if (mySession === speechSession) {
      speaking = false;
      notifyState(false);
    }
  }
}

/** Build a browser-voice utterance for `chunk` (the single fallback voice). */
function localItem(chunk: string, lang: string): QueueItem | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  if (!preferredVoice) loadVoice(); // voices may have arrived since page load
  // From here on the choice is final for the session.
  voiceLocked = true;
  const u = new SpeechSynthesisUtterance(chunk);
  u.lang = preferredVoice?.lang || lang;
  if (preferredVoice) u.voice = preferredVoice;
  u.rate = 0.98;
  u.pitch = 1.0;
  return { kind: 'local', utt: u };
}

/**
 * Fetch one chunk's audio from /api/tts.
 *
 * The engine is chosen once per page-load and then locked (`ttsMode`): the
 * first chunk decides, and every later chunk uses the same one. Previously
 * each chunk independently fell back to the browser voice on any error, so a
 * single slow/failed request in the middle of a reply switched voices
 * mid-thought — the "multiple voices" bug. Once locked to 'remote', a failed
 * chunk is skipped (silence) rather than spoken by a different voice.
 */
async function fetchItem(
  chunk: string,
  lang: string,
  mySession: number,
): Promise<QueueItem | null> {
  if (ttsMode === 'local') return localItem(chunk, lang);
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, lang }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('tts empty');
    if (mySession !== speechSession) return null;
    ttsMode = 'remote'; // lock in the neural voice for the rest of the session
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    return { kind: 'remote', audio, url };
  } catch {
    if (mySession !== speechSession) return null;
    if (ttsMode === 'remote') {
      // The neural voice already spoke earlier in this session; a one-off
      // failure must not switch voices mid-reply. Skip this chunk instead.
      return null;
    }
    // Nothing has spoken yet — commit to the browser voice for the session.
    ttsMode = 'local';
    return localItem(chunk, lang);
  }
}

/** Play one item to completion. Resolves on end/error/abort. */
function playItem(item: QueueItem, mySession: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (mySession !== speechSession) {
      cancelItem(item);
      resolve();
      return;
    }
    if (!speaking) {
      speaking = true;
      notifyState(true);
    }
    let settled = false;
    const done = () => {
      // `onended` + `onerror` can both fire; resolving twice would let the
      // pump start the next chunk while this one is still audible.
      if (settled) return;
      settled = true;
      if (item.kind === 'remote') {
        if (currentAudio === item.audio) {
          currentAudio = null;
          currentAudioUrl = null;
          stopPlaybackMeter?.();
        }
        cancelItem(item); // revoke the blob URL now that playback is over
      }
      resolve();
    };
    if (item.kind === 'remote') {
      currentAudio = item.audio;
      currentAudioUrl = item.url;
      startPlaybackLevelMeter(item.audio);
      item.audio.onended = done;
      item.audio.onerror = done;
      void item.audio.play().catch(done);
    } else {
      // Clear anything the browser still has queued so two utterances can
      // never speak over each other.
      window.speechSynthesis.cancel();
      item.utt.onend = done;
      item.utt.onerror = done;
      window.speechSynthesis.speak(item.utt);
    }
  });
}

/* ------------------------------- STT ------------------------------- */

/** A single listen turn: its result plus a way to cancel it early. */
export interface ListenSession {
  promise: Promise<string>;
  /** Stop recognition early (e.g. component unmount) without rejecting. */
  stop: () => void;
}

// How long a pause has to last before we decide the user is actually done
// talking. We enforce this ourselves rather than trusting each engine's own
// end-of-speech heuristic: WebKit's (Safari's) built-in silence timeout is
// materially shorter and less consistent than Chrome's, and Safari does not
// reliably fire `onend` at all after some `no-speech` errors — see the
// restart logic below. A mid-sentence breath or thinking pause is well under
// this, so words after a pause are no longer silently dropped.
const SILENCE_COMMIT_MS = 1200;

// Delay before starting the next recognition attempt after an unexpected
// `onend`/`no-speech`. Calling `start()` synchronously from inside `onend`
// can throw `InvalidStateError` in some engines because the previous session
// hasn't fully torn down yet; a tick of delay avoids that without being
// perceptible as a gap to the speaker.
const RESTART_DELAY_MS = 250;

/**
 * Listen for one full user turn and resolve with the transcribed text.
 * `onInterim` (if given) receives live partial transcriptions for UI
 * feedback. `maxMs` is a hard cap on the whole turn (not a single
 * recognition session — see below) so the mic can never get stuck listening
 * forever.
 *
 * `continuous: true` is deliberately NOT used: it is unreliable in Safari/
 * WebKit (results can stop being delivered without `onend` ever firing, or
 * the session runs away and never ends on silence), so every engine here
 * runs one non-continuous recognition "attempt" at a time. Instead, this
 * function manages its own multi-attempt turn on top of that:
 *
 *  - Every `onresult` (interim or final) resets a `SILENCE_COMMIT_MS` timer.
 *    When that timer fires, we've decided *ourselves* that the user has
 *    stopped talking, and we stop the recognizer deliberately.
 *  - If the recognizer's own `onend` (or a `no-speech` error, which WebKit
 *    fires in cases where Chrome would just end quietly) arrives before our
 *    own silence timer AND the last thing it delivered was still an interim
 *    result (never promoted to final) — i.e. the engine gave up mid-word,
 *    which is exactly the "Safari cuts off mid-sentence" failure mode — a
 *    fresh attempt starts immediately and transcription keeps accumulating
 *    into the same turn, transparently to the caller.
 *  - An attempt that ends with zero results at all (nothing heard since the
 *    last attempt started), or whose last result was already final, is
 *    trusted as a genuine end of turn and resolves rather than restarting —
 *    this keeps the common case (a clean short utterance) free of added
 *    restart-and-wait-for-silence latency.
 *
 * Returns a `stop()` handle alongside the promise so a caller can end the
 * turn early (e.g. on component unmount) without treating that as an error —
 * `stop()` resolves with whatever was transcribed so far, across every
 * attempt.
 */
export function listenOnce(
  lang = 'en-US',
  onInterim?: (text: string) => void,
  maxMs = 20000,
): ListenSession {
  const Ctor = getRecognitionCtor();
  if (!Ctor) {
    return {
      promise: Promise.reject(new Error('Speech recognition not supported in this browser')),
      stop: () => {},
    };
  }

  let finalTranscript = '';
  let lastInterim = '';
  let settled = false;
  let stopRequested = false; // caller stop() or maxMs deadline: never restart again
  let awaitingRestart = false; // between attempts (no live recognition instance)
  let current: SpeechRecognitionLike | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  let resolveTurn!: (text: string) => void;
  let rejectTurn!: (error: Error) => void;

  const clearTimers = () => {
    if (restartTimer) clearTimeout(restartTimer);
    if (commitTimer) clearTimeout(commitTimer);
    clearTimeout(deadlineTimer);
  };

  // Folds a not-yet-finalized tail into the committed transcript. Called
  // both when an attempt is about to restart (its interim text is otherwise
  // gone the moment the next attempt's recognizer replaces it) and when the
  // turn finishes with interim text still pending (an engine that never
  // promotes its last words to a final result before ending).
  const promotePendingInterim = () => {
    if (!lastInterim.trim()) return;
    finalTranscript = finalTranscript
      ? `${finalTranscript} ${lastInterim}`.trim()
      : lastInterim.trim();
    lastInterim = '';
  };

  const finish = () => {
    if (settled) return;
    settled = true;
    promotePendingInterim();
    clearTimers();
    resolveTurn(finalTranscript.trim());
  };

  const failWith = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectTurn(new Error(message));
  };

  const startAttempt = () => {
    if (settled) return;
    awaitingRestart = false;
    let gotAnyResult = false;
    let lastResultWasFinal = false;
    let attemptEnded = false;
    const recognition = new Ctor();
    current = recognition;
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;

    // Decide whether the engine ending this attempt is a normal completion or
    // a premature cutoff. A trailing FINAL result means the engine itself
    // considers the utterance complete — trust that and finish immediately;
    // this is the overwhelmingly common case (a clean short utterance) and
    // must not gain artificial restart-then-wait-for-silence latency on top
    // of it. But if speech was heard and never got promoted past interim
    // before the attempt ended, that's indistinguishable from "the speaker
    // was cut off mid-word" — the specific WebKit/Safari failure this
    // function exists to recover from — so restart and keep listening
    // instead of silently losing the rest of the sentence.
    const onAttemptEnd = () => {
      if (attemptEnded || settled) return;
      attemptEnded = true;
      if (commitTimer) {
        clearTimeout(commitTimer);
        commitTimer = null;
      }
      if (stopRequested || !gotAnyResult || lastResultWasFinal) {
        finish();
        return;
      }
      // Restarting: this attempt's own recognizer instance is about to be
      // discarded, taking its interim buffer with it. Commit that text now
      // so the next attempt only ever adds to it.
      promotePendingInterim();
      awaitingRestart = true;
      restartTimer = setTimeout(startAttempt, RESTART_DELAY_MS);
    };

    recognition.onresult = (e) => {
      gotAnyResult = true;
      lastResultWasFinal = e.results.length > 0 && !!e.results[e.results.length - 1].isFinal;
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          finalTranscript = finalTranscript
            ? `${finalTranscript} ${r[0].transcript}`.trim()
            : r[0].transcript;
        } else {
          interim += r[0].transcript;
        }
      }
      // Always reflects only the currently-uncommitted tail (not a sticky
      // fallback) — an event whose entries are all final must clear it, or a
      // later promotePendingInterim() would re-append stale interim text
      // that a final result already superseded.
      lastInterim = interim;
      onInterim?.((finalTranscript + (interim ? ' ' + interim : '')).trim());

      // We — not the engine — decide how long a pause means "done talking".
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        stopRequested = true;
        try {
          recognition.stop();
        } catch {
          /* ignore */
        }
      }, SILENCE_COMMIT_MS);
    };

    recognition.onerror = (e) => {
      if (settled) return;
      // WebKit fires `no-speech` in several cases where Chrome just ends
      // quietly (including mid-turn pauses); treat it the same as an early
      // `onend` rather than a fatal error so a Safari pause doesn't abort
      // the whole turn. Genuine failures (permission, device, Brave's
      // blocked backend) still reject immediately.
      if (e.error === 'no-speech') {
        onAttemptEnd();
        return;
      }
      attemptEnded = true;
      failWith(e.error || 'speech-recognition-error');
    };
    recognition.onend = onAttemptEnd;

    recognition.start();
  };

  const promise = new Promise<string>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
    deadlineTimer = setTimeout(() => {
      stopRequested = true;
      if (awaitingRestart) {
        finish();
        return;
      }
      try {
        current?.stop();
      } catch {
        /* ignore */
      }
    }, maxMs);
    startAttempt();
  });

  return {
    promise,
    stop: () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      if (awaitingRestart) {
        if (restartTimer) clearTimeout(restartTimer);
        finish();
        return;
      }
      try {
        current?.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
