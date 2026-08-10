# Data Models

> MongoDB schemas, relationships, indexes, and data lifecycle.

## Entity Relationship Diagram

```
┌──────────┐       ┌──────────┐       ┌──────────────┐
│   User    │1────*│  Persona  │1────*│ Conversation  │
│           │      │           │      │               │
│ _id       │      │ _id       │      │ _id           │
│ email     │      │ userId ──►│      │ userId ──►    │
│ password  │      │ name      │      │ personaId ──► │
│ name      │      │ archetype │      │ avatarId      │
│ activeP.  │      │ avatarId  │      │ title         │
│ prefs     │      │ traits{}  │      │ messages[]    │
└──────────┘      └──────────┘      │ lastMessageAt │
                                       │ expiresAt    │
                                       └──────────────┘

Only three collections: User, Persona, Conversation. There are no
SemanticMemory / EpisodicMemory collections (that memory design was removed).
```

---

## User Model

**File:** `server/src/models/User.ts`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `email` | String | required, unique, lowercase, trimmed | User's email |
| `password` | String | required, min 8 chars | bcrypt-hashed password |
| `name` | String | required, trimmed | Display name |
| `authProvider` | String | default: 'local' | Auth provider (future: Google) |
| `activePersonaId` | ObjectId | ref: Persona | Currently selected persona |
| `preferences` | Mixed | default: {} | User preferences (theme, etc.) |
| `createdAt` | Date | auto | Creation timestamp |
| `updatedAt` | Date | auto | Last update timestamp |

**Hooks:**
- `pre('save')` — Hashes password with bcrypt (12 salt rounds) if modified
- `post('save')` — Error handler for duplicate key (11000) → throws AppError(409)

**Methods:**
- `comparePassword(candidate)` — bcrypt comparison, returns boolean

**Indexes:**
- `{ email: 1 }` — unique, for login lookup

---

## Persona Model

**File:** `server/src/models/Persona.ts`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `userId` | ObjectId | required, ref: User | Owner of this persona |
| `name` | String | required, trimmed, max 50 | Persona's display name |
| `archetype` | String | required, enum: mentor/friend/therapist/coach | Behavioral template |
| `avatarId` | String | required | Reference to avatar in manifest |
| `traits` | Embedded Doc | required | 5 personality sliders |
| `traits.directness` | Number | required, 1-10, default: archetype default | How direct the persona is |
| `traits.warmth` | Number | required, 1-10, default: archetype default | How warm/emotional |
| `traits.proactivity` | Number | required, 1-10, default: archetype default | How proactive |
| `traits.depth` | Number | required, 1-10, default: archetype default | Response depth |
| `traits.accountability` | Number | required, 1-10, default: archetype default | How strictly accountable |
| `createdAt` | Date | auto | Creation timestamp |
| `updatedAt` | Date | auto | Last update timestamp |

**Hooks:**
- `pre('save')` — Clamps each trait to its archetype's min/max range (see [Persona System](./persona-system.md))

**Methods:**
- `getSystemPrompt()` — Assembles the 5-layer system prompt from archetype config + traits (no memory-retrieval argument; session context arrives via the messages array)

**Indexes:**
- `{ userId: 1 }` — for listing user's personas

**Example document:**
```json
{
  "_id": "64f2a3b4c5d6e7f8a9b0c1d2",
  "userId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "name": "Atlas",
  "archetype": "mentor",
  "avatarId": "mentor-male-01",
  "traits": {
    "directness": 7,
    "warmth": 6,
    "proactivity": 7,
    "depth": 8,
    "accountability": 7
  },
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

---

## Conversation Model

**File:** `server/src/models/Conversation.ts`

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| `userId` | ObjectId | required, ref: User | Owner |
| `personaId` | ObjectId | required, ref: Persona | Associated persona |
| `avatarId` | String | required | Avatar for this conversation |
| `title` | String | default: 'New Conversation' | Conversation title |
| `messages` | [Embedded] | | Array of message sub-documents |
| `messages.role` | String | required, enum: user/assistant | Message sender |
| `messages.content` | String | required | Message text |
| `messages.timestamp` | Date | default: Date.now | When sent |
| `messages.tokenCount` | Number | default: 0 | Token count (reserved for future use) |
| `lastMessageAt` | Date | default: Date.now | Last activity time |
| `expiresAt` | Date | default: 48h from now | TTL index |
| `createdAt` | Date | auto | Creation timestamp |
| `updatedAt` | Date | auto | Last update timestamp |

**Important:** Message sub-documents use `_id: false` to reduce document size.

**Hooks:**
- TTL index on `expiresAt` — MongoDB auto-deletes conversations after 48 hours

**Methods:**
- `addMessage(role, content, tokenCount?)` — Push a message with defaults
- `getRecentMessages(limit = 20)` — Return last N messages for context window

> Note: `chatService` appends messages with atomic `$push`/`$set` updates rather
> than via `addMessage` + `save()`, so concurrent streams on the same
> conversation can't clobber each other.

**Indexes:**
- `{ userId: 1, lastMessageAt: -1 }` — for listing user's conversations sorted by recent
- `{ expiresAt: 1 }` — TTL index for auto-expiration

**Example document:**
```json
{
  "_id": "64f3a4b5c6d7e8f9a0b1c2d3",
  "userId": "64f1a2b3c4d5e6f7a8b9c0d1",
  "personaId": "64f2a3b4c5d6e7f8a9b0c1d2",
  "avatarId": "mentor-male-01",
  "title": "Career Advice",
  "messages": [
    {
      "role": "user",
      "content": "I'm thinking about changing careers",
      "timestamp": "2024-01-15T10:31:00Z"
    },
    {
      "role": "assistant",
      "content": "That's a big decision. What's driving this thought?",
      "timestamp": "2024-01-15T10:31:05Z",
      "tokenCount": 12
    }
  ],
  "lastMessageAt": "2024-01-15T10:31:05Z",
  "expiresAt": "2024-01-17T10:30:00Z",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

---

## Removed models (for history)

An earlier design had `SemanticMemory` and `EpisodicMemory` collections with
BSON-BinData embeddings, an Atlas Vector Search index, strength decay, and
vector-similarity deduplication. **None of that exists in the codebase.** The
extraction worker that would have populated those collections was never wired
up, so the whole memory layer was removed for the simple phase. See
[memory-system.md](./memory-system.md) for the session-memory-only model that
actually ships.

---

## Data Lifecycle

### Conversation TTL

Conversations auto-expire 48 hours after the last message via the MongoDB TTL
index on `expiresAt` (reset to `now + 48h` on each new message). This keeps the
database footprint small — important for the free-tier M0 512MB cluster. There
is no extraction into any other collection.

```
Create conversation → expiresAt = now + 48h
Each message: lastMessageAt = now, expiresAt = now + 48h (atomic $set)
MongoDB TTL thread deletes expired documents every ~60 seconds
```
