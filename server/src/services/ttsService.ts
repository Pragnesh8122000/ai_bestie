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
 * Voice replies via the hosted Fish Audio API (fishAudioTts.ts). Nothing is
 * loaded in-process, so the server stays small enough for a 512 MB host.
 *
 * Every request goes through a bounded queue (ttsQueue.ts) with queue-wait and
 * request timeouts — the timeout also aborts the upstream call — so load or a
 * stuck call surfaces as a fast 503 instead of an ever-growing backlog, and a
 * request whose client has gone is dropped before it reaches Fish Audio.
 *
 * If TTS is disabled or FISH_API_KEY is missing, `synthesize` throws
 * AppError(503) and the client falls back to browser speechSynthesis.
 */

let initialized = false;
let configError: string | null = null;

// Counters for /api/tts/health — process lifetime, never any text.
const counters = { ok: 0, cancelled: 0, busy: 0, timeouts: 0, failures: 0 };
let lastInferMs: number | null = null;

const queue = new TtsQueue(config.tts.concurrency, config.tts.maxQueue, config.tts.queueTimeoutMs);

/** Validate configuration once. Idempotent; nothing to load. */
export async function initTts(): Promise<void> {
  if (initialized) return;
  initialized = true;
  configError = config.tts.enabled ? fishConfigError() : 'TTS disabled (TTS_ENABLED=false)';
}

function isAvailable(): boolean {
  return initialized && configError === null;
}

export interface TtsStatus {
  provider: 'fishaudio';
  available: boolean;
  error: string | null;
  /** Last persistent upstream failure (bad key, no credit, unknown voice...). */
  upstreamError: string | null;
  model: string;
  queue: ReturnType<TtsQueue['stats']>;
  counters: typeof counters;
  lastInferMs: number | null;
}

export function ttsStatus(): TtsStatus {
  return {
    provider: 'fishaudio',
    available: isAvailable(),
    error: configError,
    upstreamError: fishUpstreamError(),
    model: config.tts.fish.model,
    queue: queue.stats(),
    counters: { ...counters },
    lastInferMs,
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
  logMetric(String(evt), { provider: 'fishaudio', ...rest });
}

export class TtsTimeoutError extends Error {
  constructor() {
    super('TTS request timed out');
    this.name = 'TtsTimeoutError';
  }
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
  queueWaitMs: number;
  inferMs: number;
}

/**
 * Synthesize `text` to audio in the configured Fish Audio format. Throws
 * AppError(503) if TTS is unavailable, TtsBusyError / TtsQueueTimeoutError /
 * TtsTimeoutError under load, FishAudioError for upstream failures, and
 * TtsCancelledError once `signal` fires.
 */
export async function synthesize(
  text: string,
  signal: AbortSignal,
  ctx: TtsLogContext = {},
): Promise<SynthesisResult> {
  await initTts();
  if (!isAvailable()) throw new AppError(configError ?? 'TTS unavailable', 503);

  const trimmed = speakableText(text);
  if (!text.trim()) throw new AppError('Nothing to synthesize', 400);
  const base = {
    evt: 'tts.synth',
    ...ctx,
    model: config.tts.fish.model,
    voice: config.tts.fish.voiceId,
    textLen: text.length,
  };

  // Emoji-only (or similar) input: answer with a moment of silence rather
  // than an error, so the client doesn't treat it as a failed engine.
  if (!trimmed) {
    return { audio: SILENCE_WAV, contentType: 'audio/wav', queueWaitMs: 0, inferMs: 0 };
  }

  // Aborted when the client leaves or the request timeout fires, so the
  // upstream call is actually cancelled.
  const upstream = new AbortController();
  const abortUpstream = () => upstream.abort();
  signal.addEventListener('abort', abortUpstream, { once: true });

  const requestedAt = Date.now();
  let queueWaitMs = 0;
  let startedAt = 0;
  try {
    const { value: audio } = await new Promise<{ value: Buffer; waitMs: number }>(
      (resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        queue
          .run(
            () => {
              // Re-check at dequeue: the client may have left while waiting.
              if (signal.aborted) return Promise.reject(new AppError('TTS cancelled', 499));
              return fishSynthesize(trimmed, upstream.signal);
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
    if (signal.aborted) throw new AppError('TTS cancelled', 499);
    counters.ok++;
    lastInferMs = inferMs;
    logTts({ ...base, outcome: 'ok', queueWaitMs, inferMs, bytes: audio.length });
    return { audio, contentType: fishContentType(), queueWaitMs, inferMs };
  } catch (e) {
    const name = (e as Error).name;
    // An upstream request aborted because the client left surfaces as AbortError.
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

/** 50 ms of 24 kHz mono 16-bit silence: a 44-byte WAV header plus zeroed samples. */
const SILENCE_WAV = (() => {
  const sampleRate = 24_000;
  const dataSize = 1200 * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
})();
