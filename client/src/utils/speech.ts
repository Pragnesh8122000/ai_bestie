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

// A speech session is one reply. Bumping `speechSession` invalidates every
// in-flight fetch from the previous session so audio from an aborted/new
// stream can't leak in after stopSpeaking() / beginSpeech().
let speechSession = 0;
let textQueue: string[] = [];
let pumping = false;
let speaking = false; // an item is currently playing (drives notifyState(true))
let currentAudio: HTMLAudioElement | null = null;

/** Register a listener that fires when audio actually starts/stops. */
export function setTtsStateListener(fn: TtsStateListener | null): void {
  stateListener = fn;
}

function notifyState(speaking: boolean): void {
  stateListener?.(speaking);
}

function loadVoice(): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) return;
  const en = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith('en'));
  preferredVoice =
    en.find((v) => /natural|google|samantha|aria|jenny|daniel/i.test(v.name)) ||
    en[0] ||
    voices[0] ||
    null;
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
    if (mySession === speechSession && textQueue.length > 0) {
      // A new chunk arrived during the final await — keep pumping so it isn't
      // stranded (its own pump() call returned early while we were running).
      void pump(lang);
    } else if (mySession === speechSession) {
      speaking = false;
      notifyState(false);
    }
  }
}

/** Fetch one chunk's audio from /api/tts; fall back to speechSynthesis on any error. */
async function fetchItem(
  chunk: string,
  lang: string,
  mySession: number,
): Promise<QueueItem | null> {
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk, lang }),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    const blob = await res.blob();
    if (mySession !== speechSession) return null;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    return { kind: 'remote', audio, url };
  } catch {
    if (mySession !== speechSession) return null;
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
    const u = new SpeechSynthesisUtterance(chunk);
    u.lang = lang;
    if (preferredVoice) u.voice = preferredVoice;
    u.rate = 0.98;
    return { kind: 'local', utt: u };
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
    const done = () => {
      if (item.kind === 'remote' && currentAudio === item.audio) currentAudio = null;
      resolve();
    };
    if (item.kind === 'remote') {
      currentAudio = item.audio;
      item.audio.onended = done;
      item.audio.onerror = done;
      void item.audio.play().catch(done);
    } else {
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