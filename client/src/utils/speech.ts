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
 *   listenOnce(lang, onInterim)           // STT, one-shot
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
  return typeof window !== 'undefined' && (typeof fetch !== 'undefined' || 'speechSynthesis' in window);
}

/* ------------------------------- TTS ------------------------------- */

type TtsStateListener = (speaking: boolean) => void;
type QueueItem =
  | { kind: 'remote'; audio: HTMLAudioElement; url: string }
  | { kind: 'local'; utt: SpeechSynthesisUtterance };

let stateListener: TtsStateListener | null = null;
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

/** Register a listener that fires when audio actually starts/stops. */
export function setTtsStateListener(fn: TtsStateListener | null): void {
  stateListener = fn;
}

function notifyState(speaking: boolean): void {
  stateListener?.(speaking);
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
  preferredVoice =
    best || pool.find((v) => !MALE_VOICE_NAMES.test(v.name)) || pool[0] || null;
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
 */
function splitChunks(text: string): string[] {
  const parts = text.match(/[^.!?…\n]+[.!?…\n]*\s*|.+/g) || [text];
  const chunks: string[] = [];
  let buf = '';
  for (const raw of parts) {
    const piece = raw.trim();
    if (!piece) continue;
    if ((buf + ' ' + piece).trim().length > 220) {
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
  notifyState(false);
}

/**
 * Pump the text queue: fetch+play one chunk at a time, in order. Serialized
 * so sentences never interleave; the store's per-sentence speakChunk calls
 * already stagger fetches across sentences for low first-audio latency.
 */
async function pump(lang: string): Promise<void> {
  if (pumping) return;
  pumping = true;
  const mySession = speechSession;
  try {
    while (mySession === speechSession) {
      const chunk = textQueue.shift();
      if (chunk === undefined) break;
      const item = await fetchItem(chunk, lang, mySession);
      if (mySession !== speechSession) {
        if (item) cancelItem(item);
        break;
      }
      if (item) await playItem(item, mySession);
      if (mySession !== speechSession) break;
    }
  } finally {
    pumping = false;
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
        }
        cancelItem(item); // revoke the blob URL now that playback is over
      }
      resolve();
    };
    if (item.kind === 'remote') {
      currentAudio = item.audio;
      currentAudioUrl = item.url;
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

/**
 * Listen once and resolve with the transcribed text. `onInterim` (if given)
 * receives live partial transcriptions for UI feedback. Auto-stops after
 * `maxMs` so the button can't get stuck in "Listening…" forever.
 */
export function listenOnce(
  lang = 'en-US',
  onInterim?: (text: string) => void,
  maxMs = 8000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      reject(new Error('Speech recognition not supported in this browser'));
      return;
    }

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;

    let finalTranscript = '';
    let settled = false;
    const timer = setTimeout(() => {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
    }, maxMs);

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(finalTranscript.trim());
    };

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim?.((finalTranscript + (interim ? ' ' + interim : '')).trim());
    };
    recognition.onerror = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(e.error || 'speech-recognition-error'));
    };
    recognition.onend = finish;

    recognition.start();
  });
}
