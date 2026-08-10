# AI Bestie

> Your personalized AI companion — create avatars, converse, and learn.

AI Bestie is a full-stack web application where users create personalized AI companions with distinct personalities, interact via real-time chat, and carry context through the conversation via session memory (the last 20 messages) that makes conversations feel continuous and context-aware.

## ✨ Key Features

- **4 Companion Archetypes** — Mentor, Friend, Therapist, Coach — each with unique voice, traits, and behavioral rules
- **5-Trait Personality Sliders** — Fine-tune directness, warmth, proactivity, depth, and accountability within archetype bounds
- **Real-Time Streaming Chat** — Token-by-token SSE streaming with Gemini Flash (free tier, primary) falling back to OpenRouter (free models), avatar state animations (idle → thinking → speaking)
- **Voice Conversation** — Mic input (browser Web Speech API) + spoken replies. Voice replies use a neural TTS (Kokoro, free + open-source, runs in-process) and automatically fall back to the browser speechSynthesis voice if the model isn't downloaded, so you can always talk to your character
- **Session Memory** — Last 20 messages kept in the conversation for context
- **5-Layer System Prompts** — Identity → Voice → Rules → Context → Calibration, with Chain-of-Persona self-check
- **12 Avatar Options** — Placeholder SVG avatars (Friend/Mentor/Therapist/Coach)

## 🛠 Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 19 + Vite | SPA with hot reload |
| **Styling** | Tailwind CSS 4 | Utility-first responsive design |
| **State** | Zustand 5 | Lightweight client state management |
| **HTTP** | Axios | API client with credentials |
| **Backend** | Express 5 | REST API + SSE streaming |
| **Database** | MongoDB (local or Atlas free tier) | Document store |
| **ODM** | Mongoose 8 | Schema validation, hooks, virtuals |
| **Auth** | Passport.js + JWT | HTTP-only cookie auth (7-day expiry) |
| **Validation** | Zod 3 | API input validation |
| **LLM (Chat)** | Gemini Flash (free) → OpenRouter (free) | Streaming conversation, primary + fallback |
| **Voice (STT)** | Web Speech API | Mic → text input |
| **Voice (TTS)** | sherpa-onnx (Kokoro) → Web Speech fallback | Text → spoken replies (neural, in-process, free) |
| **Security** | Helmet, CORS, Rate Limiting | Production hardening |

## 📁 Project Structure

```
ai-bestie/
├── client/                    # React 19 + Vite frontend
│   ├── src/
│   │   ├── api/               # Axios client + API modules
│   │   │   ├── client.ts      # Base axios instance (withCredentials)
│   │   │   ├── auth.ts        # Auth API (register/login/logout/me)
│   │   │   ├── conversation.ts # Conversation + SSE streaming API
│   │   │   └── persona.ts    # Persona CRUD API
│   │   ├── components/        # Reusable UI components
│   │   │   ├── ChatInput.tsx  # Auto-resize textarea + mic + send
│   │   │   ├── ChatWindow.tsx # Message list + streaming cursor + orb
│   │   │   └── VoiceOrb.tsx   # Breathing ember orb (avatar states)
│   │   ├── pages/             # Route-level pages
│   │   │   ├── LoginPage.tsx
│   │   │   ├── RegisterPage.tsx
│   │   │   └── ChatPage.tsx
│   │   ├── stores/            # Zustand state stores
│   │   │   ├── authStore.ts   # Auth state (user, login, logout)
│   │   │   ├── chatStore.ts   # Chat + avatar state machine
│   │   │   └── personaStore.ts # Persona CRUD state
│   │   ├── utils/
│   │   │   └── speech.ts      # Web Speech STT + streaming-sentence TTS
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
│   │   │   ├── User.ts        # Email/password + bcrypt pre-save
│   │   │   ├── Persona.ts     # Archetype + traits + getSystemPrompt()
│   │   │   └── Conversation.ts # Messages array + TTL + helpers
│   │   ├── routes/
│   │   │   ├── auth.ts        # Register/login/logout/me
│   │   │   ├── avatars.ts     # List + filter avatars
│   │   │   ├── personas.ts    # CRUD + archetypes endpoint
│   │   │   └── conversations.ts # CRUD + SSE streaming
│   │   ├── services/
│   │   │   ├── chatService.ts # Stream orchestration
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

> Note: `gemini-2.5-flash` was deprecated for new API keys (returns 404). The app uses `gemini-flash-latest` — Google's maintained alias that always points to the current free-tier Flash model.
- **npm** 10+

### 1. Clone & Install

```bash
git clone <repo-url> ai-bestie
cd ai-bestie
npm install
```

### 2. Environment Setup

```bash
cp .env.example server/.env
```

Edit `server/.env` with your values:

```env
PORT=3001
NODE_ENV=development
MONGODB_URI=mongodb://localhost:27017/ai-bestie
JWT_SECRET=your-secret-key-change-in-production
CLIENT_URL=http://localhost:5173

# LLM — Gemini Flash is the PRIMARY chat model (free tier, get a key at https://aistudio.google.com/apikey)
GEMINI_API_KEY=your-gemini-api-key
GEMINI_MODEL=gemini-flash-latest

# LLM — OpenRouter is the FALLBACK provider (free, https://openrouter.ai/keys)
OPENROUTER_API_KEY=your-openrouter-api-key
OPENROUTER_MODEL=google/gemma-4-26b-a4b-it:free
```

### 3. Start MongoDB

```bash
# Local MongoDB
mongod --dbpath /path/to/data

# Or use MongoDB Atlas connection string in MONGODB_URI
```

### 4. Seed the Database

```bash
npm run seed
```

This creates a test user: `test@aibestie.com` / `password123` with a default Mentor persona named "Atlas".

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
2. Create your first companion (choose archetype → avatar → traits → name)
3. Start chatting!

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
- `SameSite=Lax` in dev, `Strict` in production
- Rate-limited: 5 auth attempts per 10 minutes, 10 API requests per 10 seconds

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
that runs **in-process** (no sidecar, no paid API, Apache-2.0). Toggle "voice
replies" on in the chat header; Sam's spoken replies stream sentence-by-sentence.

The ~330 MB model is **not committed** to the repo. Download it once (gitignored):

```bash
npm run download-tts-model -w server   # → server/.tts-models/kokoro-en-v0_19/
```

Then start the server as usual — the boot log will print `TTS: Kokoro loaded`.
If the model is absent or `TTS_ENABLED=false`, the `/api/tts` endpoint returns
503 and the client **automatically falls back** to the browser's built-in
`speechSynthesis` voice, so voice replies keep working (just lower quality).

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

| Archetype | Voice | Trait Range | Best For |
|-----------|-------|-------------|----------|
| **Mentor** | Wise, measured | Direct 5-9, Warm 4-8, Deep 6-10 | Growth, career advice |
| **Friend** | Casual, warm | Warm 7-10, Direct 2-6, Depth 3-7 | Emotional support, fun |
| **Therapist** | Reflective, gentle | Warm 5-9, Direct 1-5, Depth 7-10 | Self-exploration |
| **Coach** | Direct, action-oriented | Direct 6-10, Proactive 7-10, Accountability 7-10 | Goals, habits |

## 🧪 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start server + client concurrently |
| `npm run dev:server` | Start Express server (port 3001) |
| `npm run dev:client` | Start Vite dev server (port 5173) |
| `npm run build` | Build both server + client for production |
| `npm run lint` | Lint both workspaces |
| `npm run test` | Run tests in both workspaces |
| `npm run seed` | Seed database with test data |
| `npm run download-tts-model -w server` | Download the Kokoro TTS model (~330 MB, one-time, gitignored) |

## 📋 Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3001) |
| `NODE_ENV` | No | Environment (default: development) |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `JWT_SECRET` | Yes | Secret for signing JWT tokens |
| `JWT_EXPIRES_IN` | No | Token expiry (default: 7d) |
| `GEMINI_API_KEY` | Yes* | Gemini key — primary chat provider |
| `GEMINI_MODEL` | No | Gemini model id (default: `gemini-flash-latest`; `gemini-2.5-flash` is deprecated for new keys) |
| `GEMINI_FALLBACK_MODELS` | No | Gemini models tried if the primary 429s (default: `gemini-2.0-flash,gemini-3.5-flash`) |
| `OPENROUTER_API_KEY` | Yes* | OpenRouter key — fallback chat provider |
| `OPENROUTER_MODEL` | No | OpenRouter model id (default: `google/gemma-4-26b-a4b-it:free`) |
| `OPENROUTER_FALLBACK_MODELS` | No | OpenRouter models tried in order if the primary 429s |
| `OPENAI_API_KEY` | No | Not used. The OpenAI Whisper API is a *paid* STT service with no permanent free tier, so it is intentionally not integrated; the browser Web Speech API is the free STT default. |
| `TTS_ENABLED` | No | Enable neural TTS (default: `true`). If the model isn't downloaded, voice replies fall back to the browser voice. |
| `TTS_MODEL_PATH` | No | Path to the Kokoro model dir (default: `server/.tts-models/kokoro-en-v0_19`). Override only to use the int8 model. |
| `TTS_SID` | No | Kokoro speaker id (default: `2` = af_nicole). 0=af, 1=af_bella, 2=af_nicole, … |
| `TTS_MAX_CHARS` | No | Max characters per TTS request (default: 1000) |
| `CLIENT_URL` | No | Frontend URL for CORS (default: http://localhost:5173) |

> *At least one of `GEMINI_API_KEY` or `OPENROUTER_API_KEY` is required for chat to work. Gemini is tried first; OpenRouter is the fallback.

## 📄 License

Private — All rights reserved.# ai_bestie
