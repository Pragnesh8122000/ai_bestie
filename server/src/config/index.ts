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
    geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    geminiFallbackModels: modelList(
      process.env.GEMINI_FALLBACK_MODELS,
      'gemini-3.7-flash,gemini-3.5-flash-lite',
    ),

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
    maxDurationMs: Number(process.env.TRANSCRIPTION_MAX_DURATION_MS || 12_000),
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
  },
} as const;

export type Config = typeof config;

// Eagerly validate env on first import so a misconfigured production deploy
// crashes at boot instead of running with insecure defaults.
validateProductionEnv();
