/**
 * Voice helpers. STT uses the browser SpeechRecognition API; TTS (implemented
 * in `tts.ts`, re-exported here) prefers a server-side neural voice (Kokoro
 * via /api/tts) and falls back to the browser speechSynthesis voice if the
 * server is unavailable or the model isn't loaded.
 *
 * The public API is deliberately small and stable — `chatStore.ts` drives it:
 *   setTtsStateListener(speaking => ...)  // one boolean: audio started/ended
 *   beginSpeech()                         // reset queue for a new reply
 *   speakChunk(sentence)                  // enqueue a sentence for speech
 *   stopSpeaking()                        // cancel now, fire false synchronously
 *   listenOnce(lang, onInterim)           // STT, one turn (restarts across pauses)
 *
 * TTS is driven as a streaming chunk queue: the store flushes chunks to
 * `speakChunk` as they complete in the SSE stream, so audio starts early and
 * the orb reflects actual audio playback.
 */

export {
  beginSpeech,
  setTtsLevelListener,
  setTtsStateListener,
  speak,
  speakChunk,
  stopSpeaking,
} from './tts';

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
const SILENCE_COMMIT_MS = 1600;
// A phrase that ends in a conjunction, preposition, or other continuation cue
// is much more likely to be a thinking pause than the end of the turn. Give it
// a wider window without adding latency to clean, complete final results.
const UNFINISHED_SILENCE_COMMIT_MS = 2400;

// Delay before starting the next recognition attempt after an unexpected
// `onend`/`no-speech`. Calling `start()` synchronously from inside `onend`
// can throw `InvalidStateError` in some engines because the previous session
// hasn't fully torn down yet; a tick of delay avoids that without being
// perceptible as a gap to the speaker.
const RESTART_DELAY_MS = 80;

const CONTINUATION_WORDS = new Set([
  'a',
  'although',
  'an',
  'and',
  'because',
  'but',
  'for',
  'my',
  'of',
  'or',
  'the',
  'to',
  'with',
  'your',
]);

function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/[,:;–—…-]$/.test(trimmed)) return true;

  const pairs: Array<[string, string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ];
  if (
    pairs.some(([open, close]) => trimmed.split(open).length - 1 > trimmed.split(close).length - 1)
  ) {
    return true;
  }

  const lastWord = trimmed.toLowerCase().match(/[a-z']+$/)?.[0] ?? '';
  return CONTINUATION_WORDS.has(lastWord);
}

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
 *    own silence timer AND the last text is interim or visibly unfinished —
 *    including WebKit promoting an incomplete phrase to "final" — a fresh
 *    attempt starts immediately and keeps accumulating into the same turn.
 *  - An attempt that ends with zero results at all (nothing heard since the
 *    last attempt started), or whose final text looks complete, resolves at
 *    once. This keeps clean short utterances free of added latency.
 *
 * Returns a `stop()` handle alongside the promise so a caller can end the
 * turn early (e.g. on component unmount) without treating that as an error —
 * `stop()` resolves with whatever was transcribed so far, across every
 * attempt.
 */
export function listenOnce(
  lang = 'en-US',
  onInterim?: (text: string) => void,
  maxMs = 30000,
  onSpeechEnd?: (at: number) => void,
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
  let lastResultAt: number | null = null;
  let speechEndReported = false;
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
    if (!speechEndReported) {
      speechEndReported = true;
      onSpeechEnd?.(lastResultAt ?? performance.now());
    }
    resolveTurn(finalTranscript.trim());
  };

  const failWith = (message: string) => {
    if (settled) return;
    settled = true;
    clearTimers();
    rejectTurn(new Error(message));
  };

  // We — not the engine — decide how long a pause means "done talking". The
  // window is measured from the last result, so it also bounds an attempt
  // restarted after an early `onend` that never hears anything else.
  const armSilenceCommit = () => {
    if (commitTimer) clearTimeout(commitTimer);
    const silenceMs = looksUnfinished(`${finalTranscript} ${lastInterim}`)
      ? UNFINISHED_SILENCE_COMMIT_MS
      : SILENCE_COMMIT_MS;
    const sinceLastResult = lastResultAt === null ? 0 : performance.now() - lastResultAt;
    commitTimer = setTimeout(
      () => {
        commitTimer = null;
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
      Math.max(0, silenceMs - sinceLastResult),
    );
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
      const transcript = `${finalTranscript} ${lastInterim}`.trim();
      if (stopRequested || !gotAnyResult || (lastResultWasFinal && !looksUnfinished(transcript))) {
        finish();
        return;
      }
      // Restarting: this attempt's own recognizer instance is about to be
      // discarded, taking its interim buffer with it. Commit that text now
      // so the next attempt only ever adds to it.
      promotePendingInterim();
      awaitingRestart = true;
      restartTimer = setTimeout(startAttempt, RESTART_DELAY_MS);
      armSilenceCommit();
    };

    recognition.onresult = (e) => {
      gotAnyResult = true;
      lastResultAt = performance.now();
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

      armSilenceCommit();
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
