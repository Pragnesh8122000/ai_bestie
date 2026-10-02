/**
 * The browser speechSynthesis voice: the fallback when the neural voice is
 * unavailable, and the voice for Hindi/Gujarati chunks the English server
 * voice can't speak.
 * Used by `tts.ts`; kept apart so the queue logic stays readable.
 */
import { splitChunks } from './speechChunker';

// Browser-voice utterances are kept below Chrome's ~15s cutoff, past which
// Chrome stops speaking without ever firing `onend`.
const LOCAL_MAX_CHARS = 200;
// Playback is abandoned this long after its expected end if `onend` never
// fires, so a stuck utterance can't freeze the rest of the reply.
const PLAYBACK_GRACE_MS = 5_000;

let preferredVoice: SpeechSynthesisVoice | null = null;
// Set once the browser voice has actually been used, after which the choice is
// frozen (see loadVoice) so a late `onvoiceschanged` can't swap voices.
let voiceLocked = false;

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
 * Utterances for `chunk` in the single fallback voice (female, frozen once
 * used), or null where speechSynthesis doesn't exist.
 */
export function browserVoiceUtterances(
  chunk: string,
  lang: string,
): SpeechSynthesisUtterance[] | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  if (!preferredVoice) loadVoice(); // voices may have arrived since page load
  // From here on the choice is final for the session.
  voiceLocked = true;
  return splitChunks(chunk, LOCAL_MAX_CHARS).map((text) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = preferredVoice?.lang || lang;
    if (preferredVoice) u.voice = preferredVoice;
    u.rate = 0.98;
    u.pitch = 1.0;
    return u;
  });
}

/**
 * Utterances in a device voice for `lang` (e.g. "hi-IN"), or null when the
 * device has no voice for that language.
 */
export function languageUtterances(chunk: string, lang: string): SpeechSynthesisUtterance[] | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null;
  const prefix = lang.slice(0, 2).toLowerCase();
  const voice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang?.toLowerCase().startsWith(prefix));
  if (!voice) return null;
  return splitChunks(chunk, LOCAL_MAX_CHARS).map((text) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voice.lang;
    u.voice = voice;
    u.rate = 0.98;
    return u;
  });
}

export function playUtterance(utt: SpeechSynthesisUtterance): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve();
    };
    // ~14 characters per second of speech at rate 1.
    const expectedMs = ((utt.text.length / 14) * 1000) / (utt.rate || 1);
    const watchdog = setTimeout(() => {
      window.speechSynthesis.cancel();
      done();
    }, expectedMs + PLAYBACK_GRACE_MS);
    // Clear anything the browser still has queued so two utterances can
    // never speak over each other.
    window.speechSynthesis.cancel();
    utt.onend = done;
    utt.onerror = done;
    window.speechSynthesis.speak(utt);
  });
}
