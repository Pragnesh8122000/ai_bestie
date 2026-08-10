# Architecture

> System architecture, data flow, and component relationships for AI Bestie.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     BROWSER (React 19)                   │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ AuthStore │  │ ChatStore│  │PersonaSt.│  │ API Cl. │ │
│  └─────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│        │             │              │              │       │
│        └─────────────┴──────────────┴──────────────┘       │
│                          │ Axios + SSE (fetch + ReadableStream)
└──────────────────────────┼──────────────────────────────────┘
                           │
                    HTTPS / Cookies
                           │
┌──────────────────────────┼──────────────────────────────────┐
│                    EXPRESS 5 SERVER                          │
│                          │                                  │
│  ┌───────────┐  ┌───────┴────────┐  ┌───────────────────┐ │
│  │  Passport  │  │   Middleware    │  │   Rate Limiters   │ │
│  │  + JWT     │  │  (Auth, CORS,   │  │  (5/10min auth,   │ │
│  │  Cookies   │  │   Helmet)      │  │  10/10s API,       │ │
│  └─────┬─────┘  └────────────────┘  │  20/min chat)     │ │
│        │                                └───────────────────┘ │
│  ┌─────┴──────────────────────────────────────────────────┐ │
│  │                    ROUTES                               │ │
│  │  /api/auth/*    /api/avatars/*    /api/personas/*      │ │
│  │  /api/conversations/*                                   │ │
│  └─────┬────────────┬──────────────┬──────────────────────┘ │
│        │            │              │                          │
│  ┌─────┴─────┐  ┌───┴────┐  ┌─────┴──────┐                    │
│  │ chatServ. │  │ persona│  │  llmServ.   │                    │
│  │ (stream)  │  │ Serv.  │  │ (Gemini +   │                    │
│  │           │  │        │  │  OpenRouter)│                    │
│  └─────┬─────┘  └────────┘  └─────┬──────┘                    │
│        │                          │                            │
└────────┼──────────────────────────┼────────────────────────────┘
         │                          │
    ┌─────┴─────┐            ┌──────┴──────────────┐
    │  MongoDB  │            │  Google Gemini       │
    │ (local or │            │  (free tier, primary)│
    │  Atlas M0)│            └─────────────────────┘
    │           │            ┌──────────────────────┐
    │  - Users  │            │  OpenRouter           │
    │  - Personas│           │  (free models,        │
    │  - Convos  │            │   fallback)           │
    │  (TTL 48h)│            └──────────────────────┘
    └───────────┘
```

No Redis, no background workers, no vector search, no embedding service.
Session memory (last 20 messages) lives in the `Conversation` document and is
sent to the LLM as the `messages` array.

## Request Lifecycle

### Chat Message Flow (the core interaction)

```
1. User types message in ChatInput
2. chatStore.sendMessage() dispatches to ConversationApi.streamMessage()
3. Fetch API sends POST /api/conversations/:id/messages/stream
4. Server: requireAuth middleware validates JWT cookie
5. Server: chatService.handleChatStream()
   a. Load Conversation document (last 20 messages)
   b. Load Persona document (archetype, traits)
   c. personaService.assembleSystemPrompt()
      - Layer 1: Identity (archetype name + purpose)
      - Layer 2: Voice (archetype-locked voiceStyle)
      - Layer 3: Rules (hard behavioral constraints)
      - Layer 4: Context (notes session memory arrives in the messages array; no retrieval)
      - Layer 5: Calibration (trait adjustments)
      - Chain-of-Persona self-check appended
   d. Append user message to Conversation (atomic $push)
   e. Build LLM messages array from the last 20 messages
   f. llmService.streamChat() calls Gemini (primary) → OpenRouter (fallback)
   g. Stream tokens via SSE events (+ 15s heartbeat, 30s timeout, abort on client disconnect):
      - { type: "state", state: "thinking" }
      - { type: "state", state: "speaking" }
      - { type: "token", content: "..." } (per token)
      - { type: "state", state: "idle" }
      - { type: "done", messageId: "..." }
   h. Append full assistant response to Conversation (atomic $push)
6. Client: chatStore parses SSE events
   - Updates streamingContent on each token
   - Updates avatarState: idle → thinking → speaking → idle
   - Appends final message to messages array
```

### Auth Flow

```
1. POST /api/auth/register
   → Validate with Zod (email, password ≥8, name)
   → Check duplicate email
   → Hash password (bcrypt, 12 rounds)
   → Create User document
   → Generate JWT → Set HTTP-only cookie
   → Return user (no password)

2. POST /api/auth/login
   → Passport local strategy (email + password)
   → bcrypt.compare verification
   → Generate JWT → Set HTTP-only cookie
   → Return user

3. GET /api/auth/me
   → requireAuth middleware extracts userId from JWT
   → Return fresh user document

4. POST /api/auth/logout
   → clearTokenCookie() removes JWT
   → Return success

5. Every protected route:
   → Cookie: token=eyJhbGci...
   → requireAuth → jwt.verify() → req.userId = decoded.id
```

## Component Relationships

### Server Services

```
chatService.ts
├── uses → llmService.streamChat()
├── uses → personaService.assembleSystemPrompt()
├── uses → Conversation model (addMessage, getRecentMessages)
├── uses → Persona model (findById, getSystemPrompt)
└── writes → SSE response directly

personaService.ts
├── uses → archetypes.ts (getArchetypeConfig)
├── calls → persona.getSystemPrompt() (5-layer + CoP assembly)
└── produces → system prompt string

llmService.ts
├── uses → fetch() to Google Gemini (OpenAI-compatible endpoint)
├── uses → fetch() to OpenRouter (free models, fallback)
├── tracks → per-model 429 cooldown (in-process Map)
└── provides → streamChat()
```

### Client Stores

```
authStore.ts (Zustand)
├── state: user, isAuthenticated, isLoading, error
├── actions: initialize, register, login, logout, clearError
└── listens: window 'auth:unauthorized' event → auto-logout

personaStore.ts (Zustand)
├── state: personas[], activePersonaId, archetypes[], isLoading, error
├── actions: fetchArchetypes, fetchPersonas, createPersona, updatePersona, deletePersona
└── writes: localStorage activePersonaId

chatStore.ts (Zustand)
├── state: conversations[], activeConversation, avatarState, isStreaming, streamingContent
├── actions: fetchConversations, openConversation, createConversation, deleteConversation, sendMessage
└── manages: SSE ReadableStream parsing, avatar state machine
```

### Data Flow Between Stores

```
authStore.initialize()
  → GET /api/auth/me
  → On success: user set, isAuthenticated = true
  → On 401: user cleared, isAuthenticated = false

After login:
  → authStore.login()
  → On success: redirect to chat
  → chatStore.fetchConversations()

Persona creation:
  → personaStore.createPersona()
  → On success: set as activePersona
  → Navigate to chat

Chat flow:
  → chatStore.sendMessage(content)
  → avatarState = 'thinking'
  → POST /api/conversations/:id/messages/stream (SSE)
  → On token: streamingContent += token, avatarState = 'speaking'
  → On done: append message, streamingContent = '', avatarState = 'idle'
```

## Middleware Stack

Every request passes through this Express pipeline:

```
Request
  │
  ├─ helmet()              → Security headers
  ├─ cors()                → Cross-origin (CLIENT_URL)
  ├─ express.json()        → Parse JSON body
  ├─ cookieParser()        → Parse cookies
  ├─ passport.initialize()  → Passport setup
  │
  ├─ /api/*                → apiRateLimiter (10 req / 10 sec, keyed on userId/IP)
  ├─ /api/auth/*           → authRateLimiter (5 req / 10 min)
  ├─ stream endpoint       → chatRateLimiter (20 msg / min per user)
  │
  ├─ Route handler         → Zod validation → catchAsync → business logic
  │
  └─ globalErrorHandler    → Mongoose/JWT/AppError → structured JSON
```

## Error Handling

The global error handler (`errors.ts`) normalizes all errors:

| Error Type | Status | Response |
|------------|--------|----------|
| `AppError` | `error.statusCode` | `{ success: false, message, errors? }` |
| `ZodError` | 400 | `{ success: false, message: "Validation error", errors: {field: msg} }` |
| Mongoose `ValidationError` | 400 | `{ success: false, message, errors: {field: msg} }` |
| MongoDB duplicate key (11000) | 409 | `{ success: false, message: "Email already registered" }` |
| `JsonWebTokenError` | 401 | `{ success: false, message: "Invalid token" }` |
| `TokenExpiredError` | 401 | `{ success: false, message: "Token expired" }` |
| Unknown errors | 500 | `{ success: false, message: "Internal server error" }` |

## Security Layers

1. **Helmet** — Sets security headers (CSP, XSS protection, etc.)
2. **CORS** — Whitelists `CLIENT_URL`, allows credentials
3. **Rate Limiting** — Per-IP for auth, per-user for API
4. **JWT HTTP-only Cookies** — Not accessible via JavaScript (XSS protection)
5. **SameSite=Lax/Strict** — CSRF protection
6. **bcrypt (12 rounds)** — Password hashing
7. **Zod Validation** — Input sanitization on all API boundaries
8. **Mongoose Validation** — Schema-level constraints
9. **User Isolation** — All queries filter by `req.userId`
