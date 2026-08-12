/**
 * Integration check for the "one voice only" guarantee.
 *
 * Drives the REAL client speech module (client/src/utils/speech.ts, unmodified)
 * against the REAL running server over HTTP, sentence by sentence, exactly the
 * way a streamed reply does. Asserts the whole reply is spoken by a single
 * voice and that the neural voice and the browser fallback are never mixed.
 *
 * Usage (dev server must be running):
 *   TTS_TOKEN=<jwt> npx tsx src/scripts/verify-voice.mts
 *
 * Optional: FAIL_AT=<n> simulates a network failure on the nth TTS request.
 *   FAIL_AT=1 → fails before anything spoke, so it locks to the browser voice
 *               and still speaks every sentence.
 *   FAIL_AT>1 → the neural voice already spoke, so that one sentence is
 *               skipped rather than spoken in a different voice.
 */
const TOKEN = process.env.TTS_TOKEN;
const BASE = process.env.TTS_BASE_URL || 'http://localhost:3001';

if (!TOKEN) {
  console.error('TTS_TOKEN is required (a valid auth JWT). See the header comment.');
  process.exit(2);
}

const played: { engine: string; bytes: number }[] = [];

// --- Minimal browser environment for the client module -------------------
const g = globalThis as any;
g.window = g;

g.speechSynthesis = {
  getVoices: () => [{ name: 'Samantha', lang: 'en-US', localService: true }],
  cancel: () => {},
  onvoiceschanged: null,
  speak: (u: any) => {
    played.push({ engine: 'local:' + (u.voice?.name ?? 'default'), bytes: 0 });
    setTimeout(() => u.onend?.(), 0);
  },
};
class Utt {
  voice: any = null;
  lang = '';
  rate = 1;
  pitch = 1;
  onend: any = null;
  onerror: any = null;
  constructor(public text: string) {}
}
g.SpeechSynthesisUtterance = Utt;

const blobs = new Map<string, number>();
let n = 0;
g.URL.createObjectURL = (b: any) => {
  const u = `blob:${++n}`;
  blobs.set(u, b.size);
  return u;
};
g.URL.revokeObjectURL = (u: string) => blobs.delete(u);

g.Audio = class {
  onended: any = null;
  onerror: any = null;
  preload = '';
  src: string;
  constructor(url: string) {
    this.src = url;
  }
  play() {
    played.push({ engine: 'remote', bytes: blobs.get(this.src) ?? -1 });
    setTimeout(() => this.onended?.(), 0);
    return Promise.resolve();
  }
  pause() {}
};

// Route the module's relative /api/tts fetch at the live server + auth cookie.
const realFetch = globalThis.fetch;
let reqN = 0;
const FAIL_AT = Number(process.env.FAIL_AT ?? 0);
g.fetch = (url: string, init: any = {}) =>
  (++reqN === FAIL_AT ? Promise.reject(new Error('simulated network blip')) : realFetch(url.startsWith('http') ? url : BASE + url, {
    ...init,
    headers: { ...(init.headers || {}), cookie: `token=${TOKEN}` },
  }));

// --- Drive it like a real streamed reply ---------------------------------
const speech = await import('../../../client/src/utils/speech.ts');

const sentences = [
  'Hey, I am really glad you messaged me today.',
  'How are you feeling right now?',
  'I have been thinking about what you said yesterday.',
  'Take all the time you need.',
  'I am right here with you.',
];

const states: boolean[] = [];
speech.setTtsStateListener((s: boolean) => states.push(s));

speech.beginSpeech();
for (const s of sentences) {
  speech.speakChunk(s);
  await new Promise((r) => setTimeout(r, 120)); // sentences arrive staggered
}
// Wait for the queue to drain.
for (let i = 0; i < 100 && played.length < sentences.length; i++) {
  await new Promise((r) => setTimeout(r, 200));
}
await new Promise((r) => setTimeout(r, 500));

console.log('\nplayed:', played.length, 'of', sentences.length);
for (const p of played) console.log('  ', p.engine, p.bytes, 'bytes');

const engines = new Set(played.map((p) => p.engine));
// The invariant under test is ONE voice for the whole reply. A simulated
// mid-reply failure legitimately skips that sentence rather than speaking it
// in a second voice, so expect one fewer when FAIL_AT is in range.
// A failure on the FIRST chunk locks to the browser voice and still speaks
// every sentence; a later failure (already locked to remote) skips just that
// one rather than switching voice.
const expected = FAIL_AT > 1 && FAIL_AT <= sentences.length ? sentences.length - 1 : sentences.length;
const ok =
  played.length === expected &&
  engines.size === 1 &&
  states[states.length - 1] === false;

console.log('distinct engines/voices:', [...engines]);
console.log('final speaking state:', states[states.length - 1]);
console.log('leaked blob urls:', blobs.size);
console.log('expected sentences:', expected);
console.log(ok && blobs.size === 0 ? `\nPASS: exactly one voice (${[...engines][0]}) for the whole reply` : '\nFAIL');
process.exit(ok && blobs.size === 0 ? 0 : 1);
