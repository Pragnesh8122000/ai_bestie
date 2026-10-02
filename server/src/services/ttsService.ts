import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { OfflineTts, GenerationConfig, type GeneratedAudio } from 'sherpa-onnx-node';
import { config } from '../config';
import { AppError } from '../utils/errors';
import { logMetric } from '../utils/metricsLog';
import { TtsQueue } from './ttsQueue';
import { speakableText } from './ttsText';
import {
  fishConfigError,
  fishContentType,
  fishSynthesize,
  fishUpstreamError,
} from './fishAudioTts';

/**
 * In-process neural TTS via sherpa-onnx (Kokoro v1.0 by default, v0_19
 * optional). Runs inside the Express server — no sidecar, no second always-on
 * service — so the app stays within the Render free process-hour budget.
 *
 * The model is loaded once at boot as a process-wide singleton and warmed
 * with one short inference. Synthesis uses `generateAsync` (not the
 * synchronous `generate`), which runs inference on the addon's worker thread
 * so the event loop stays free — measured: the event loop never lagged more
 * than ~30ms during inference, so a chat SSE stream's heartbeat keeps firing.
 * Inference goes through a bounded queue (ttsQueue.ts) with queue-wait and
 * inference timeouts, so load or a stuck call surfaces as a fast 503 instead
 * of an ever-growing backlog.
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
 *
 * TTS_PROVIDER=fishaudio swaps the engine for the hosted Fish Audio API
 * (fishAudioTts.ts): Kokoro is then never loaded, and the same queue,
 * timeouts, cancellation, counters and log lines apply to its requests.
 */

const PROVIDER = config.tts.provider;

let tts: OfflineTts | null = null;
let fishReady = false;
let loadAttempted = false;
let loadError: string | null = null;
let loadingPromise: Promise<void> | null = null;
let warm = false;
let loadMs: number | null = null;

// Counters for /api/tts/health — process lifetime, never any text.
const counters = { ok: 0, cancelled: 0, busy: 0, timeouts: 0, failures: 0 };
let lastInferMs: number | null = null;
let lastRtf: number | null = null;

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
  return typeof sid === 'number' && Number.isInteger(sid) && allowed.includes(sid) ? sid : fallback;
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

/** CPUs this process may use: the cgroup quota on Linux, else the machine's. */
export function availableCpus(): number {
  if (process.platform !== 'linux') return os.availableParallelism();
  try {
    // cgroup v2: "max 100000" (no limit) or "<quota> <period>".
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota === 'max') return os.availableParallelism();
    return Number(quota) / Number(period);
  } catch {
    /* not cgroup v2 */
  }
  try {
    const quota = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_quota_us', 'utf8'));
    const period = Number(fs.readFileSync('/sys/fs/cgroup/cpu/cpu.cfs_period_us', 'utf8'));
    return quota > 0 ? quota / period : os.availableParallelism();
  } catch {
    // Unknown container budget: ONNX Runtime would size itself from the
    // host's cores, which oversubscribes a small CPU share. Stay at one.
    return 1;
  }
}

/**
 * ONNX Runtime intra-op threads. TTS_NUM_THREADS wins when it is a positive
 * integer (capped at 8); 'auto' uses the CPU grant, capped at 2 — measured on
 * an M5, 2 threads cut inference from 0.62x to 0.39x real time and 4 threads
 * only to 0.30-0.43x while taking cores from the event loop and other users.
 */
export function resolveNumThreads(raw: string = config.tts.numThreads): number {
  const n = Number(raw);
  if (raw !== 'auto' && Number.isInteger(n) && n >= 1) return Math.min(n, 8);
  return Math.max(1, Math.min(2, Math.floor(availableCpus())));
}

const NUM_THREADS = resolveNumThreads();

const queue = new TtsQueue(config.tts.concurrency, config.tts.maxQueue, config.tts.queueTimeoutMs);

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
      if (PROVIDER === 'fishaudio') {
        loadError = fishConfigError();
        fishReady = loadError === null;
        warm = true;
        return;
      }
      if (!modelFilesPresent()) {
        loadError = `Kokoro model not found at ${config.tts.modelDir}`;
        return;
      }
      const dir = config.tts.modelDir;
      const startedAt = Date.now();
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
          numThreads: NUM_THREADS,
          provider: 'cpu',
        },
        // No maxNumSentences: the addon logs "max_num_sentences != 1 is
        // ignored for Kokoro TTS models" and always synthesizes whatever text
        // it's given as one continuous utterance regardless of this setting.
        // Real prosody continuity across sentences therefore comes from the
        // *caller* sending multiple sentences per request, not this option —
        // see chatStore.ts's sentence-batching before speakChunk().
      });
      loadMs = Date.now() - startedAt;
      if (config.tts.warmup) void warmUp();
      else warm = true;
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

/**
 * One short inference through the normal queue, so the first real reply
 * doesn't pay first-run costs (espeak data load, ONNX Runtime allocations).
 * Measured ~50-130ms saved on the first chunk on an M5; more on a cold
 * container. Queued first, so a real request waits at most one short job.
 */
async function warmUp(): Promise<void> {
  if (!tts) return;
  const startedAt = Date.now();
  try {
    await queue.run(() =>
      tts!.generateAsync({
        text: 'Hi.',
        generationConfig: new GenerationConfig({ sid: VOICE_SID, speed: VOICE_SPEED }),
      }),
    );
    logTts({ evt: 'tts.warmup', outcome: 'ok', inferMs: Date.now() - startedAt });
  } catch (e) {
    logTts({ evt: 'tts.warmup', outcome: 'error', errorCategory: (e as Error).name });
  } finally {
    warm = true;
  }
}

function isAvailable(): boolean {
  return PROVIDER === 'fishaudio' ? fishReady : tts !== null;
}

export interface TtsStatus {
  provider: typeof PROVIDER;
  available: boolean;
  error: string | null;
  /** Last persistent hosted-provider failure (bad key, no credit, ...). */
  upstreamError: string | null;
  sampleRate: number | null;
  sid: number;
  speed: number;
  modelVersion: string;
  numThreads: number;
  warm: boolean;
  loadMs: number | null;
  queue: ReturnType<TtsQueue['stats']>;
  counters: typeof counters;
  lastInferMs: number | null;
  lastRtf: number | null;
}

export function ttsStatus(): TtsStatus {
  return {
    provider: PROVIDER,
    available: isAvailable(),
    error: loadError,
    upstreamError: PROVIDER === 'fishaudio' ? fishUpstreamError() : null,
    sampleRate: tts ? tts.sampleRate : null,
    sid: VOICE_SID,
    speed: VOICE_SPEED,
    modelVersion: PROVIDER === 'fishaudio' ? config.tts.fish.model : config.tts.modelVersion,
    numThreads: NUM_THREADS,
    warm,
    loadMs,
    queue: queue.stats(),
    counters: { ...counters },
    lastInferMs,
    lastRtf,
  };
}

/** Correlation ids for one request's log line. Never the text itself. */
export interface TtsLogContext {
  reqId?: string;
  userId?: string;
  turnId?: string;
  generation?: string;
  chunk?: string;
  lang?: string;
}

/**
 * One structured JSON line per synthesis (skipped under test). Contains
 * sizes and timings only — never the text or audio, which are the user's
 * private conversation.
 */
export function logTts(fields: Record<string, unknown>): void {
  const { evt = 'tts', ...rest } = fields;
  logMetric(String(evt), { provider: PROVIDER, ...rest });
}

export class TtsTimeoutError extends Error {
  constructor() {
    super('TTS inference timed out');
    this.name = 'TtsTimeoutError';
  }
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
  /** Null when the provider returns compressed audio of unknown length. */
  audioMs: number | null;
  queueWaitMs: number;
  inferMs: number;
}

/** One finished inference, before encoding/accounting. */
interface RawAudio {
  audio: Buffer;
  contentType: string;
  audioMs: number | null;
}

/**
 * Synthesize `text` to audio: a 16-bit mono PCM WAV from Kokoro, or the
 * configured Fish Audio format. Throws AppError(503) if the engine is
 * unavailable, TtsBusyError / TtsQueueTimeoutError / TtsTimeoutError
 * under load, and TtsCancelledError once `signal` fires — a request whose
 * client has gone is dropped from the queue before it reaches the model.
 */
export async function synthesize(
  text: string,
  signal: AbortSignal,
  ctx: TtsLogContext = {},
): Promise<SynthesisResult> {
  await initTts();
  if (!isAvailable()) throw new AppError('TTS unavailable', 503);

  const trimmed = speakableText(text);
  if (!text.trim()) throw new AppError('Nothing to synthesize', 400);
  const model = tts;
  const base = {
    evt: 'tts.synth',
    ...ctx,
    model: PROVIDER === 'fishaudio' ? config.tts.fish.model : config.tts.modelVersion,
    voice: PROVIDER === 'fishaudio' ? config.tts.fish.voiceId : VOICE_SID,
    textLen: text.length,
  };

  // Emoji-only (or similar) input: answer with a moment of silence rather
  // than an error, so the client doesn't treat it as a failed engine.
  if (!trimmed) {
    return {
      audio: encodeWav(new Float32Array(1200), 24_000),
      contentType: 'audio/wav',
      audioMs: 50,
      queueWaitMs: 0,
      inferMs: 0,
    };
  }

  // Aborted when the client leaves or the inference timeout fires, so a
  // hosted request is actually cancelled (Kokoro's native call can't be).
  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  signal.addEventListener('abort', abortUpstream, { once: true });

  const infer = async (): Promise<RawAudio> => {
    if (PROVIDER === 'fishaudio') {
      const audio = await fishSynthesize(trimmed, upstream.signal);
      return { audio, contentType: fishContentType(), audioMs: null };
    }
    // No onProgress: see the module header — the addon's progress path
    // crashes the process. Every chunk uses the same pinned female speaker id.
    const out: GeneratedAudio = await model!.generateAsync({
      text: trimmed,
      generationConfig: new GenerationConfig({ sid: VOICE_SID, speed: VOICE_SPEED }),
    });
    return {
      audio: encodeWav(out.samples, out.sampleRate),
      contentType: 'audio/wav',
      audioMs: Math.round((out.samples.length / out.sampleRate) * 1000),
    };
  };

  const requestedAt = Date.now();
  let queueWaitMs = 0;
  let startedAt = 0;
  try {
    const { value: result } = await new Promise<{ value: RawAudio; waitMs: number }>(
      (resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        queue
          .run(
            () => {
              // Re-check at dequeue: the client may have left while waiting.
              if (signal.aborted) return Promise.reject(new AppError('TTS cancelled', 499));
              return infer();
            },
            {
              signal,
              onStart: (waitMs) => {
                queueWaitMs = waitMs;
                startedAt = Date.now();
                timer = setTimeout(() => {
                  reject(new TtsTimeoutError());
                  abortUpstream();
                }, config.tts.inferenceTimeoutMs);
              },
            },
          )
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      },
    );

    const inferMs = Date.now() - startedAt;
    const { audioMs } = result;
    if (signal.aborted) throw new AppError('TTS cancelled', 499);
    counters.ok++;
    lastInferMs = inferMs;
    lastRtf = audioMs ? +(inferMs / audioMs).toFixed(3) : null;
    logTts({
      ...base,
      outcome: 'ok',
      queueWaitMs,
      inferMs,
      audioMs,
      bytes: result.audio.length,
      rtf: lastRtf,
    });
    return { ...result, queueWaitMs, inferMs };
  } catch (e) {
    const name = (e as Error).name;
    // A hosted request aborted because the client left surfaces as AbortError.
    const cancelled =
      name === 'TtsCancelledError' ||
      (e instanceof AppError && e.statusCode === 499) ||
      (signal.aborted && name === 'AbortError');
    if (cancelled) counters.cancelled++;
    else if (name === 'TtsBusyError') counters.busy++;
    else if (name === 'TtsTimeoutError' || name === 'TtsQueueTimeoutError') counters.timeouts++;
    else counters.failures++;
    logTts({
      ...base,
      outcome: cancelled ? 'cancelled' : 'error',
      errorCategory: cancelled ? 'cancelled' : name,
      // Jobs that never left the queue report how long they waited in it.
      queueWaitMs: startedAt ? queueWaitMs : Date.now() - requestedAt,
      inferMs: startedAt ? Date.now() - startedAt : 0,
      ...(e instanceof Error && 'status' in e
        ? { upstreamStatus: (e as { status: number }).status }
        : {}),
    });
    throw e;
  } finally {
    signal.removeEventListener('abort', abortUpstream);
  }
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
