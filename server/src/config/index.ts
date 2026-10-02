import dotenv from 'dotenv';
import path from 'path';

// Load env from both the repo root and the server workspace so the key works
// whether you paste it into `/.env` or `/server/.env`. Dotenv keeps the first
// value it sees, so the documented root file is authoritative.
const rootDir = path.resolve(__dirname, '../../..');
dotenv.config({ path: path.resolve(rootDir, '.env') });
dotenv.config({ path: path.resolve(rootDir, 'server/.env') });

const DEV_PLACEHOLDERS = new Set([
  'dev-secret-change-in-production',
  'http://localhost:5173',
  'mongodb://localhost:27017/ai-bestie',
]);

const isPlaceholder = (v: string | undefined): boolean =>
  !v || v.trim() === '' || DEV_PLACEHOLDERS.has(v);

const modelList = (value: string | undefined, defaults: string): string[] =>
  (value ?? defaults)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);

// Containers the browser can decode. (Fish's raw 'pcm' has no header, so the
// client couldn't play it; it is deliberately not offered.)
export const FISH_FORMATS = ['mp3', 'wav', 'opus'] as const;
export type FishFormat = (typeof FISH_FORMATS)[number];
const fishFormat = (value: string | undefined): FishFormat => {
  const v = value?.trim().toLowerCase() ?? '';
  return (FISH_FORMATS as readonly string[]).includes(v) ? (v as FishFormat) : 'mp3';
};

// Fish accepts prosody.speed 0.5-2.0; out-of-range values are clamped.
const fishSpeed = (value: string | undefined): number | undefined => {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) ? Math.min(2, Math.max(0.5, n)) : undefined;
};

const FISH_LATENCIES = ['low', 'balanced', 'normal'] as const;
const fishLatency = (value: string | undefined): (typeof FISH_LATENCIES)[number] | undefined => {
  const v = value?.trim().toLowerCase() ?? '';
  return (FISH_LATENCIES as readonly string[]).includes(v)
    ? (v as (typeof FISH_LATENCIES)[number])
    : undefined;
};

/**
 * Fail fast in production if required environment variables are missing or
 * still set to their insecure dev defaults. A missing JWT_SECRET here would
 * otherwise silently sign tokens with a publicly-known constant, allowing
 * anyone who reads the repo to forge a valid auth cookie.
 */
function validateProductionEnv(): void {
  if (config.nodeEnv !== 'production') return;

  const required: Array<[string, string | undefined]> = [
    ['JWT_SECRET', process.env.JWT_SECRET],
    ['CLIENT_URL', process.env.CLIENT_URL],
    ['MONGODB_URI', process.env.MONGODB_URI],
  ];

  const missing = required.filter(([, v]) => isPlaceholder(v));
  if (missing.length) {
    const names = missing.map(([n]) => n).join(', ');
    throw new Error(
      `Missing required environment variable(s) in production: ${names}. ` +
        'Set real values (not the dev defaults) before starting the server.',
    );
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/ai-bestie',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  google: {
    // Public OAuth 2.0 Web client ID shared with the SPA. An empty value keeps
    // Google sign-in safely disabled; email/password authentication still works.
    clientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
  },
  llm: {
    // Primary: Google Gemini (free tier) via its OpenAI-compatible endpoint.
    // Get a free key at https://aistudio.google.com/apikey
    // These stable identifiers are current as of 2026-09. Keep the order
    // configurable because free-tier capacity differs by account and region.
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    // Text-chat models.
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    geminiFallbackModels: modelList(
      process.env.GEMINI_FALLBACK_MODELS,
      'gemini-3.7-flash,gemini-3.5-flash-lite',
    ),
    // Voice turns use their own Gemini list: on the free tier Flash-Lite
    // usually answers in <1s where Flash often queues for 10s+ (measured
    // 2026-10). Text chat keeps the models above.
    geminiVoiceModels: modelList(
      process.env.GEMINI_VOICE_MODELS,
      'gemini-3.5-flash-lite,gemini-flash-lite-latest',
    ),
    // Voice turns hedge: if no token has arrived this long after starting a
    // model, the next one starts in parallel and the first to answer wins.
    voiceHedgeDelayMs: Math.max(250, Number(process.env.LLM_VOICE_HEDGE_MS) || 2000),

    // Secondary: OpenRouter (OpenAI-compatible) — used when Gemini is unavailable
    // (no key) or all its models are rate-limited. OpenRouter has no
    // catch-all free-router alias — each free model needs its own `:free`
    // id (verified against GET https://openrouter.ai/api/v1/models as of
    // 2026-09). Operators can override/extend via OPENROUTER_MODEL and
    // OPENROUTER_FALLBACK_MODELS as the free catalog changes.
    openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
    openrouterFallbackModels: modelList(
      process.env.OPENROUTER_FALLBACK_MODELS,
      'qwen/qwen3.8-27b:free,nvidia/nemotron-3-ultra-550b-a55b:free',
    ),
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    // Optional: OpenAI Whisper API for speech-to-text (browser Web Speech API is the free default)
    openaiApiKey: process.env.OPENAI_API_KEY || '',
  },
  transcription: {
    model: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
    maxBytes: Number(process.env.TRANSCRIPTION_MAX_BYTES || 2 * 1024 * 1024),
    maxDurationMs: Number(process.env.TRANSCRIPTION_MAX_DURATION_MS || 30_000),
  },
  // Voice-performance metrics (see utils/metricsLog.ts). Always one JSON line
  // per event on stdout; additionally appended to a daily JSONL file when a
  // directory is set. Defaults to server/logs outside production (hosted disks
  // are ephemeral, so production relies on the platform's stdout capture
  // unless VOICE_METRICS_DIR is set explicitly).
  metrics: {
    dir:
      process.env.VOICE_METRICS_DIR?.trim() ||
      (process.env.NODE_ENV === 'production' ? '' : path.resolve(rootDir, 'server/logs')),
  },
  client: {
    url: process.env.CLIENT_URL || 'http://localhost:5173',
  },
  // Voice replies (TTS) via the hosted Fish Audio API. If TTS is disabled or
  // FISH_API_KEY is missing, /api/tts returns 503 and the client falls back to
  // the browser speechSynthesis voice, so voice replies keep working.
  tts: {
    enabled: process.env.TTS_ENABLED !== 'false',
    fish: {
      // A pasted "Bearer <key>" (as in Fish's curl examples) still works.
      apiKey: (process.env.FISH_API_KEY ?? '').trim().replace(/^Bearer\s+/i, ''),
      model: process.env.FISH_TTS_MODEL?.trim() || 's2.1-pro-free',
      // The voice: a Fish Audio voice-model id (the 32-hex id in a voice's
      // fish.audio/m/<id> URL). FISH_REFERENCE_ID is the older name.
      voiceId:
        process.env.FISH_VOICE_ID?.trim() ||
        process.env.FISH_REFERENCE_ID?.trim() ||
        '711cf3ed00ab441a8f54a45058047b7a',
      // Optional; unset = Fish's defaults (speed 1, latency 'normal').
      speed: fishSpeed(process.env.FISH_TTS_SPEED),
      latency: fishLatency(process.env.FISH_TTS_LATENCY),
      format: fishFormat(process.env.FISH_TTS_FORMAT),
      baseUrl: (process.env.FISH_API_BASE_URL?.trim() || 'https://api.fish.audio').replace(
        /\/+$/,
        '',
      ),
    },
    maxChars: Number(process.env.TTS_MAX_CHARS ?? 1000),
    // Fish Audio requests in flight at once (a voice reply prefetches two
    // chunks per listener).
    concurrency: Math.max(1, Number(process.env.TTS_CONCURRENCY) || 4),
    // Requests allowed to wait for a slot before new ones get 503 + Retry-After.
    maxQueue: Math.max(1, Number(process.env.TTS_MAX_QUEUE) || 8),
    queueTimeoutMs: Math.max(1000, Number(process.env.TTS_QUEUE_TIMEOUT_MS) || 10_000),
    // Answer 503 (and abort the upstream call) if one chunk takes longer than
    // this. The client gives up at 35s overall.
    inferenceTimeoutMs: Math.max(1000, Number(process.env.TTS_INFERENCE_TIMEOUT_MS) || 20_000),
  },
} as const;

export type Config = typeof config;

// Eagerly validate env on first import so a misconfigured production deploy
// crashes at boot instead of running with insecure defaults.
validateProductionEnv();
