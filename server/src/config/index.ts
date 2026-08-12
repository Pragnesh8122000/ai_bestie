import dotenv from 'dotenv';
import path from 'path';

// Load env from both the repo root and the server workspace so the key works
// whether you paste it into `/.env` or `/server/.env`. First load wins; the
// server file (more specific) is loaded first so it takes precedence.
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
  llm: {
    // Primary: Google Gemini (free tier) via its OpenAI-compatible endpoint.
    // Get a free key at https://aistudio.google.com/apikey
    // gemini-2.5-flash is deprecated for new keys (404); gemini-flash-latest is
    // Google's maintained alias that always points to the current free Flash.
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiModel: process.env.GEMINI_MODEL || 'gemini-flash-latest',
    // Free-tier Gemini fallbacks tried in order if the primary 429s persistently.
    geminiFallbackModels: (process.env.GEMINI_FALLBACK_MODELS ||
      'gemini-2.0-flash,gemini-3.5-flash')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),

    // Secondary: OpenRouter (OpenAI-compatible) — used when Gemini is unavailable
    // (no key) or all its models are rate-limited.
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemma-4-26b-a4b-it:free',
    // Free models rotate upstream rate limits; these are tried in order if the
    // primary returns a persistent 429/5xx. Override via OPENROUTER_FALLBACK_MODELS.
    openrouterFallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS ||
      'meta-llama/llama-3.3-70b-instruct:free,meta-llama/llama-3.2-3b-instruct:free,qwen/qwen3-next-80b-a3b-instruct:free')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
    // Optional: OpenAI Whisper API for speech-to-text (browser Web Speech API is the free default)
    openaiApiKey: process.env.OPENAI_API_KEY || '',
  },
  client: {
    url: process.env.CLIENT_URL || 'http://localhost:5173',
  },
  // Neural text-to-speech (Kokoro via sherpa-onnx) running in-process. Free,
  // open-source, no paid API. The ~330 MB model is NOT committed — download it
  // once with `npm run download-tts-model -w server`. If the model is absent
  // or TTS is disabled, the /api/tts endpoint returns 503 and the client falls
  // back to the browser speechSynthesis voice, so voice replies keep working.
  tts: {
    enabled: process.env.TTS_ENABLED !== 'false',
    modelDir:
      process.env.TTS_MODEL_PATH ||
      path.resolve(rootDir, 'server/.tts-models/kokoro-en-v0_19'),
    // Kokoro English v0_19 speaker id (0=af, 1=af_bella, 2=af_nicole, ...).
    // A blank value means "unset" — `Number('')` is 0, which would silently
    // pick a different voice than the intended default. ttsService validates
    // this further and only allows female speaker ids.
    sid: process.env.TTS_SID?.trim() ? Number(process.env.TTS_SID) : 2,
    maxChars: Number(process.env.TTS_MAX_CHARS ?? 1000),
  },
} as const;

export type Config = typeof config;

// Eagerly validate env on first import so a misconfigured production deploy
// crashes at boot instead of running with insecure defaults.
validateProductionEnv();
