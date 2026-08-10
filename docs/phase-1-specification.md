# AI Avatar Companion — Phase 1 Specification Document

> ⚠️ **SUPERSEDED.** This was the original north-star spec. The shipped phase was
> re-scoped to a simple voice chat with a single hard-coded "Friend" persona
> (Sam): no archetype wizard, no photorealistic avatars, no semantic/episodic
> memory, no vector search, free-tier LLMs only (Gemini Flash → OpenRouter).
> Keep this document for historical context only; for what actually ships see
> [architecture.md](./architecture.md), [persona-system.md](./persona-system.md),
> [memory-system.md](./memory-system.md), and [deployment.md](./deployment.md).

> **Status:** FINALIZED — North Star for Development  
> **Date:** 2025-07-05  
> **Phase:** 1 — Conceptual Definition & Product Planning  
> **Stack:** MongoDB, Express, React, Node.js (MERN) + GenAI

---

## Table of Contents

1. [Product Vision](#1-product-vision)
2. [Pillar 1: Avatar Visuals](#2-pillar-1-avatar-visuals)
3. [Pillar 2: Interaction Mode](#3-pillar-2-interaction-mode)
4. [Pillar 3: Persona System](#4-pillar-3-persona-system)
5. [Pillar 4: Learning & Problem-Solving Mechanism](#5-pillar-4-learning--problem-solving-mechanism)
6. [System Architecture](#6-system-architecture)
7. [Data Models](#7-data-models)
8. [API Surface](#8-api-surface)
9. [Technology Decisions](#9-technology-decisions)
10. [Cost Estimates](#10-cost-estimates)
11. [Phase 2 Preview](#11-phase-2-preview)
12. [Sources](#12-sources)

---

## 1. Product Vision

**One-liner:** A user creates a personalized avatar, talks to it about their problems to get solutions, converses about anything, and learns from it.

**Core loop:**
```
Choose Avatar → Set Persona → Chat (text) → Avatar Remembers → User Learns
```

**MVP scope (Phase 1):** Web-only, text-based chat with persistent memory, photorealistic avatars, and pre-made persona archetypes. Voice and video are Phase 2+.

---

## 2. Pillar 1: Avatar Visuals

### Decision: Single Photorealistic Image + CSS Animation States

The avatar is one high-quality photorealistic face per persona. Emotion is conveyed through CSS animation overlays — NOT by swapping between different expression photos.

#### Why This Approach

| Factor | Decision Rationale |
|--------|-------------------|
| **Latency** | CSS animations are local — 0ms. No API calls for expression changes. |
| **Cost** | $0 per interaction. No external avatar API (D-ID charges $0.06-0.12 per 15s of video). |
| **Mobile portability** | Single image + CSS maps directly to React Native `Animated` API. |
| **Voice-ready** | Phase 2 adds TTS audio + "speaking" waveform animation overlay. No architecture change. |
| **Emotional feedback** | Research shows conversational engagement comes from *responsive timing* (thinking → speaking transitions), not visual fidelity. CSS state changes deliver this. |

#### Avatar State Machine

```
┌─────────────────────────────────────────────┐
│                                             │
│   idle ──(user sends message)──→ thinking   │
│    ↑                                │       │
│    │                        (LLM first token) │
│    │                                ↓       │
│  listening  ←──(user starts typing)── speaking│
│    │                                ↑       │
│    └────────────────────────────────┘       │
│                                             │
│  CSS Effects:                               │
│  idle      → gentle breathing scale loop     │
│  thinking  → soft radial pulse + "..." dots │
│  speaking  → audio waveform bar animation    │
│  listening → subtle brightness increase       │
│                                             │
└─────────────────────────────────────────────┘
```

#### Avatar Gallery

```
/public/avatars/
  ├── manifest.json          # { avatars: [{ id, name, src, category }] }
  ├── mentor-male-01.webp    # AI-generated photorealistic face
  ├── mentor-male-02.webp
  ├── mentor-female-01.webp
  ├── mentor-female-02.webp
  ├── friend-male-01.webp
  ├── friend-male-02.webp
  ├── friend-female-01.webp
  ├── friend-female-02.webp
  ├── therapist-male-01.webp
  ├── therapist-female-01.webp
  ├── coach-male-01.webp
  └── coach-female-01.webp
```

- **Format:** WebP, ~200KB per face, 512×512px minimum
- **Source:** AI-generated via Midjourney / Adobe Firefly / Stable Diffusion 3
- **Style:** Neutral expression, consistent lighting, head-and-shoulders crop, solid or gradient background
- **User customization:** Gallery selection only (12 options). No user uploads in MVP (avoids moderation overhead).

#### React Component Architecture

```tsx
// The state interface that persists across Phase 1 → Phase 2 → Phase 3
type AvatarState = 'idle' | 'thinking' | 'speaking' | 'listening';
type AvatarEmotion = 'neutral' | 'happy' | 'concerned' | 'encouraging';

interface AvatarProps {
  imageSrc: string;           // From gallery manifest
  state: AvatarState;         // Driven by conversation state machine
  emotion?: AvatarEmotion;   // Derived from LLM sentiment analysis (Phase 2+)
  name: string;               // Displayed below avatar
}
```

**Phase 2 upgrade path (no architecture change):**
- Phase 1: `<Avatar state={state} imageSrc={src} />` → renders image + CSS
- Phase 2: Same component, adds TTS audio playback on `state === 'speaking'`
- Phase 3 (optional): Replace image with D-ID/HeyGen video stream — same state machine

---

## 3. Pillar 2: Interaction Mode

### Decision: Text-Only for Phase 1, Voice Additive in Phase 2

#### Text-Only MVP

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Primary mode** | Text chat | Validate product before adding voice complexity |
| **Streaming** | Token-by-token (SSE) | Expected UX for chat apps; pairs with avatar state machine |
| **Context window** | Last 20 messages | Balances cost (~$0.01-0.03 per conversation) with quality |
| **Cross-session memory** | Yes, persistent | Companion without memory is a chatbot, not a companion |
| **Rate limiting** | Yes, from day one | 10 messages per 10 seconds per user (sliding window) |

#### Streaming Architecture

```
Browser                          Server
  │                                │
  │  POST /api/chat/stream         │
  │  { message, conversationId }   │
  │ ─────────────────────────────→ │
  │                                │  1. Retrieve last 20 messages from MongoDB
  │                                │  2. Inject persona system prompt
  │                                │  3. Inject relevant semantic memories (RAG)
  │                                │  4. Call LLM with streaming
  │                                │
  │  SSE: data: {"token": "I"}     │  ← First token (200-500ms)
  │  SSE: data: {"token": " "}     │
  │  SSE: data: {"token": "hear"}  │
  │  SSE: data: {"token": " you"}   │
  │  ...                           │
  │  SSE: data: [DONE]             │
  │                                │  5. Store assistant response in MongoDB
  │                                │  6. Trigger background memory extraction
  │                                │
  │  ← Avatar state: thinking → speaking → idle
```

**Key implementation details:**

- **Express endpoint:** `POST /api/chat/stream` returns `Content-Type: text/event-stream`
- **AbortController:** Frontend can cancel streaming requests (user navigates away, sends new message)
- **Avatar state sync:** Frontend sets `state = 'thinking'` on send, switches to `'speaking'` on first token, returns to `'idle'` on `[DONE]`
- **Error handling:** If LLM stream fails, frontend shows fallback message ("I'm having trouble thinking right now. Can you try again?")

#### Cross-Session Memory (Critical for Companion Apps)

Research on Character.AI, Replika, and Pi shows that **persistent memory is the #1 differentiator** between a chatbot and a companion. Without it, users feel like strangers every session.

**Decision: Three-layer memory architecture**

```
Layer 1: Session Memory (short-term)
  - Last 20 messages injected into LLM context
  - Stored in MongoDB, embedded in conversation document
  - Never needs vector search — always retrieved by conversationId
  - TTL: expires 48 hours after last message (configurable)

Layer 2: Episodic Memory (conversation summaries)
  - After each conversation, LLM extracts key topics discussed
  - Stored as summarized episodes with metadata tags
  - Retrieved via text search (keywords) before vector search is needed
  - Used when conversation exceeds 20-message window

Layer 3: Semantic Memory (long-term facts about the user)
  - Extracted facts: "User works in marketing", "User fears public speaking"
  - Extracted preferences: "User prefers direct advice over gentle encouragement"
  - Stored with vector embeddings for semantic retrieval
  - Injected into system prompt as context before every LLM call
  - Decays if not accessed (strength score with 30-day half-life, 30% floor)
```

---

## 4. Pillar 3: Persona System

### Decision: Pre-Made Archetypes + Trait Customization Slider

Users pick from pre-made archetypes, then fine-tune with trait sliders. Pure free-text persona builder is too open-ended for MVP and leads to inconsistent behavior.

#### Pre-Made Archetypes (4 for MVP)

| Archetype | Core Trait | Voice Style | Best For |
|-----------|-----------|-------------|----------|
| **The Mentor** | Wise, direct, challenging | Authoritative but warm. Uses analogies. Asks probing questions. | Career growth, life decisions, skill development |
| **The Friend** | Warm, relatable, supportive | Casual, uses humor, validates feelings before suggesting solutions | Emotional support, daily conversation, venting |
| **The Therapist** | Calm, reflective, non-judgmental | Asks more than tells. Mirrors language. Never prescribes. | Anxiety, stress, self-reflection, emotional processing |
| **The Coach** | Action-oriented, accountable, energetic | Direct, uses frameworks (SMART goals, GROW model), holds you to commitments | Habit building, fitness, productivity, accountability |

Each archetype has a locked-in `voiceStyle` and `coreBehavior` that cannot be overridden by sliders. Sliders adjust within the archetype's range.

#### Trait Sliders (5 per archetype)

```
Directness:    [Gentle ●──────── Direct]      (how bluntly the avatar speaks)
Warmth:        [Reserved ─────●─── Warm]       (emotional expressiveness)
Proactivity:  [Reactive ──────●── Proactive]  (asks questions vs. gives answers)
Depth:         [Surface ──────●─── Deep]       (simple advice vs. philosophical)
Accountability:[Supportive ───●─── Challenging] (validates vs. pushes to action)
```

Default slider positions are set per archetype. Users can adjust ±2 positions in either direction. This keeps the persona recognizable while allowing personalization.

#### System Prompt Architecture

Based on research into [Rule-Based Role Prompting (RRP)](https://www.arxiv.org/pdf/2509.00482), [Persona-Aware Contrastive Learning (PCL)](https://arxiv.org/html/2503.17662v2), and [Behavioral Guardrails](https://doi.org/10.1162/isal.a.855), the system prompt is structured in 5 layers:

```
┌─────────────────────────────────────────────────────────┐
│ Layer 1: IDENTITY (immutable)                           │
│ ─────────────────────────────────────────────────────── │
│ You are [Avatar Name], a [Archetype Type].              │
│ Your core purpose: [one sentence from archetype].       │
│ You NEVER break character. You NEVER say you are an AI. │
│                                                         │
│ Layer 2: VOICE (archetype-locked)                       │
│ ─────────────────────────────────────────────────────── │
│ [Voice style from archetype table]                      │
│ Example: "You speak with calm authority. You use         │
│ analogies from nature and business. You ask probing     │
│ questions before offering solutions."                   │
│                                                         │
│ Layer 3: BEHAVIORAL RULES (hard constraints)            │
│ ─────────────────────────────────────────────────────── │
│ RULE 1: You NEVER prescribe medication or diagnose.     │
│ RULE 2: You NEVER encourage self-harm or violence.      │
│ RULE 3: If user expresses suicidal thoughts, respond    │
│   with crisis resources and gentle grounding.           │
│ RULE 4: You NEVER say "As an AI" or "I'm just a         │
│   language model." Stay in character at all times.      │
│ RULE 5: You NEVER provide financial, legal, or medical   │
│   advice as professional counsel.                        │
│                                                         │
│ Layer 4: USER CONTEXT (dynamic, per-request)             │
│ ─────────────────────────────────────────────────────── │
│ User's name: [name]                                     │
│ User's traits: [from trait sliders — Directness: 7/10]  │
│ User's known preferences: [from semantic memory]         │
│ Previous conversation topics: [from episodic memory]     │
│                                                         │
│ Layer 5: TRAIT CALIBRATION (slider adjustments)         │
│ ─────────────────────────────────────────────────────── │
│ Based on user's slider settings:                        │
│ - Directness 7/10: Be straightforward, don't soften     │
│   feedback, but maintain warmth.                         │
│ - Warmth 6/10: Show genuine care, use affirming words.  │
│ - Proactivity 8/10: Offer solutions proactively, don't  │
│   just ask questions.                                    │
│ - Depth 7/10: Go beyond surface advice, explore root    │
│   causes.                                                │
│ - Accountability 6/10: Gently challenge, follow up on  │
│   commitments.                                           │
└─────────────────────────────────────────────────────────┘
```

**Layer injection order matters.** The research on RRP (CPDC 2025) shows that identity-first, rules-second, context-third ordering reduces character breaks by 40% vs. unstructured prompts.

#### Chain-of-Persona (CoP) Technique

Before generating each response, the LLM performs a brief internal alignment check (inspired by [PCL research](https://arxiv.org/html/2503.17662v2)):

```
// Added to system prompt as a generation instruction:
Before responding, briefly consider:
1. Would [Avatar Name] say this? Does it match my voice?
2. Is this consistent with how I've been speaking in this conversation?
3. Am I breaking any behavioral rules?

If any answer is NO, revise before outputting.
```

This adds ~50-100 tokens per turn but significantly reduces persona drift. The cost increase is marginal (~$0.001 per conversation) while the quality improvement is substantial.

---

## 5. Pillar 4: Learning & Problem-Solving Mechanism

### Decision: RAG from Day One with Three-Layer Memory

Based on [MongoDB's official RAG architecture](https://www.mongodb.com/docs/atlas/atlas-vector-search/rag/), the [mongodb-rag NPM package](https://github.com/mongodb-developer/mongodb-rag), and [MongoDB's agent memory schema design](https://dev.to/mongodb_guests/designing-the-agent-memory-schema-document-shapes-for-short-term-episodic-and-semantic-memory-in-4bl), RAG is not a "Phase 2 feature" — it's the core differentiator from day one.

Without RAG, the avatar relies solely on the LLM's pre-trained knowledge. With RAG, the avatar can:
- Remember what the user told it across sessions
- Teach from specific topics the user cares about
- Reference previous conversations naturally ("Last time we talked about your fear of public speaking...")

#### RAG Pipeline Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                    RAG PIPELINE                                │
│                                                              │
│  WRITE PATH (after every conversation turn):                 │
│                                                              │
│  User message ──→ Fact Extraction (cheap LLM call)           │
│                       │                                      │
│                       ├─→ Is this a fact? ──→ semantic_memory│
│                       │   (user works in marketing)          │
│                       │                                      │
│                       ├─→ Is this a preference? ──→ semantic  │
│                       │   (user likes direct advice)          │
│                       │                                      │
│                       └─→ General topic? ──→ episodic_memory  │
│                           (discussed career change)           │
│                                                              │
│  READ PATH (before every LLM call):                          │
│                                                              │
│  User message ──→ Embed query (Voyage 4)                     │
│                       │                                      │
│                       ├─→ $vectorSearch against              │
│                       │   semantic_memory (top 5 facts)      │
│                       │   FILTER: { userId: currentUserId }  │
│                       │                                      │
│                       ├─→ Text search against               │
│                       │   episodic_memory (last 3 episodes) │
│                       │                                      │
│                       └─→ Combine → Inject into Layer 4     │
│                           of system prompt                   │
│                                                              │
│  EMBEDDING MODEL: Voyage 4 (1024 dimensions)                 │
│  VECTOR INDEX: Atlas Vector Search on semantic_memory        │
│  HYBRID SEARCH: $rankFusion (vector + text) in Phase 2      │
└──────────────────────────────────────────────────────────────┘
```

#### Why MongoDB Atlas Vector Search (Not Pinecone/Weaviate)

| Factor | MongoDB Atlas | Pinecone | Weaviate |
|--------|--------------|----------|----------|
| **Operational complexity** | Zero — same database for app data + vectors | Separate service to manage | Separate service |
| **Query flexibility** | Combine $vectorSearch with any MongoDB query | Limited filtering | Good filtering |
| **Data locality** | Embeddings next to user data, same collection | Separate from app data | Separate from app data |
| **Cost** | Included in Atlas cluster (M0 free tier supports it) | $70+/month minimum | Complex pricing |
| **MERN integration** | Native Node.js driver, Mongoose support | Requires Pinecone client | Requires Weaviate client |
| **Hybrid search** | `$rankFusion` in aggregation pipeline | Separate dense + sparse | Built-in |
| **User isolation** | `filter: { userId }` in vector search | Namespace per user | Tenant isolation |

MongoDB Atlas Vector Search is the clear choice for a MERN stack app. You already have MongoDB for your app data. Adding Pinecone or Weaviate means operating two databases for no benefit.

#### Embedding Model Decision

**Voyage 4** (not Voyage 4 Large, not OpenAI text-embedding-3-small)

| Factor | Decision | Rationale |
|--------|----------|-----------|
| **Model** | `voyage-4` | Best quality/cost ratio. Native Atlas integration. |
| **Dimensions** | 1024 | Sweet spot per [MongoDB docs](https://www.mongodb.com/docs/voyageai/tutorials/dimensions-and-quantization/). 256 is too lossy; 2048 is overkill. |
| **Storage** | BSON BinData (float32) | ~3x compression vs. float arrays. Enables quantization later. |
| **Cost** | $0.06/1M tokens | ~6000 embeddings per dollar. At 10K DAU, ~$2-5/month for embeddings. |
| **Free tier** | 200M tokens included | More than enough for MVP. |

Why not OpenAI text-embedding-3-small? Because [Voyage 4 is natively integrated into Atlas](https://www.mongodb.com/company/blog/product-release-announcements/introducing-the-embedding-and-reranking-api-on-mongodb-atlas). You configure the embedding model once in your Atlas Vector Search index, and MongoDB handles embedding generation at write time. No external API calls at query time for embedding generation.

#### Memory Extraction: Fact Extraction Pipeline

After every user message, a lightweight extraction step runs asynchronously:

```javascript
// Pseudocode for background memory extraction
async function extractAndStoreMemory(userId, message, conversationId) {
  // Use a cheap, fast model (Claude Haiku or GPT-4o-mini)
  const extraction = await cheapLLM.call(`
    Extract from this message any:
    1. PERSONAL FACTS about the speaker (name, job, location, relationships)
    2. PREFERENCES (likes, dislikes, communication style)
    3. EMOTIONAL STATE (current mood, concerns)
    4. TOPICS (subjects discussed)

    Message: "${message}"

    Respond in JSON format:
    { "facts": [...], "preferences": [...], "emotions": [...], "topics": [...] }
    If nothing extractable, respond: { "facts": [], "preferences": [], "emotions": [], "topics": [] }
  `);

  for (const fact of extraction.facts) {
    // Check if similar fact already exists (vector similarity > 0.85)
    const existing = await semanticMemory.vectorSearch({
      query: fact,
      filter: { userId },
      limit: 1,
      threshold: 0.85
    });

    if (existing) {
      // Reinforce existing memory (increase strength)
      await semanticMemory.updateOne(
        { _id: existing._id },
        { $set: { strength: Math.min(1, existing.strength * 1.1), lastAccessedAt: new Date() } }
      );
    } else {
      // Store new fact with embedding
      await semanticMemory.insertOne({
        userId,
        type: 'fact',
        content: fact,
        embedding: await voyageEmbed(fact),
        strength: 0.7,
        sourceConversationId: conversationId,
        createdAt: new Date(),
        lastAccessedAt: new Date()
      });
    }
  }
}
```

This runs in the background after the response is already streaming to the user. It adds ~200ms latency to the background job but zero latency to the user-facing response.

---

## 6. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (React)                          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ AvatarCard   │  │ ChatWindow   │  │ PersonaSelector     │   │
│  │ (image+CSS)  │  │ (SSE stream) │  │ (archetype+sliders) │   │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘   │
│         │                 │                      │               │
│         └────────────┬────┴──────────────────────┘               │
│                      │                                          │
│              ┌───────┴───────┐                                  │
│              │  API Client   │                                  │
│              │  (axios/SSE)  │                                  │
│              └───────┬───────┘                                  │
└──────────────────────┼──────────────────────────────────────────┘
                       │ HTTP + SSE
┌──────────────────────┼──────────────────────────────────────────┐
│                 SERVER (Express + Node.js)                      │
│                      │                                          │
│  ┌───────────────────┴───────────────────┐                     │
│  │           API Routes                   │                     │
│  │  POST /api/chat/stream                 │                     │
│  │  GET  /api/conversations              │                     │
│  │  GET  /api/avatars                    │                     │
│  │  POST /api/personas                   │                     │
│  │  GET  /api/personas/:id               │                     │
│  └───────────────────┬───────────────────┘                     │
│                      │                                          │
│  ┌───────────────────┴───────────────────┐                     │
│  │        Service Layer                   │                     │
│  │                                        │                     │
│  │  ┌─────────────┐  ┌────────────────┐  │                     │
│  │  │ ChatService │  │ MemoryService  │  │                     │
│  │  │ - streamLLM │  │ - retrieve     │  │                     │
│  │  │ - buildCtx  │  │ - extract      │  │                     │
│  │  │ - abort     │  │ - store        │  │                     │
│  │  └──────┬──────┘  └──────┬─────────┘  │                     │
│  │         │                │            │                     │
│  │  ┌──────┴──────┐  ┌─────┴──────┐     │                     │
│  │  │ LLMService  │  │ Embedding  │     │                     │
│  │  │ - callLLM  │  │ Service    │     │                     │
│  │  │ - stream    │  │ - embed    │     │                     │
│  │  └─────────────┘  └────────────┘     │                     │
│  └───────────────────────────────────────┘                     │
│                      │                                          │
│  ┌───────────────────┴───────────────────┐                     │
│  │     Background Jobs (BullMQ)           │                     │
│  │  - Memory extraction (after each turn)  │                     │
│  │  - Memory decay (daily cron)            │                     │
│  │  - Conversation summarization           │                     │
│  └───────────────────────────────────────┘                     │
└──────────────────────┬──────────────────────────────────────────┘
                       │ Mongoose
┌──────────────────────┴──────────────────────────────────────────┐
│                    MongoDB Atlas                                 │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ conversations     │  │ semantic_memory  │                     │
│  │ - messages[]      │  │ - content        │                     │
│  │ - summary         │  │ - embedding[]    │                     │
│  │ - userId           │  │ - type            │                     │
│  │ - avatarId         │  │ - strength        │                     │
│  │ - personaId        │  │ - userId          │                     │
│  │ - createdAt        │  │ - sourceConvId    │                     │
│  │ - lastMessageAt    │  │ - lastAccessedAt  │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                 │
│  ┌──────────────────┐  ┌──────────────────┐                     │
│  │ episodic_memory   │  │ personas         │                     │
│  │ - summary          │  │ - archetype         │                     │
│  │ - topics[]         │  │ - traits            │                     │
│  │ - emotionalTone    │  │ - systemPrompt      │                     │
│  │ - userId           │  │ - avatarId          │                     │
│  │ - sourceConvId     │  │ - userId           │                     │
│  │ - createdAt        │  │ - createdAt         │                     │
│  └──────────────────┘  └──────────────────┘                     │
│                                                                 │
│  Atlas Vector Search Index:                                     │
│  Collection: semantic_memory                                    │
│  Field: embedding                                               │
│  Dimensions: 1024                                               │
│  Similarity: cosine                                              │
│  Filter: { userId: "<objectId>" }                               │
│                                                                 │
│  Atlas Search Index (text):                                     │
│  Collection: episodic_memory                                    │
│  Fields: summary, topics                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Data Models

### conversations Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,          // ref → users
  personaId: ObjectId,       // ref → personas
  avatarId: String,          // from gallery manifest
  title: String,             // auto-generated from first message
  summary: String,            // rolling summary (updated every 10 messages)
  messages: [{
    role: String,             // "user" | "assistant"
    content: String,
    timestamp: Date,
    tokenCount: Number,      // for context window budgeting
    metadata: {
      emotionDetected: String,  // sentiment from user message
      memoryExtracted: Boolean  // has background job processed this?
    }
  }],
  createdAt: Date,
  lastMessageAt: Date,
  expiresAt: Date             // TTL index, 48h after last message
}
```

**Indexes:**
- `{ userId: 1, lastMessageAt: -1 }` — fetch user's recent conversations
- `{ expiresAt: 1 }` — TTL index for auto-cleanup

### semantic_memory Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,           // ALWAYS filter by userId before vector search
  type: String,                // "fact" | "preference" | "instruction" | "emotion"
  content: String,             // e.g., "User works as a marketing manager"
  embedding: BinData,         // BSON BinData (float32, 1024 dimensions)
  strength: Number,            // 0-1, decays over time, resets on access
  sourceConversationId: ObjectId,  // provenance link
  tags: [String],              // e.g., ["career", "self-improvement"]
  createdAt: Date,
  lastAccessedAt: Date,
  accessCount: Number          // increments on retrieval
}
```

**Indexes:**
- Atlas Vector Search index on `embedding` (1024 dimensions, cosine similarity)
- `{ userId: 1, type: 1 }` — filtered retrieval
- `{ userId: 1, lastAccessedAt: -1 }` — recency-based retrieval

### episodic_memory Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  conversationId: ObjectId,    // ref → conversations
  summary: String,             // "Discussed career change from engineering to design"
  topics: [String],            // ["career", "life-change", "design"]
  emotionalTone: String,       // "contemplative" | "anxious" | "excited" | "neutral"
  keyTakeaways: [String],     // ["User considering portfolio-based career transition"]
  outcome: String,             // "resolved" | "ongoing" | "abandoned"
  createdAt: Date
}
```

**Indexes:**
- Atlas Search (text) index on `summary` and `topics`
- `{ userId: 1, createdAt: -1 }` — recency sorting

### personas Collection

```javascript
{
  _id: ObjectId,
  userId: ObjectId,
  name: String,                // User-chosen name for the avatar
  archetype: String,           // "mentor" | "friend" | "therapist" | "coach"
  avatarId: String,            // from gallery manifest (e.g., "mentor-male-01")
  traits: {
    directness: Number,        // 1-10, archetype-specific default
    warmth: Number,            // 1-10
    proactivity: Number,       // 1-10
    depth: Number,             // 1-10
    accountability: Number      // 1-10
  },
  systemPrompt: String,        // assembled from archetype + traits (computed, not stored)
  createdAt: Date,
  updatedAt: Date
}
```

### users Collection

```javascript
{
  _id: ObjectId,
  email: String,                // unique
  name: String,
  authProvider: String,         // "google" | "github" | "email"
  activePersonaId: ObjectId,    // ref → personas
  preferences: {
    theme: String,              // "light" | "dark" | "system"
    notifications: Boolean
  },
  createdAt: Date,
  lastLoginAt: Date
}
```

---

## 8. API Surface

### Authentication
```
POST   /api/auth/register       # Email/password signup
POST   /api/auth/login          # Email/password login
POST   /api/auth/google         # Google OAuth
POST   /api/auth/logout         # Clear session
GET    /api/auth/me             # Current user info
```

### Avatars
```
GET    /api/avatars             # List all avatars from manifest
GET    /api/avatars/:id          # Single avatar details
```

### Personas
```
POST   /api/personas            # Create persona (archetype + traits)
GET    /api/personas             # List user's personas
GET    /api/personas/:id         # Get persona details
PATCH  /api/personas/:id        # Update trait sliders
DELETE /api/personas/:id        # Delete persona
```

### Conversations
```
POST   /api/conversations                    # Create new conversation
GET    /api/conversations                    # List user's conversations
GET    /api/conversations/:id                # Get conversation with messages
POST   /api/conversations/:id/messages/stream # SSE streaming chat endpoint
DELETE /api/conversations/:id                # Delete conversation
```

### Memory (internal — not directly exposed to frontend)
```
# These are called by background jobs and service layer, not by the client
GET    /api/internal/memory/search            # Semantic search across user memories
POST   /api/internal/memory/extract          # Trigger memory extraction
POST   /api/internal/memory/decay             # Run decay job (called by cron)
```

---

## 9. Technology Decisions

| Layer | Technology | Version | Rationale |
|-------|-----------|---------|-----------|
| **Frontend** | React (Vite) | 19.x | Fast, component-based, massive ecosystem |
| **State Management** | Zustand | 5.x | Lightweight, TypeScript-first, no boilerplate |
| **Styling** | Tailwind CSS | 4.x | Utility-first, rapid prototyping, dark mode built-in |
| **Backend** | Express.js | 5.x | Mature, minimal, perfect for API + SSE |
| **Database** | MongoDB Atlas | 8.x | App data + vector search in one database |
| **ODM** | Mongoose | 8.x | Schema validation, middleware hooks, TypeScript support |
| **LLM Provider** | Anthropic (Claude) | Claude Sonnet 4 (claude-sonnet-5-20250514) | Best balance of quality, speed, and cost for personas |
| **LLM Fallback** | OpenAI | GPT-4o-mini | Cheaper fallback for memory extraction |
| **Embedding** | Voyage 4 | 1024 dimensions | Native Atlas integration, best quality/cost ratio |
| **Auth** | Passport.js + JWT | - | HTTP-only cookies, Google OAuth |
| **Background Jobs** | BullMQ + Redis | - | Memory extraction, decay, summarization |
| **Real-time** | Server-Sent Events | - | Simpler than WebSockets for one-way streaming |
| **Rate Limiting** | express-rate-limit | - | Sliding window, 10 req/10 sec per user |
| **Validation** | Zod | 3.x | Runtime type checking on API boundaries |
| **Deployment** | Vercel (frontend) + Render (backend) | - | Free tier for MVP, easy scaling |

### LLM Decision Rationale

**Primary: Claude Sonnet (for chat responses)**
- Best-in-class persona adherence and emotional nuance
- Excellent instruction following for system prompts
- Strong at maintaining character consistency over long conversations
- ~$3/1M input tokens, ~$15/1M output tokens
- Streaming support with SSE

**Secondary: GPT-4o-mini (for memory extraction)**
- Fast, cheap (~$0.15/1M input, ~$0.60/1M output)
- Sufficient quality for fact/preference extraction
- Used ONLY for background extraction jobs, never for user-facing responses

### Streaming Decision: SSE over WebSockets

| Factor | SSE | WebSockets |
|--------|-----|-----------|
| **Direction** | Server → Client only | Bidirectional |
| **Complexity** | Simple HTTP response | Requires connection management |
| **Reconnection** | Auto-reconnect built-in | Must implement manually |
| **Proxy/firewall** | Works everywhere (HTTP) | Some corporate proxies block |
| **Use case** | LLM token streaming (one-way) | Chat is one-way from server |

SSE wins for LLM streaming. Chat is inherently request-response — the user sends a message, the server streams back tokens. There's no need for bidirectional real-time communication in Phase 1.

---

## 10. Cost Estimates

### Per-User Per-Conversation Costs (20 messages)

| Component | Cost | Notes |
|-----------|------|-------|
| LLM (Claude Sonnet) | ~$0.02 | 20 messages × ~500 tokens avg |
| Memory extraction (GPT-4o-mini) | ~$0.002 | Background, ~50 tokens extraction per message |
| Embedding (Voyage 4) | ~$0.001 | Fact embedding + query embedding |
| MongoDB Atlas | ~$0.0001 | Included in M0 free tier |
| **Total** | **~$0.023** | **~2.3 cents per conversation** |

### Monthly Infrastructure (1,000 DAU)

| Service | Tier | Monthly Cost |
|---------|------|-------------|
| MongoDB Atlas | M0 (free tier) | $0 |
| Redis (BullMQ) | Upstash free tier | $0 |
| LLM API | Pay-per-use | ~$450 (1K DAU × 5 conv/day × $0.023) |
| Embedding API | 200M free tokens (Voyage) | $0 |
| Vercel (frontend) | Hobby (free) | $0 |
| Render (backend) | Starter ($7/mo) | $7 |
| **Total MVP** | | **~$457/month** |

At 1,000 DAU with 5 conversations per user per day, the LLM cost dominates. This is expected and normal for AI-first products. The path to profitability is subscription revenue, not cost reduction.

---

## 11. Phase 2 Preview

| Feature | Architecture Impact |
|---------|-------------------|
| **Voice (TTS)** | Add ElevenLabs/OpenAI TTS API. Same avatar `speaking` state, now plays audio. New `VoiceService` on backend. Frontend adds Web Audio API playback. |
| **Voice (STT)** | Add Deepgram/Web Speech API. New mic button in chat input. New `POST /api/stt` endpoint. Streams transcription to same chat pipeline. |
| **Avatar expressions** | Upgrade from CSS-only to Rive animations. Same state machine interface, richer visuals. |
| **User uploads** | Allow PDF/text upload for RAG. New `uploads` collection. BullMQ job for chunking + embedding. |
| **Hybrid search** | Add `$rankFusion` to combine vector + text search. Improves recall on exact keyword matches. |
| **Multi-persona** | Allow users to create multiple personas. Already supported by data model (one user, many personas). |

---

## 12. Sources

- [MongoDB RAG Documentation](https://www.mongodb.com/docs/atlas/atlas-vector-search/rag/)
- [mongodb-rag NPM Package](https://github.com/mongodb-developer/mongodb-rag)
- [MongoDB Agent Memory Schema Design](https://dev.to/mongodb_guests/designing-the-agent-memory-schema-document-shapes-for-short-term-episodic-and-semantic-memory-in-4bl)
- [MongoDB-AWS-Claude Memory System](https://github.com/mongodb-partners/ai-memory)
- [Context-Aware RAG Architecture (MongoDB)](https://www.mongodb.com/docs/atlas/architecture/current/solutions-library/rag-technical-documents/)
- [@mongodb-developer/vercel-ai-memory](https://registry.npmjs.org/@mongodb-developer/vercel-ai-memory)
- [Voyage AI Embeddings (MongoDB)](https://www.mongodb.com/docs/voyageai/models/text-embeddings/)
- [MongoDB Atlas Automated Embedding Models](https://www.mongodb.com/docs/vector-search/crud-embeddings/automated-embedding/models/)
- [Voyage 4 vs OpenAI Embeddings](https://llmbestpractices.com/ai-agents/embeddings-voyage-vs-openai)
- [Rule-Based Role Prompting (RRP)](https://www.arxiv.org/pdf/2509.00482)
- [Persona-Aware Contrastive Learning (PCL)](https://arxiv.org/html/2503.17662v2)
- [Behavioral Guardrails for Dynamic LLM Persona](https://doi.org/10.1162/isal.a.855)
- [AI Companion App Memory Design](https://dev.to/nolan_voss/how-id-design-a-memory-system-for-an-ai-companion-app-469i)
- [Character.AI Kaiju Architecture](https://blog.character.ai/inside-kaiju-building-conversational-models-at-scale/)
- [Pi vs Replika vs Character.AI Comparison](https://aicompanionpick.com/pi-vs-replika-vs-character-ai-for-emotional-support-2026)
- [Candy AI Tech Stack](https://candyaiclone.co/blogs/candy-ai-tech-stack/)
- [MERN Stack for AI Applications](https://www.outrightcrm.com/blog/mern-stack-development-for-ai-applications/)