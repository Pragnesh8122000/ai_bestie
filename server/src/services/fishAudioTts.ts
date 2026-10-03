import { config, type FishFormat } from '../config';
import { AppError } from '../utils/errors';

/**
 * The server's voice: hosted TTS via Fish Audio (https://api.fish.audio/v1/tts).
 * One request per chunk, returning the encoded audio as-is (mp3 by default) —
 * the client decodes it with decodeAudioData.
 *
 * Never log the text or the API key; ttsService logs timings only.
 */

const CONTENT_TYPES: Record<FishFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
};

export function fishContentType(format: FishFormat = config.tts.fish.format): string {
  return CONTENT_TYPES[format];
}

/** Null when Fish Audio can serve requests, else why not (no secrets). */
export function fishConfigError(): string | null {
  if (!config.tts.fish.apiKey) return 'Fish Audio TTS needs FISH_API_KEY';
  return null;
}

export class FishAudioError extends Error {
  constructor(readonly status: number) {
    super(`Fish Audio request failed (HTTP ${status})`);
    this.name = 'FishAudioError';
  }
}

/**
 * Upstream statuses that won't fix themselves (bad key, no credit, unknown
 * voice/model). Every chunk would fail the same way and the client would
 * quietly fall back to the browser voice, so they are reported loudly.
 */
const CONFIG_STATUS_HINTS: Record<number, string> = {
  400: 'check FISH_TTS_MODEL / FISH_VOICE_ID / FISH_TTS_* values',
  401: 'FISH_API_KEY was rejected — check the key and restart the server',
  402: 'the Fish Audio account has no credit for this model',
  403: 'FISH_API_KEY lacks access to this model or voice',
  404: 'FISH_VOICE_ID (or FISH_TTS_MODEL) was not found',
};

let lastConfigError: string | null = null;
const reported = new Set<number>();

/** The last persistent upstream failure, for /api/tts/health (no secrets). */
export function fishUpstreamError(): string | null {
  return lastConfigError;
}

export function isFishConfigFailure(e: unknown): e is FishAudioError {
  return e instanceof FishAudioError && e.status in CONFIG_STATUS_HINTS;
}

function noteStatus(status: number): void {
  const hint = CONFIG_STATUS_HINTS[status];
  if (!hint) return;
  lastConfigError = `Fish Audio HTTP ${status}: ${hint}`;
  if (reported.has(status)) return;
  reported.add(status);
  if (process.env.NODE_ENV !== 'test') {
    console.error(`TTS: ${lastConfigError}. Voice replies fall back to the browser voice.`);
  }
}

/**
 * Synthesize `text` with the configured Fish Audio model and voice. Aborts
 * with `signal` (client gone or inference timeout). Upstream errors surface
 * as FishAudioError; the route turns every failure into a 503 so the client
 * keeps its existing retry/fallback behaviour.
 */
export async function fishSynthesize(text: string, signal: AbortSignal): Promise<Buffer> {
  const err = fishConfigError();
  if (err) throw new AppError(err, 503);
  const { apiKey, model, voiceId, speed, latency, format, baseUrl } = config.tts.fish;

  const res = await fetch(`${baseUrl}/v1/tts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      model,
    },
    body: JSON.stringify({
      text,
      reference_id: voiceId,
      format,
      ...(speed !== undefined ? { prosody: { speed } } : {}),
      ...(latency ? { latency } : {}),
    }),
    signal,
  });
  if (!res.ok) {
    // Drain so the socket is reusable; the body may echo input, so not logged.
    await res.arrayBuffer().catch(() => undefined);
    noteStatus(res.status);
    throw new FishAudioError(res.status);
  }
  lastConfigError = null;
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new FishAudioError(res.status);
  return audio;
}
