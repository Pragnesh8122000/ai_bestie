/**
 * Voice replies (TTS). Prefers the server-side neural voice (Kokoro via
 * /api/tts) and falls back to the browser speechSynthesis voice if the server
 * is unavailable or the model isn't loaded. Re-exported by `speech.ts`, which
 * is what callers import.
 *
 *   setTtsStateListener(speaking => ...)  // one boolean: audio started/ended
 *   setTtsLevelListener(level => ...)     // 0..1 playback amplitude
 *   beginSpeech()                         // reset queue for a new reply
 *   speakChunk(text)                      // enqueue a chunk for speech
 *   stopSpeaking()                        // cancel now, fire false synchronously
 *
 * The queue is one reply ("session"). Every chunk is synthesized in order with
 * a bounded look-ahead (PREFETCH_DEPTH) and played through one ordered path:
 * decoded buffers scheduled back-to-back on a shared AudioContext
 * (audioPlayer.ts), or — where Web Audio is unavailable or still locked — an
 * <audio> element per chunk. Stopping or starting a reply bumps the session,
 * aborts in-flight requests (the server then drops their queued synthesis),
 * and drops anything late from the old session.
 */
import {
  decodeAudio,
  ensureRunning,
  getAudioContext,
  hasScheduledAudio,
  installAudioUnlock,
  isWebAudioSupported,
  scheduleBuffer,
  scheduledEnd,
  setPlaybackLevelListener,
  stopAll,
  waitForTime,
} from './audioPlayer';
import { browserVoiceUtterances, languageUtterances, playUtterance } from './browserVoice';
import { splitChunks } from './speechChunker';
import { detectSpeechLanguage } from './speechText';

type TtsStateListener = (speaking: boolean) => void;
type TtsLevelListener = (level: number) => void;
type QueueItem =
  | { kind: 'buffer'; buffer: AudioBuffer; blob: Blob }
  | { kind: 'remote'; audio: HTMLAudioElement; url: string; durationMs: number }
  | { kind: 'local'; utts: SpeechSynthesisUtterance[] };

// Chunks synthesized ahead of the one playing. Two, not one: the server works
// through requests one at a time, so a second queued request keeps it busy
// while a short chunk plays, banking time for a longer chunk later. Measured
// on the long benchmark reply (server/src/scripts/bench-tts.mts) this removed
// ~2.9s of mid-reply silence; deeper than this only synthesizes audio that a
// stop is likely to throw away.
const PREFETCH_DEPTH = 2;
// A /api/tts request that hasn't answered by then is abandoned (skipped, or
// the browser voice if nothing has spoken yet) instead of freezing speech.
// Above the server's own queue-wait + inference limits.
const FETCH_TIMEOUT_MS = 35_000;
// Hand control back this long before a scheduled chunk ends so the next,
// already-synthesized chunk is scheduled on the exact end sample.
const SCHEDULE_LEAD_S = 0.25;
// <audio> playback is abandoned this long after its expected end if `ended`
// never fires, so one stuck element can't freeze the rest of the reply.
const PLAYBACK_GRACE_MS = 5_000;
const DEFAULT_SAMPLE_RATE = 24_000; // Kokoro

let stateListener: TtsStateListener | null = null;
let levelListener: TtsLevelListener | null = null;

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
let chunkSeq = 0;
let textQueue: string[] = [];
let pending: Array<Promise<QueueItem | null>> = [];
const inflight = new Set<AbortController>();
let pumping = false;
let wakePump: (() => void) | null = null;
let speaking = false; // audio is playing (drives notifyState(true))
let currentAudio: HTMLAudioElement | null = null;
let currentAudioUrl: string | null = null;
let firstAudioListener: (() => void) | null = null;

installAudioUnlock();

/** Register a listener that fires when audio actually starts/stops. */
export function setTtsStateListener(fn: TtsStateListener | null): void {
  stateListener = fn;
}

/** Register a listener for normalized neural-playback amplitude (0..1). */
export function setTtsLevelListener(fn: TtsLevelListener | null): void {
  levelListener = fn;
  setPlaybackLevelListener(fn);
}

function notifyState(value: boolean): void {
  stateListener?.(value);
}

/** Cancel any currently-playing audio (all engines). */
function cancelCurrent(): void {
  stopAll();
  if (currentAudio) {
    try {
      currentAudio.pause();
    } catch {
      /* ignore */
    }
    if (currentAudioUrl) revoke(currentAudioUrl);
    currentAudioUrl = null;
    currentAudio.src = '';
    currentAudio = null;
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

function revoke(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

function discard(item: QueueItem): void {
  if (item.kind === 'remote') revoke(item.url);
}

/** Invalidate the current reply: queued text, requests, and audio. */
function resetSession(): void {
  speechSession++;
  textQueue = [];
  // Abort requests still in flight; the server drops their queued synthesis.
  for (const ac of inflight) ac.abort();
  inflight.clear();
  // Anything already synthesized for the old session is released, never played.
  for (const p of pending) void p.then((item) => item && discard(item));
  pending = [];
  cancelCurrent();
  speaking = false;
  firstAudioListener = null;
  levelListener?.(0);
  wakePump?.();
}

/** Reset the queue for a new reply (cancels any in-progress audio). */
export function beginSpeech(onFirstAudio?: () => void): void {
  resetSession();
  firstAudioListener = onFirstAudio ?? null;
  // Intentionally does NOT notifyState — matches the old contract so the orb
  // doesn't flicker at stream start.
}

/** Enqueue a chunk of text (e.g. one sentence) for speech. */
export function speakChunk(text: string, lang = 'en-US'): void {
  if (!text || !text.trim()) return;
  for (const c of splitChunks(text)) textQueue.push(c);
  if (pumping) {
    fill(lang);
    wakePump?.();
  } else {
    void pump(lang);
  }
}

/** Speak a complete text at once (non-streaming convenience wrapper). */
export function speak(text: string, lang = 'en-US'): void {
  beginSpeech();
  speakChunk(text, lang);
}

export function stopSpeaking(): void {
  resetSession();
  notifyState(false);
}

/**
 * Start synthesis for queued text, in order, up to PREFETCH_DEPTH ahead.
 * While the engine is still undecided only the first chunk is requested, so
 * `ttsMode` is pinned by exactly one response (race-free).
 */
function fill(lang: string): void {
  while (textQueue.length && pending.length < PREFETCH_DEPTH) {
    if (ttsMode === 'unknown' && pending.length > 0) return;
    const chunk = textQueue.shift()!;
    // fetchItem never rejects; the catch keeps an idle prefetch from ever
    // surfacing as an unhandled rejection.
    pending.push(fetchItem(chunk, lang, speechSession).catch(() => null));
  }
}

/**
 * Pump the queue: play chunks one after another, in order, while the next
 * ones synthesize.
 *
 * Playback stays strictly ordered and non-overlapping, but synthesis never
 * waits for playback: chunk N+1 (and N+2) are requested while N is audible,
 * so at a boundary the next chunk is normally already decoded and is
 * scheduled on the sample where N ends.
 */
async function pump(lang: string): Promise<void> {
  if (pumping) return;
  pumping = true;
  const mySession = speechSession;
  try {
    while (mySession === speechSession) {
      fill(lang);
      const next = pending[0];
      if (!next) {
        // Nothing queued: let scheduled audio finish, unless more text
        // arrives first (then it is fetched and scheduled right behind).
        if (!(await waitForTailOrText())) break;
        continue;
      }
      const item = await next;
      if (mySession !== speechSession) break;
      pending.shift();
      fill(lang); // a slot freed up, and the engine may now be decided
      if (item) await playItem(item, mySession);
    }
  } finally {
    pumping = false;
    if (textQueue.length > 0 || pending.length > 0) {
      // Text arrived during the final await — or the session was superseded
      // mid-await and the queue now belongs to the new one. Keep draining.
      void pump(lang);
    } else if (mySession === speechSession) {
      speaking = false;
      notifyState(false);
    }
  }
}

/** True if text arrived before the scheduled audio finished playing. */
function waitForTailOrText(): Promise<boolean> {
  if (!hasScheduledAudio()) return Promise.resolve(textQueue.length > 0);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (more: boolean) => {
      if (settled) return;
      settled = true;
      wakePump = null;
      resolve(more);
    };
    wakePump = () => finish(textQueue.length > 0 || pending.length > 0);
    void waitForTime(scheduledEnd()).then((result) => {
      // A clock that stopped (interrupted/suspended context) must not leave
      // audio queued to burst out later.
      if (result === 'stalled') stopAll();
      finish(textQueue.length > 0 || pending.length > 0);
    });
  });
}

function markSpeaking(): void {
  if (!speaking) {
    speaking = true;
    const onFirstAudio = firstAudioListener;
    firstAudioListener = null;
    onFirstAudio?.();
    notifyState(true);
  }
}

/**
 * Play one item. A decoded buffer returns shortly before it ends (so the next
 * can be scheduled gaplessly); an <audio> element or browser utterance
 * returns when it has finished, or after its watchdog.
 */
async function playItem(queued: QueueItem, mySession: number): Promise<void> {
  let item: Exclude<QueueItem, { kind: 'buffer' }>;
  if (queued.kind === 'buffer') {
    if (await ensureRunning()) {
      if (mySession !== speechSession) return;
      markSpeaking();
      const end = scheduleBuffer(queued.buffer);
      const result = await waitForTime(end - SCHEDULE_LEAD_S);
      if (result === 'stalled' && mySession === speechSession) stopAll();
      return;
    }
    // Autoplay hasn't unlocked Web Audio yet: play this chunk the old way.
    item = remoteItem(queued.blob, queued.buffer.duration * 1000);
  } else {
    item = queued;
  }
  // Element and browser-voice playback can't be scheduled on the audio clock,
  // so let already-scheduled buffers finish first — never overlap.
  if (hasScheduledAudio()) await waitForTime(scheduledEnd());
  if (mySession !== speechSession) {
    discard(item);
    return;
  }
  markSpeaking();
  if (item.kind === 'remote') await playElement(item, mySession);
  else for (const utt of item.utts) if (mySession === speechSession) await playUtterance(utt);
}

function playElement(
  item: Extract<QueueItem, { kind: 'remote' }>,
  mySession: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      // `onended` + `onerror` (+ the watchdog) can all fire; resolving twice
      // would let the pump start the next chunk while this one is audible.
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (currentAudio === item.audio) {
        currentAudio = null;
        currentAudioUrl = null;
      }
      discard(item); // revoke the blob URL now that playback is over
      resolve();
    };
    const watchdog = setTimeout(() => {
      try {
        item.audio.pause();
      } catch {
        /* ignore */
      }
      done();
    }, item.durationMs + PLAYBACK_GRACE_MS);
    if (mySession !== speechSession) {
      done();
      return;
    }
    currentAudio = item.audio;
    currentAudioUrl = item.url;
    item.audio.onended = done;
    item.audio.onerror = done;
    void item.audio.play().catch(done);
  });
}

/** The single fallback browser voice, or null where speechSynthesis is absent. */
function localItem(chunk: string, lang: string): QueueItem | null {
  const utts = browserVoiceUtterances(chunk, lang);
  return utts ? { kind: 'local', utts } : null;
}

function remoteItem(blob: Blob, durationMs: number): Extract<QueueItem, { kind: 'remote' }> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = 'auto';
  return { kind: 'remote', audio, url, durationMs };
}

/** Duration of a 16-bit mono PCM WAV from its header, or a Kokoro-rate estimate. */
function wavDurationMs(data: ArrayBuffer | null, size: number): number {
  let rate = DEFAULT_SAMPLE_RATE;
  if (data && data.byteLength >= 44) rate = new DataView(data).getUint32(24, true) || rate;
  return (Math.max(0, size - 44) / (rate * 2)) * 1000;
}

/** Turn a successful /api/tts response into something playable, or null if empty. */
async function toItem(res: Response): Promise<QueueItem | null> {
  if (isWebAudioSupported() && typeof res.arrayBuffer === 'function' && getAudioContext()) {
    const data = await res.arrayBuffer();
    if (!data.byteLength) return null;
    const blob = new Blob([data], { type: 'audio/wav' });
    // decodeAudioData detaches its input, so it gets a copy.
    const buffer = await decodeAudio(data.slice(0));
    return buffer
      ? { kind: 'buffer', buffer, blob }
      : remoteItem(blob, wavDurationMs(data, data.byteLength));
  }
  const blob = await res.blob();
  if (!blob || blob.size === 0) return null;
  return remoteItem(blob, wavDurationMs(null, blob.size));
}

/** One retry, only for failures that are transient and safe to repeat. */
function retryDelayMs(res: Response | null, error: unknown): number | null {
  if (res) {
    // The server sets Retry-After only when it is busy (queue full); a 503
    // without it means TTS is unavailable, which a retry won't fix.
    const retryAfter = res.status === 503 ? res.headers?.get?.('Retry-After') : null;
    if (!retryAfter) return null;
    const seconds = Number(retryAfter);
    return Math.min(2000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : 500));
  }
  // A real network failure (fetch rejects with TypeError), not an abort.
  return error instanceof TypeError ? 300 : null;
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
  const language = detectSpeechLanguage(chunk);
  if (language !== 'en') {
    // Kokoro's English voice can only mangle Hindi/Gujarati script (and
    // Gujarati isn't a Kokoro language at all), so such a chunk goes to a
    // browser voice for that language when the device has one — the one
    // deliberate exception to "one voice per reply". Without one, the
    // normal path below is unchanged.
    const utts = languageUtterances(chunk, language);
    if (utts) return { kind: 'local', utts };
  }
  if (ttsMode === 'local') return localItem(chunk, lang);

  const seq = ++chunkSeq;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController();
    inflight.add(ac);
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
    let res: Response | null = null;
    let failure: unknown = null;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          // Correlation ids for the server's structured logs; no content.
          'X-TTS-Generation': String(mySession),
          'X-TTS-Chunk': String(seq),
        },
        body: JSON.stringify({ text: chunk, lang }),
        signal: ac.signal,
      });
      if (res.ok) {
        const item = await toItem(res);
        if (!item) throw new Error('tts empty');
        if (mySession !== speechSession) {
          discard(item);
          return null;
        }
        ttsMode = 'remote'; // lock in the neural voice for the rest of the session
        return item;
      }
    } catch (error) {
      failure = error;
      res = null;
    } finally {
      clearTimeout(timer);
      inflight.delete(ac);
    }
    if (mySession !== speechSession) return null; // stopped/superseded: never retry
    const wait = attempt === 0 ? retryDelayMs(res, failure) : null;
    if (wait === null) break;
    await new Promise((r) => setTimeout(r, wait));
    if (mySession !== speechSession) return null;
  }

  if (ttsMode === 'remote') {
    // The neural voice already spoke earlier in this session; a one-off
    // failure must not switch voices mid-reply. Skip this chunk instead.
    return null;
  }
  // Nothing has spoken yet — commit to the browser voice for the session.
  ttsMode = 'local';
  return localItem(chunk, lang);
}
