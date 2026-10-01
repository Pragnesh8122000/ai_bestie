# AI Bestie

> Your personalized AI companion — switch personas, converse, and learn.

AI Bestie is a full-stack web application where users switch among provisioned AI personas, interact via real-time text or immersive voice chat, and carry context through the conversation via session memory (the last 20 messages).

## ✨ Key Features

- **2 Companion Archetypes** — Friend and Mentor — each with unique voice, traits, and behavioral rules
- **5-Trait Personality Sliders** — Fine-tune directness, warmth, proactivity, depth, and accountability within archetype bounds
- **Real-Time Streaming Chat** — Token-by-token SSE streaming with Gemini Flash (free tier, primary) falling back to OpenRouter (free models), avatar state animations (idle → thinking → speaking)
- **Password + Google Sign-In** — Google Identity Services ID tokens are verified server-side, then reuse the same HTTP-only JWT session as password accounts
- **Voice Conversation** — Immersive orb-first chat with browser speech recognition and an optional authenticated OpenAI transcription fallback for Brave/unsupported browsers. Voice replies use neural TTS (Kokoro, free + open-source, in-process) and fall back to browser speech synthesis when needed.
- **Session Memory** — Last 20 messages kept in the conversation for context
- **5-Layer System Prompts** — Identity → Voice → Rules → Context → Calibration, with Chain-of-Persona self-check
- **8 Avatar Options** — Placeholder SVG avatars (Friend/Mentor)

## 🛠 Tech Stack

| Layer           | Technology                                   | Purpose                                                        |
| --------------- | -------------------------------------------- | -------------------------------------------------------------- |
| **Frontend**    | React 19 + Vite                              | SPA with hot reload                                            |
| **Styling**     | Tailwind CSS 4                               | Utility-first responsive design                                |
| **State**       | Zustand 5                                    | Lightweight client state management                            |
| **HTTP**        | Axios                                        | API client with credentials                                    |
| **Backend**     | Express 5                                    | REST API + SSE streaming                                       |
| **Database**    | MongoDB (local or Atlas free tier)           | Document store                                                 |
| **ODM**         | Mongoose 8                                   | Schema validation, hooks, virtuals                             |
| **Auth**        | Passport.js + Google Identity Services + JWT | Password/Google login, HTTP-only cookie session (7-day expiry) |
| **Validation**  | Zod 3                                        | API input validation                                           |
| **LLM (Chat)**  | Gemini Flash (free) → OpenRouter (free)      | Streaming conversation, primary + fallback                     |
| **Voice (STT)** | Web Speech API → optional OpenAI transcription | Mic → text input; bounded Brave fallback                     |
| **Voice (TTS)** | sherpa-onnx (Kokoro) → Web Speech fallback   | Text → spoken replies (neural, in-process, free)               |
| **Security**    | Helmet, CORS, Rate Limiting                  | Production hardening                                           |

## 📁 Project Structure

```
ai-bestie/
├── client/                    # React 19 + Vite frontend
│   ├── src/
│   │   ├── api/               # Axios client + API modules
│   │   │   ├── client.ts      # Base axios instance (withCredentials)
│   │   │   ├── auth.ts        # Auth API (register/login/Google/logout/me)
│   │   │   ├── avatar.ts      # Avatar list API
│   │   │   ├── conversation.ts # Conversation + SSE streaming API
│   │   │   └── persona.ts    # Persona CRUD API
│   │   ├── components/        # Reusable UI components
│   │   │   ├── ChatInput.tsx  # Auto-resize textarea + mic + send
│   │   │   ├── ChatWindow.tsx # Message list + streaming cursor + orb
│   │   │   ├── GoogleSignInButton.tsx # Google Identity Services UI
│   │   │   ├── VoiceModeControl.tsx # Accessible On/Off TTS switch
│   │   │   └── VoiceOrb.tsx   # Breathing ember orb (avatar states)
│   │   ├── pages/             # Route-level pages
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   ├── ChatPage.tsx
│   │   │   ├── SwitchPersonaPage.tsx # Existing-persona selector (creation disabled)
│   │   │   └── GuestChatPage.tsx # Read-only preview for unauthenticated guests
│   │   ├── stores/            # Zustand state stores
│   │   │   ├── authStore.ts   # Auth state (user, login, logout)
│   │   │   ├── chatStore.ts   # Chat + avatar state machine
│   │   │   └── personaStore.ts # Persona CRUD state
│   │   ├── utils/
│   │   │   ├── speech.ts      # Web Speech STT + streaming-sentence TTS
│   │   │   └── persona.ts     # Archetype display-name lookup (with fallback)
│   │   ├── styles/
│   │   │   └── globals.css    # Tailwind imports + animation keyframes
│   │   ├── App.tsx            # Routes + auth guards
│   │   └── main.tsx           # Entry point (BrowserRouter)
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
│
├── server/                    # Express 5 backend
│   ├── public/avatars/        # 12 SVG avatar images + manifest.json
│   ├── src/
│   │   ├── config/
│   │   │   ├── index.ts       # Centralized env config
│   │   │   ├── database.ts    # Mongoose connection + retry
│   │   │   └── passport.ts   # Local strategy setup
│   │   ├── data/
│   │   │   ├── archetypes.ts # 4 archetype configs (traits, voice, ranges)
│   │   │   └── avatarManifest.ts # 12 avatar entries + helpers
│   │   ├── middleware/
│   │   │   └── auth.ts       # requireAuth, optionalAuth, rate limiters
│   │   ├── models/
│   │   │   ├── User.ts        # Password/Google identities + bcrypt pre-save
│   │   │   ├── Persona.ts     # Archetype + traits + getSystemPrompt()
│   │   │   └── Conversation.ts # Messages array + soft-delete + helpers
│   │   ├── routes/
│   │   │   ├── auth.ts        # Register/login/Google/logout/me
│   │   │   ├── avatars.ts     # List + filter avatars
│   │   │   ├── personas.ts    # CRUD + archetypes endpoint
│   │   │   └── conversations.ts # CRUD + SSE streaming
│   │   ├── services/
│   │   │   ├── chatService.ts # Stream orchestration
│   │   │   ├── googleAuthService.ts # Verified ID-token identity resolution
│   │   │   ├── llmService.ts  # Gemini (primary) + OpenRouter (fallback) streaming
│   │   │   └── personaService.ts # Prompt assembly + archetype helpers
│   │   ├── validations/
│   │   │   ├── auth.ts        # Login/register Zod schemas
│   │   │   └── persona.ts    # Create/update persona Zod schemas
│   │   ├── utils/
│   │   │   ├── jwt.ts         # Sign/verify + cookie helpers
│   │   │   └── errors.ts      # AppError + catchAsync + global handler
│   │   ├── app.ts             # Express app (middleware + routes)
│   │   ├── server.ts          # Entry point (connect DB → listen)
│   │   └── seed.ts            # Test user + default persona
│   ├── tsconfig.json
│   └── package.json
│
├── docs/                      # Documentation
│   ├── phase-1-specification.md
│   ├── architecture.md
│   ├── api-reference.md
│   ├── memory-system.md
│   ├── persona-system.md
│   └── deployment.md
│
├── package.json               # Monorepo root (workspaces)
└── .env.example               # Environment variables template
```

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+
- **MongoDB** 6+ (local or Atlas)
- **Gemini API key** (free tier at [aistudio.google.com](https://aistudio.google.com/apikey)) — primary chat model
- **OpenRouter API key** (free tier works) — fallback chat provider

- **OpenAI API key is optional.** It is used only for the bounded server transcription fallback when immersive voice runs in Brave or another browser without working Web Speech recognition.
- **npm** 10+

### 1. Clone & Install

```bash
git clone <repo-url> ai-bestie
cd ai-bestie
npm install
```

### 2. Environment Setup

```bash
# The server reads the repository root .env.
cp .env.example .env

# Vite reads client-local environment files. Copy the same public Google Web
# client ID here when Google sign-in is enabled.
printf 'VITE_GOOGLE_CLIENT_ID=%s\n' '1234567890-example.apps.googleusercontent.com' > client/.env.local
```

Edit `.env` with your values:

```env
PORT=3001
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/ai-bestie
JWT_SECRET=your-secret-key-change-in-production
CLIENT_URL=http://localhost:5173

# Optional Google sign-in — same public Web OAuth client ID in both places.
# No Google client secret is used by this SPA flow.
GOOGLE_CLIENT_ID=1234567890-example.apps.googleusercontent.com
VITE_GOOGLE_CLIENT_ID=1234567890-example.apps.googleusercontent.com

# LLM — Gemini Flash is the PRIMARY chat model (free tier, get a key at https://aistudio.google.com/apikey)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-3.8-flash
GEMINI_FALLBACK_MODELS=gemini-3.7-flash,gemini-3.5-flash-lite

# LLM — OpenRouter is the FALLBACK provider (free, https://openrouter.ai/keys)
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=google/gemma-4-31b-it:free

# Optional Brave voice fallback (paid external processing)
OPENAI_API_KEY=
OPENAI_TRANSCRIPTION_MODEL=whisper-1
```

### 3. Start MongoDB

```bash
# Local MongoDB
mongod --dbpath /path/to/data

# Or use MongoDB Atlas connection string in MONGODB_URI
```

### 4. Seed the Database

Set `SEED_USER_EMAIL` and `SEED_USER_PASSWORD` in your local `.env` (never commit them), then:

```bash
npm run seed
```

This creates that test user with a default Mentor persona named "Atlas". Seeding is refused when `NODE_ENV=production`.

### 5. Start Development

```bash
# Start both server + client
npm run dev

# Or start separately:
npm run dev:server   # Express on :3001
npm run dev:client   # Vite on :5173
```

### 6. Open the App

Navigate to **http://localhost:5173**

1. Register a new account
2. Choose **Switch persona** to open one of the existing personas attached to your account
3. Start a text chat or open the orb-first **Voice chat** surface

## 🔑 Authentication Flow

```
┌──────────┐     POST /api/auth/register     ┌──────────┐
│  Register ├───────┬────────────────────────►│  Set JWT  │
└──────────┘       │   201 + user + cookie    │  Cookie    │
                    │                           └─────┬─────┘
┌──────────┐       │                                 │
│   Login   ├───────┘  POST /api/auth/login           │
└──────────┘                                          │
                                                      │
  Every subsequent request includes the cookie          │
  ┌──────────────────────────────────────────┐         │
  │  Cookie: token=eyJhbGci...              │◄────────┘
  └──────────────────────────────────────────┘
            │
            ▼
  ┌──────────────────┐
  │  requireAuth()    │  → 401 if missing/invalid
  │  middleware       │  → sets req.userId
  └──────────────────┘
```

- JWT stored in **HTTP-only cookie** (7-day expiry)
- Google Identity Services returns an ID token to the SPA; the backend verifies its signature,
  issuer, expiry, and `GOOGLE_CLIENT_ID` audience before resolving the stable Google `sub`.
- Password, Google-only, and honestly linked dual-provider accounts all receive the same cookie and
  canonical public user shape. Google sign-in stays visibly disabled if either deployment surface is
  unconfigured; password registration/login remains available.
- `SameSite=Lax` in dev, `Strict` in production
- Rate-limited: 5 auth attempts per 10 minutes, 10 non-generation API requests per 10 seconds, and
  the existing 20 chat generations per minute. Loading or switching history does not consume the
  chat-generation allowance.
- **Continue as guest** (login page) skips auth entirely — no token or session is created. Guests get a read-only preview (frozen sample transcript + public archetype browsing via `GET /api/personas/archetypes`); every write route still requires the `requireAuth` cookie above, so guest state grants no API access.

See [docs/api-reference.md](docs/api-reference.md) for full endpoint details.

## 💬 Chat Streaming Flow

```
User types message
       │
       ▼
POST /api/conversations/:id/messages/stream
  { message: "Hello!" }
       │
       ▼
┌─────────────────────────────────┐
│  chatService.handleChatStream() │
│                                 │
│  1. Load conversation + persona  │
│  2. Assemble 5-layer prompt     │
│  3. Append user message         │
│  4. Stream Gemini → OpenRouter  │
│  5. Append assistant message    │
└────────────┬────────────────────┘
             │
             ▼  SSE events:
  ┌──────────────────────────────┐
  │ data: {"type":"state","state":"thinking"}
  │                              │
  │ data: {"type":"state","state":"speaking"}
  │                              │
  │ data: {"type":"token","content":"Hello"}
  │ data: {"type":"token","content":"!"}
  │ data: {"type":"token","content":" How"} ...
  │                              │
  │ data: {"type":"state","state":"idle"}
  │ data: {"type":"done","messageId":"msg_123"}
  └──────────────────────────────┘
             │
             ▼
  Client: chatStore parses SSE
  → updates streamingContent
  → avatar state machine animates
  → appends final message
```

## 🧠 Memory

This phase uses **session memory only** — the last 20 messages are kept in the
conversation document and passed to the LLM as context. The earlier 3-layer
memory system (episodic summaries + semantic vector search) was removed because
its extraction worker was never wired up, so retrieval always returned empty.

## 🔊 Voice Replies (neural TTS)

Voice replies use **Kokoro** via `sherpa-onnx-node` — a high-quality neural TTS
that runs **in-process** (no sidecar, no paid API, Apache-2.0). Toggle the
explicit **Voice replies · On/Off** switch in the chat sidebar or header; spoken
replies stream sentence-by-sentence.

The default model is **Kokoro v1.0 multi-lang** (53 speakers). It replaced the
older English-only `kokoro-en-v0_19`, whose flat, sentence-by-sentence
intonation was the main reason replies sounded robotic.

The ~360 MB model is **not committed** to the repo. Download it once (gitignored):

```bash
npm run download-tts-model -w server   # → server/.tts-models/kokoro-multi-lang-v1_0/

# To A/B against the old model:
TTS_MODEL_VERSION=v0_19 npm run download-tts-model -w server
```

Then start the server as usual — the boot log will print `TTS: Kokoro loaded`.
If the model is absent or `TTS_ENABLED=false`, the `/api/tts` endpoint returns
503 and the client **automatically falls back** to the browser's built-in
`speechSynthesis` voice, so voice replies keep working (just lower quality).

### One voice, always

Sam speaks with exactly **one female voice** per session — the two engines are
never mixed mid-reply:

- **Server:** `TTS_SID` is validated against the _English female_ Kokoro
  speaker ids for the model version in use (v1.0: 0-10, 20-23; v0_19: 0-4, 7,
  8). A male, non-English, or invalid id falls back to the default (v1.0: `3` =
  af_heart) instead of silently changing the character's voice or language.
- **Client:** the engine (neural vs browser) is chosen by the first chunk that
  actually produces audio and then **locked** for the session. A transient
  `/api/tts` failure mid-reply skips that sentence rather than speaking it in a
  different voice. The browser fallback picks a known female voice and never a
  male one.

Verify it end-to-end against a running server (drives the real client module):

```bash
TTS_TOKEN=<auth-jwt> npm run verify-voice -w server
# → PASS: exactly one voice (remote) for the whole reply
```

Unit coverage for the same guarantee lives in `client/src/utils/speech.test.ts`.

The native addon needs its shared libraries on the linker path; the `dev` and
`start` scripts handle this automatically via `server/scripts/with-tts-env.cjs`.
On a custom start command (e.g. Render), set `LD_LIBRARY_PATH` — see
[docs/deployment.md](docs/deployment.md#tts-setup).

> **Render free-tier note:** the FP32 Kokoro model can use ~450–650 MB resident
> RAM, which may exceed a 512 MB free instance. If it OOMs, switch
> `TTS_MODEL_PATH` to the int8-quantized Kokoro model (smaller) — no code change.
> Local development is unaffected (your dev machine has plenty of RAM).

## 🎭 Persona System

See [docs/persona-system.md](docs/persona-system.md) for the full 5-layer prompt architecture.

| Archetype     | Voice                   | Trait Range                                      | Best For               |
| ------------- | ----------------------- | ------------------------------------------------ | ---------------------- |
| **Mentor**    | Wise, measured          | Direct 5-9, Warm 4-8, Deep 6-10                  | Growth, career advice  |
| **Friend**    | Casual, warm            | Warm 7-10, Direct 2-6, Depth 3-7                 | Emotional support, fun |

## 🧪 Available Scripts

| Script                                 | Description                                                              |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `npm run dev`                          | Start server + client concurrently                                       |
| `npm run dev:server`                   | Start Express server (port 3001)                                         |
| `npm run dev:client`                   | Start Vite dev server (port 5173)                                        |
| `npm run build`                        | Build both server + client for production                                |
| `npm run lint`                         | Lint both workspaces                                                     |
| `npm run test`                         | Run tests in both workspaces                                             |
| `npm run seed`                         | Seed database with test data                                             |
| `npm run migrate:auth -w server`       | Idempotently backfill auth providers and create the Google subject index |
| `npm run download-tts-model -w server` | Download the Kokoro TTS model (~360 MB, one-time, gitignored)            |

## 📋 Environment Variables

| Variable                        | Required | Description                                                                                                                                                                           |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                          | No       | Server port (default: 3001)                                                                                                                                                           |
| `NODE_ENV`                      | No       | Environment (default: development)                                                                                                                                                    |
| `MONGODB_URI`                   | Yes      | MongoDB connection string                                                                                                                                                             |
| `JWT_SECRET`                    | Yes      | Secret for signing JWT tokens                                                                                                                                                         |
| `JWT_EXPIRES_IN`                | No       | Token expiry (default: 7d)                                                                                                                                                            |
| `GOOGLE_CLIENT_ID`              | No       | Public Google Web OAuth client ID used by the server as the ID-token audience. Must match the client value.                                                                           |
| `VITE_GOOGLE_CLIENT_ID`         | No       | The same public Web OAuth client ID, embedded into the Vite build for the GIS button. Not a secret.                                                                                   |
| `GEMINI_API_KEY`                | Yes*     | Gemini key — primary chat provider                                                                                                                                                    |
| `GEMINI_MODEL`                  | No       | Gemini model id (default: `gemini-3.8-flash`)                                                                                                                                         |
| `GEMINI_FALLBACK_MODELS`        | No       | Ordered, de-duplicated Gemini fallbacks (default: `gemini-3.7-flash,gemini-3.5-flash-lite`)                                                                                           |
| `OPENROUTER_API_KEY`            | Yes*     | OpenRouter key — fallback chat provider                                                                                                                                               |
| `OPENROUTER_MODEL`              | No       | OpenRouter model id (default: `google/gemma-4-31b-it:free`)                                                                                                                           |
| `OPENROUTER_FALLBACK_MODELS`    | No       | Ordered, de-duplicated OpenRouter fallbacks (default: `qwen/qwen3.8-27b:free,nvidia/nemotron-3-ultra-550b-a55b:free`)                                                                 |
| `OPENAI_API_KEY`                | No       | Enables the paid, bounded server transcription fallback for Brave/unsupported immersive voice; browser recognition remains the free first choice.                                     |
| `OPENAI_TRANSCRIPTION_MODEL`    | No       | Transcription model (default: `whisper-1`)                                                                                                                                            |
| `TRANSCRIPTION_MAX_DURATION_MS` | No       | Maximum declared voice clip duration (default: 30000)                                                                                                                                 |
| `TRANSCRIPTION_MAX_BYTES`       | No       | Maximum raw audio upload bytes (default: 2097152)                                                                                                                                     |
| `TTS_ENABLED`                   | No       | Enable neural TTS (default: `true`). If the model isn't downloaded, voice replies fall back to the browser voice.                                                                     |
| `TTS_MODEL_VERSION`             | No       | Kokoro release: `v1_0` (default, 53 speakers) or `v0_19` (legacy, English-only). Also selects the default model path and the valid `TTS_SID` range.                                   |
| `TTS_MODEL_PATH`                | No       | Path to the Kokoro model dir (default: `server/.tts-models/kokoro-multi-lang-v1_0`). Override only for a custom/int8 model.                                                           |
| `TTS_SID`                       | No       | Kokoro speaker id (v1.0 default: `3` = af_heart). English female ids: 0=af_alloy, 1=af_aoede, 2=af_bella, 3=af_heart, 5=af_kore, 6=af_nicole, 7=af_nova, 9=af_sarah, 20-23 = British. |
| `TTS_SPEED`                     | No       | Speaking rate (default: `0.95`, clamped to 0.7-1.3). Below 1.0 sounds more relaxed and less clipped.                                                                                  |
| `TTS_MAX_CHARS`                 | No       | Max characters per TTS request (default: 1000)                                                                                                                                        |
| `CLIENT_URL`                    | No       | Frontend URL for CORS (default: http://localhost:5173)                                                                                                                                |

> *At least one of `GEMINI_API_KEY` or `OPENROUTER_API_KEY` is required for chat to work. Gemini is tried first; OpenRouter is the fallback.

## 📄 License

Private — All rights reserved.# ai_bestie

# ai_bestie
