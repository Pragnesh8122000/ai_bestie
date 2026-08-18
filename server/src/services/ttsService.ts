import path from 'node:path';
import fs from 'node:fs';
import { OfflineTts, GenerationConfig, type GeneratedAudio } from 'sherpa-onnx-node';
import { config } from '../config';
import { AppError } from '../utils/errors';

/**
 * In-process neural TTS via sherpa-onnx (Kokoro English v0_19). Runs inside the
 * Express server — no sidecar, no second always-on service — so the app stays
 * within the Render free process-hour budget.
 *
 * The model is loaded once (lazily on first use / boot) as a process-wide
 * singleton. Synthesis uses `generateAsync` (not the synchronous `generate`),
 * which runs inference on the addon's internal worker thread so the event
 * loop stays free — an in-flight chat SSE stream's heartbeat keeps firing
 * while a sentence is being synthesized.
 *
 * NOTE: we deliberately do NOT pass `onProgress` to `generateAsync`. In
 * sherpa-onnx-node 1.13.x the streaming-progress path hard-crashes the whole
 * process ("v8::ArrayBuffer::New Allocation failed - process out of memory")
 * when the addon marshals a chunk back to JS. That killed every voice reply
 * and made the client silently fall back to a *different* browser voice
 * mid-sentence, which is why replies were spoken by several voices. The
 * AbortSignal is still honoured before and after synthesis; we lose only
 * mid-inference cancellation (a sentence is ~1-3s of CPU).
 *
 * If the model is missing or fails to load, `synthesize` throws AppError(503)
 * and the client falls back to browser speechSynthesis for that chunk.
 */

let tts: OfflineTts | null = null;
let loadAttempted = false;
let loadError: string | null = null;
let loadingPromise: Promise<void> | null = null;

/**
 * Speaker ids differ per Kokoro release, so the allow-list is per version.
 *
 * v0_19 (legacy, 11 speakers):
 *   0 af, 1 af_bella, 2 af_nicole, 3 af_sarah, 4 af_sky   (American female)
 *   5 am_adam, 6 am_michael                               (American male)
 *   7 bf_emma, 8 bf_isabella                              (British female)
 *   9 bm_george, 10 bm_lewis                              (British male)
 *
 * v1_0 (default, 53 speakers) — English female ids only:
 *   0 af_alloy, 1 af_aoede, 2 af_bella, 3 af_heart, 4 af_jessica, 5 af_kore,
 *   6 af_nicole, 7 af_nova, 8 af_river, 9 af_sarah, 10 af_sky   (American)
 *   20 bf_alice, 21 bf_emma, 22 bf_isabella, 23 bf_lily        (British)
 * Ids 11-19 and 24-27 are male; 28+ are non-English and would change the
 * character's accent/language, so neither group is selectable.
 *
 * The companion is female with one fixed voice. A bad TTS_SID must never
 * silently switch the character's voice, gender, or language.
 */
const FEMALE_SIDS_V0_19 = [0, 1, 2, 3, 4, 7, 8];
const FEMALE_SIDS_V1_0 = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 22, 23];

// af_heart is the warmest/most expressive American female voice in v1.0 and is
// the closest match to the companion's persona; af_nicole is the v0_19 default
// the app shipped with.
const DEFAULT_SID_V1_0 = 3; // af_heart
const DEFAULT_SID_V0_19 = 2; // af_nicole

function voiceTable(): { allowed: number[]; fallback: number } {
  return config.tts.modelVersion === 'v0_19'
    ? { allowed: FEMALE_SIDS_V0_19, fallback: DEFAULT_SID_V0_19 }
    : { allowed: FEMALE_SIDS_V1_0, fallback: DEFAULT_SID_V1_0 };
}

/** The one voice the app speaks with. Resolved once, never per-request. */
export function resolveSid(): number {
  const { allowed, fallback } = voiceTable();
  const sid = config.tts.sid;
  return typeof sid === 'number' && Number.isInteger(sid) && allowed.includes(sid)
    ? sid
    : fallback;
}

const VOICE_SID = resolveSid();

/**
 * Speaking rate. Kokoro's default of 1.0 is a touch clipped for conversational
 * speech; ~0.95 reads as more relaxed. Clamped so a bad TTS_SPEED can't render
 * the companion unintelligible.
 */
export function resolveSpeed(): number {
  const s = config.tts.speed;
  if (!Number.isFinite(s)) return 0.95;
  return Math.min(1.3, Math.max(0.7, s));
}

const VOICE_SPEED = resolveSpeed();

function modelFilesPresent(): boolean {
  const dir = config.tts.modelDir;
  return (
    fs.existsSync(path.join(dir, 'model.onnx')) &&
    fs.existsSync(path.join(dir, 'voices.bin')) &&
    fs.existsSync(path.join(dir, 'tokens.txt')) &&
    fs.existsSync(path.join(dir, 'espeak-ng-data'))
  );
}

/**
 * v1.0 ships pronunciation lexicons; they fix the mangled words (names,
 * acronyms, common contractions) that espeak-ng alone gets wrong and which
 * make a reply sound synthetic. v0_19 has none, so the option is omitted
 * there — passing a missing path makes the addon fail to load the model.
 */
function lexiconPath(): string | undefined {
  if (config.tts.modelVersion === 'v0_19') return undefined;
  const us = path.join(config.tts.modelDir, 'lexicon-us-en.txt');
  return fs.existsSync(us) ? us : undefined;
}

/** Load the model once. Idempotent and safe to call repeatedly. */
export async function initTts(): Promise<void> {
  if (loadAttempted || loadingPromise) return loadingPromise ?? Promise.resolve();
  loadingPromise = (async () => {
    try {
      if (!config.tts.enabled) {
        loadError = 'TTS disabled (TTS_ENABLED=false)';
        return;
      }
      if (!modelFilesPresent()) {
        loadError = `Kokoro model not found at ${config.tts.modelDir}`;
        return;
      }
      const dir = config.tts.modelDir;
      tts = await OfflineTts.createAsync({
        model: {
          kokoro: {
            model: path.join(dir, 'model.onnx'),
            voices: path.join(dir, 'voices.bin'),
            tokens: path.join(dir, 'tokens.txt'),
            dataDir: path.join(dir, 'espeak-ng-data'),
            ...(lexiconPath() ? { lexicon: lexiconPath()! } : {}),
          },
          debug: false,
          numThreads: 1,
          provider: 'cpu',
        },
        // No maxNumSentences: the addon logs "max_num_sentences != 1 is
        // ignored for Kokoro TTS models" and always synthesizes whatever text
        // it's given as one continuous utterance regardless of this setting.
        // Real prosody continuity across sentences therefore comes from the
        // *caller* sending multiple sentences per request, not this option —
        // see chatStore.ts's sentence-batching before speakChunk().
      });
    } catch (e) {
      loadError = (e as Error).message;
      tts = null;
    } finally {
      loadAttempted = true;
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

export interface TtsStatus {
  available: boolean;
  error: string | null;
  sampleRate: number | null;
  sid: number;
  speed: number;
  modelVersion: string;
}

export function ttsStatus(): TtsStatus {
  return {
    available: tts !== null,
    error: loadError,
    sampleRate: tts ? tts.sampleRate : null,
    sid: VOICE_SID,
    speed: VOICE_SPEED,
    modelVersion: config.tts.modelVersion,
  };
}

// Serialize synthesis so concurrent requests don't interleave on the CPU. One
// sentence at a time is fine for a single-user free deployment; the limiter
// and this mutex together bound queue depth.
let chain: Promise<unknown> = Promise.resolve();
function enqueue(task: () => Promise<GeneratedAudio>): Promise<GeneratedAudio> {
  // Run the task whether the previous one resolved or rejected, so one bad
  // request can't stall the whole queue.
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Synthesize `text` to a 16-bit mono PCM WAV Buffer. Throws AppError(503) if
 * the model is unavailable. The AbortSignal cancels mid-synthesis.
 */
export async function synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
  await initTts();
  if (!tts) throw new AppError('TTS unavailable', 503);

  const trimmed = text.trim();
  if (!trimmed) throw new AppError('Nothing to synthesize', 400);
  if (signal.aborted) throw new AppError('TTS cancelled', 499);

  const audio = await enqueue(() =>
    // No onProgress: see the module header — the addon's progress path crashes
    // the process. Every chunk uses the same pinned female speaker id.
    tts!.generateAsync({
      text: trimmed,
      generationConfig: new GenerationConfig({
        sid: VOICE_SID,
        speed: VOICE_SPEED,
      }),
    }),
  );

  if (signal.aborted) throw new AppError('TTS cancelled', 499);
  return encodeWav(audio.samples, audio.sampleRate);
}

/** Build a 44-byte-header WAV (mono, 16-bit PCM) from float32 samples. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // float32 [-1,1] -> int16 PCM
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }
  return buffer;
}
