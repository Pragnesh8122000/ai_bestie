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
  // Neural text-to-speech (Kokoro via sherpa-onnx) running in-process. Free,
  // open-source, no paid API. The ~360 MB model is NOT committed — download it
  // once with `npm run download-tts-model -w server`. If the model is absent
  // or TTS is disabled, the /api/tts endpoint returns 503 and the client falls
  // back to the browser speechSynthesis voice, so voice replies keep working.
  //
  // Default is Kokoro v1.0 multi-lang (53 speakers). It replaced the older
  // kokoro-en-v0_19 (11 speakers), whose flat intonation was the main reason
  // replies sounded robotic. Set TTS_MODEL_VERSION=v0_19 (plus TTS_MODEL_PATH)
  // to A/B against the old model without a code change.
  tts: {
    enabled: process.env.TTS_ENABLED !== 'false',
    // 'v1_0' (default, 53 speakers) or 'v0_19' (legacy, 11 speakers). The
    // speaker-id space differs between them, so ttsService validates the sid
    // against the version actually in use.
    modelVersion: process.env.TTS_MODEL_VERSION?.trim() === 'v0_19' ? 'v0_19' : 'v1_0',
    modelDir:
      process.env.TTS_MODEL_PATH ||
      path.resolve(
        rootDir,
        process.env.TTS_MODEL_VERSION?.trim() === 'v0_19'
          ? 'server/.tts-models/kokoro-en-v0_19'
          : 'server/.tts-models/kokoro-multi-lang-v1_0',
      ),
    // Kokoro speaker id. For v1.0: 3=af_heart, 2=af_bella, 1=af_aoede, ...
    // A blank value means "unset" — `Number('')` is 0, which would silently
    // pick a different voice than the intended default. ttsService validates
    // this further and only allows female speaker ids.
    sid: process.env.TTS_SID?.trim() ? Number(process.env.TTS_SID) : undefined,
    // Slightly under 1.0 reads as more relaxed/human than the default clip.
    speed: Number(process.env.TTS_SPEED ?? 0.95),
    maxChars: Number(process.env.TTS_MAX_CHARS ?? 1000),
    // ONNX Runtime threads per inference. 'auto' (default) = the container's
    // CPU grant capped at 2 (1 on Linux when the grant can't be read, since
    // ORT would otherwise size itself from the *host's* cores). Measured on
    // an M5: 1 thread 0.62x real time, 2 threads 0.39x.
    numThreads: process.env.TTS_NUM_THREADS?.trim() || 'auto',
    // Inferences that may run at once. One model instance on a CPU host:
    // parallel requests only split the same cores, so keep 1 unless the host
    // has cores to spare (then raise it rather than numThreads).
    concurrency: Math.max(1, Number(process.env.TTS_CONCURRENCY) || 1),
    // Requests allowed to wait for a slot before new ones get 503 + Retry-After.
    maxQueue: Math.max(1, Number(process.env.TTS_MAX_QUEUE) || 8),
    queueTimeoutMs: Math.max(1000, Number(process.env.TTS_QUEUE_TIMEOUT_MS) || 10_000),
    // Answer 503 if one chunk's inference exceeds this (the slot stays held
    // until the native call returns). The client gives up at 35s overall.
    inferenceTimeoutMs: Math.max(1000, Number(process.env.TTS_INFERENCE_TIMEOUT_MS) || 20_000),
    // Run one short inference right after loading so the first real reply
    // doesn't pay the model's first-run cost.
    warmup: process.env.TTS_WARMUP !== 'false',
  },
} as const;

export type Config = typeof config;

// Eagerly validate env on first import so a misconfigured production deploy
// crashes at boot instead of running with insecure defaults.
validateProductionEnv();
