# Deployment

> How to deploy AI Bestie to production.

## Architecture Overview

```
┌───────────────────────────────────────────────────┐
│                    USERS                            │
│                   Browser                           │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
                       │
┌──────────────────────▼──────────────────────────────┐
│               VERCEL (Frontend)                      │
│                                                      │
│  React 19 + Vite (static build)                    │
│  - Client-side routing                             │
│  - API calls → backend via HTTPS                    │
└──────────────────────┬──────────────────────────────┘
                       │ HTTPS
                       │
┌──────────────────────▼──────────────────────────────┐
│               RENDER (Backend)                       │
│                                                      │
│  Express 5 + TypeScript                             │
│  - REST API + SSE streaming                        │
└──────┬──────────┬───────────────────────────────────┘
       │          │
       │          │
┌──────▼───┐ ┌───▼────────────────────┐ ┌──────────────────┐
│ MongoDB  │ │ Google Gemini API      │ │ Fish Audio API   │
│ (local or│ │ (free tier, primary)   │ │ (voice replies,  │
│  Atlas M0)│ │ + OpenRouter (free,    │ │  TTS)            │
│          │ │   fallback)            │ │                  │
└──────────┘ └────────────────────────┘ └──────────────────┘
```

The baseline is a free-tier deployment: no Redis, no background workers, no
paid chat-generation API, and no vector search. The backend is a single,
small Express process (no in-process models), so it fits a 512 MB Render
instance. Fish Audio (voice replies) and the optional server transcription are
the metered external paths.

## Prerequisites

### Required Accounts

| Service                  | Purpose                             | Free Tier                                 |
| ------------------------ | ----------------------------------- | ----------------------------------------- |
| MongoDB (local or Atlas) | Database                            | Local: free. Atlas M0: 512MB free         |
| Render                   | Backend hosting                     | Free tier (spins down on idle)            |
| Vercel                   | Frontend hosting                    | Free tier available                       |
| Google Cloud Console     | Google Identity Services Web client | Free                                      |
| Google AI Studio         | Gemini Flash API (primary chat)     | Free tier; quotas vary by project/model   |
| OpenRouter               | Free chat models (fallback)         | Free models with per-model RPM/daily caps |
| Fish Audio               | Voice replies (TTS)                 | `s2.1-pro-free` model; usage may be billed |

**Optional paid service:** OpenAI Whisper is used only when immersive voice
cannot use browser recognition (notably Brave). Leave `OPENAI_API_KEY` unset to
disable that fallback. Audio is authenticated, held in memory, capped at 30
seconds / 2 MiB, sent directly to OpenAI for transcription, and never logged or
persisted by AI Bestie. Usage is billed to the configured OpenAI project.

**Upgrade note:** the client now records fallback turns for up to 29.5 seconds.
Any deployment that set `TRANSCRIPTION_MAX_DURATION_MS=12000` must raise it to
`30000` or remove it (30000 is the default). Until it does, fallback turns
longer than 12 seconds are rejected with 413; voice mode stays open and shows
the error, but the user has to repeat themselves.

**Not used:** Anthropic Claude, OpenAI chat generation, Voyage embeddings,
Atlas Vector Search (needs M10+), or Redis/BullMQ workers.

### Environment Variables (Production)

```env
# Server
NODE_ENV=production
PORT=3001
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/ai-bestie
JWT_SECRET=<generate-64-char-random-string>
CLIENT_URL=https://ai-bestie.vercel.app
GOOGLE_CLIENT_ID=1234567890-example.apps.googleusercontent.com

# LLM APIs (free tiers)
GEMINI_API_KEY=...            # Google AI Studio — primary chat provider
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODELS=gemini-3.7-flash,gemini-3.5-flash-lite
GEMINI_VOICE_MODELS=gemini-3.5-flash-lite,gemini-flash-lite-latest  # voice turns only
LLM_VOICE_HEDGE_MS=2000       # voice: race the next model if no token by then
OPENROUTER_API_KEY=...        # OpenRouter — fallback (free models)
OPENROUTER_MODEL=google/gemma-4-31b-it:free

# Optional Brave/unsupported-browser transcription fallback
OPENAI_API_KEY=...
OPENAI_TRANSCRIPTION_MODEL=whisper-1
TRANSCRIPTION_MAX_DURATION_MS=30000
TRANSCRIPTION_MAX_BYTES=2097152

# TTS — Fish Audio voice replies (falls back to the browser voice without a key)
TTS_ENABLED=true
FISH_API_KEY=...
FISH_TTS_MODEL=s2.1-pro-free
FISH_VOICE_ID=711cf3ed00ab441a8f54a45058047b7a  # id from fish.audio/m/<id>
# FISH_TTS_SPEED=1    # 0.5-2.0
# FISH_TTS_LATENCY=   # low | balanced | normal
# FISH_TTS_FORMAT=mp3 # mp3 | wav | opus
# Request tuning (defaults shown)
# TTS_CONCURRENCY=4
# TTS_MAX_QUEUE=8
# TTS_QUEUE_TIMEOUT_MS=10000
# TTS_INFERENCE_TIMEOUT_MS=20000

# Voice-performance metrics (JSONL; timings/sizes/outcomes only, no content).
# Always on stdout; set a directory to also write voice-metrics-YYYY-MM-DD.jsonl.
# Defaults to server/logs outside production, off in production.
# VOICE_METRICS_DIR=
#
# Each voice turn carries one id (X-Voice-Turn header) through the browser's
# stage timeline (voice.turn.client, posted to /api/metrics/voice) and the
# server's stt.transcribe / chat.turn / tts.synth lines. Join them with:
#   npm run voice-report -w server [-- --last 20 | --file <jsonl> | --json]
# Production has no file by default: set VOICE_METRICS_DIR or save stdout and
# pass --file.

# No Anthropic, OpenAI chat-generation, Voyage, or Redis keys are used.
```

The checked-in defaults follow Google's current stable [Gemini model
catalog](https://ai.google.dev/gemini-api/docs/models) and OpenRouter's
maintained [free-model router](https://openrouter.ai/collections/free-models/).
Keep the ordered lists environment-configurable because actual free-tier
capacity and account access can differ by project and region.

Set `VITE_GOOGLE_CLIENT_ID` to that **same public Web client ID** in the
Vercel project environment before building the client. It is build-time Vite
configuration, not a secret. Google sign-in is intentionally disabled when a
deployment does not configure the client ID; password auth continues to work.

## Google Cloud Console setup

This app uses the [Google Identity Services web ID-token
flow](https://developers.google.com/identity/gsi/web/guides/overview), not an
authorization-code redirect and not a Google client secret.

1. In Google Cloud Console, configure the OAuth consent screen for the app.
2. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Choose **Web application**.
4. Add these **Authorized JavaScript origins** (scheme, host, and development
   port must match exactly):
   - local: `http://localhost:5173`
   - current production frontend: `https://ai-bestie.vercel.app`
   - add the actual custom production origin too if it differs
5. Do not add an authorized redirect URI for this popup callback flow.
6. Copy the resulting `*.apps.googleusercontent.com` value into both:
   - Render/server: `GOOGLE_CLIENT_ID`
   - Vercel/client build: `VITE_GOOGLE_CLIENT_ID`

The backend uses Google's supported Node library to [verify the ID token and
audience](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token).
It requires a verified email and keys provider identity by Google's stable
`sub`, never by a browser-decoded email claim.

**Credential handoff required after deploy:** the owner supplies one public
Web OAuth client ID and confirms the exact production frontend origin. No
client secret is required or accepted. Preview deployment URLs work only if
their exact origin is also registered; prefer a stable production domain.

## Backend Deployment (Render)

### render.yaml

```yaml
services:
  - type: web
    name: ai-bestie-api
    runtime: node
    plan: free
    # --include=dev: NODE_ENV=production would otherwise skip TypeScript.
    buildCommand: npm ci --include=dev && npm run build:server
    startCommand: npm start -w server
    healthCheckPath: /api/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: MONGODB_URI
        sync: false
      - key: JWT_SECRET
        generateValue: true
      - key: GEMINI_API_KEY
        sync: false
      - key: OPENROUTER_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: TTS_ENABLED
        value: 'true'
      - key: FISH_API_KEY
        sync: false
      - key: FISH_TTS_MODEL
        value: s2.1-pro-free
      - key: FISH_VOICE_ID
        sync: false
      - key: CLIENT_URL
        value: https://ai-bestie.vercel.app
      - key: GOOGLE_CLIENT_ID
        sync: false

# No background worker service — there is no memory-extraction job to run.
```

### Start Command

The production server runs the compiled TypeScript: `npm start -w server`
(`node dist/server.js`). Nothing native or model-sized is installed, so the
free 512 MB instance is enough.

### Build Step

```bash
# Build server
cd server && npx tsc

# Build client (for Vercel)
cd client && npm run build
```

## TTS Setup (Fish Audio)

Voice replies are synthesized by the hosted Fish Audio API
(`server/src/services/fishAudioTts.ts`), one request per speech chunk.

1. **Key**: create an API key at https://fish.audio and set `FISH_API_KEY` on
   Render. A pasted `Bearer <key>` also works.
2. **Voice**: open any voice on fish.audio (Discover, or your own clone) and
   copy the 32-character id from its URL (`fish.audio/m/<id>`) into
   `FISH_VOICE_ID` (`FISH_REFERENCE_ID` is the older name).
   `FISH_TTS_MODEL` (`s2.1-pro-free`), `FISH_TTS_SPEED` (0.5–2.0),
   `FISH_TTS_LATENCY` (`low`/`balanced`/`normal`) and `FISH_TTS_FORMAT`
   (`mp3`, `wav` or `opus`) are optional. Restart after changing any of them.
3. **Load limits**: `TTS_CONCURRENCY` (4) requests run at once;
   `TTS_MAX_QUEUE` (8) may wait — beyond that `/api/tts` answers 503 with
   `Retry-After: 1`. Waiting longer than `TTS_QUEUE_TIMEOUT_MS` (10s) or
   taking longer than `TTS_INFERENCE_TIMEOUT_MS` (20s, which also aborts the
   upstream call) answers 503, and the client skips that chunk (or uses the
   browser voice if nothing has played yet). An upstream 429 is treated like a
   full queue (503 + `Retry-After: 1`).
4. **Health & logs**: `GET /api/tts/health` (no auth, no content) reports
   availability, model, queue depth and counters. A rejected key, missing
   credit or unknown voice/model (Fish HTTP 400/401/402/403/404) is printed
   once to the server console and shown as `error` there. Each synthesis logs
   one JSON line (`evt: "tts.synth"`) with ids, text length, queue wait,
   request time and bytes — never the text.
5. **Fallback**: with no key, `TTS_ENABLED=false`, or any Fish failure,
   `/api/tts` returns 503 and the client uses the browser `speechSynthesis`
   voice — voice replies keep working, just lower quality.

**Privacy & cost**: reply text is sent to Fish Audio for synthesis, and usage
may be billed per character on paid models.

## Frontend Deployment (Vercel)

### vercel.json

```json
{
  "buildCommand": "npm run build -w client",
  "outputDirectory": "client/dist",
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://ai-bestie-api.onrender.com/api/:path*" },
    {
      "source": "/avatars/:path*",
      "destination": "https://ai-bestie-api.onrender.com/avatars/:path*"
    },
    { "source": "/:path*", "destination": "/index.html" }
  ]
}
```

The API/avatar rewrites proxy backend calls. The final catch-all is required for
direct refreshes of client routes such as `/switch-persona`; without it Vercel
returns its own 404 before React can restore the auth session and route.

### Vite Configuration

```typescript
// client/vite.config.ts
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
```

In production, Vercel's rewrite rule handles the proxy. In development, Vite's proxy forwards `/api` to the local Express server.

Set `VITE_GOOGLE_CLIENT_ID` in Vercel for Production (and Preview only when its
origin is registered in Google Cloud). Changing it requires a new client build.

## MongoDB Atlas Setup

### Cluster Configuration

1. Create an M0 (free) cluster (or run MongoDB locally for development)
2. No Atlas Vector Search index is needed — the app does not use vector search
3. Run the existing multi-conversation migration once so the former
   `expiresAt_1` TTL index cannot delete history:
   `cd server && npx tsx src/scripts/migrate-multiconvo.ts`
4. Run the idempotent authentication migration on each environment after the
   code deploy: `npm run migrate:auth -w server`. It backfills provider arrays,
   rejects credential-less users, and creates the partial unique Google-subject index.

### Connection String

```
mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/ai-bestie?retryWrites=true&w=majority
```

### Network Access

Add Render's IP addresses to Atlas Network Access (or use `0.0.0.0/0` for serverless).

## Redis Setup (not required)

Redis / BullMQ background workers are **not used**. The earlier memory-extraction
design that needed them was removed. Do not provision Redis for this phase.

## SSL & Security

### Production Headers

The server uses `helmet()` for production security headers:

```typescript
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        // Voice replies play audio fetched from /api/tts via blob: URLs.
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
  }),
);
```

### CORS

```typescript
app.use(
  cors({
    origin: process.env.CLIENT_URL, // https://ai-bestie.vercel.app
    credentials: true, // Required for cookies
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type'],
  }),
);
```

### JWT Cookie Security

```typescript
// Production cookie settings
const isProduction = process.env.NODE_ENV === 'production';

res.cookie('token', jwt, {
  httpOnly: true,
  secure: isProduction, // HTTPS only in production
  sameSite: isProduction ? 'strict' : 'lax', // CSRF protection
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  path: '/',
});
```

### Rate Limiting

```typescript
// Auth routes: 5 requests per 10 minutes per IP
authRateLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5 });

// Non-generation API routes: 10 requests per 10 seconds, keyed on userId/IP.
// The message stream path is skipped here.
apiRateLimiter = rateLimit({
  windowMs: 10 * 1000,
  max: 10,
  keyGenerator: requestKey,
  skip: isMessageStream,
});

// The one authoritative generation limit: 20 messages per minute, keyed on userId/IP.
chatRateLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, keyGenerator: requestKey });
```

Loading, listing, or switching conversation history cannot spend a generation
allowance. The client also enforces a single in-flight send so one user action
cannot emit duplicate stream requests.

## Monitoring

### Health Check Endpoint

```
GET /api/health

Response:
{
  "status": "ok",
  "timestamp": "..."
}
```

(The health check is a liveness probe; it does not poll external services.)

### Recommended Monitoring

| Metric                               | Tool             | Alert Threshold |
| ------------------------------------ | ---------------- | --------------- |
| API response time                    | Render metrics   | p99 > 2s        |
| Error rate                           | Render logs      | > 5%            |
| MongoDB connections                  | Atlas monitoring | > 80% of pool   |
| LLM API errors (Gemini/OpenRouter)   | Server logs      | > 1%            |
| Free-tier rate-limit (429) frequency | Server logs      | Spike detection |
| Rate limit violations                | Server logs      | Spike detection |

## CI/CD

### GitHub Actions

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  deploy-server:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: render-actions/deploy@v1
        with:
          service-id: ${{ secrets.RENDER_SERVICE_ID }}
          api-key: ${{ secrets.RENDER_API_KEY }}

  deploy-client:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
```

## Cost Estimates

The baseline chat deployment is designed to run at **$0**. Enabling the
optional OpenAI transcription fallback adds metered usage.

| Service                                 | Monthly Cost                    |
| --------------------------------------- | ------------------------------- |
| LLM (Gemini Flash free tier)            | Free; account/model quotas vary |
| LLM (OpenRouter free models, fallback)  | Free (per-model RPM/daily caps) |
| MongoDB (local or Atlas M0)             | Free                            |
| Render (free web service)               | Free (spins down on idle)       |
| Vercel (free tier)                      | Free                            |
| **Baseline total (without OpenAI STT)** | **$0/month**                    |

### Caveats where "free" can silently become paid

- **Render free web services** spin down on idle and have a monthly
  process-hours allowance (~750h). One always-on service fits within that; if
  you add a second always-on service (e.g. a future TTS sidecar) you may exceed
  the allowance and Render will start billing.
- **Gemini free tier** has request-per-day caps; a single user hammering the
  chat endpoint could exhaust them — the `chatRateLimiter` (20 msg/min/user)
  and the in-process 429 cooldown exist to prevent this.
- **OpenRouter free models** have tight per-model RPM and daily caps; the
  fallback chain + cooldown spreads load across them.

At scale (thousands of DAU) you would outgrow the free tiers and need paid
LLM credits, a paid Render plan, and/or a paid MongoDB M10+ tier (only if you
re-introduce vector search). That is a deliberate future decision, not the
default.
