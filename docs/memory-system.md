# Memory System

> AI Bestie's memory model for the simple phase. There is **only session
> memory** — the last 20 messages in the current conversation.

## Scope

An earlier design proposed a 3-layer memory system (session + episodic +
semantic with Atlas Vector Search / RAG). **That was removed.** The extraction
background worker was never wired up, so episodic/semantic retrieval always
returned empty and only added cost and complexity. This phase keeps just the
context that actually works and is free.

There are **no** `EpisodicMemory` or `SemanticMemory` collections, no
`retrieveRelevantMemories` function, no `$vectorSearch`, and no embedding
calls. If you see references to those elsewhere, they are stale (see the
"Stale references" note at the bottom).

## Session Memory

**What:** The last 20 messages in the current conversation.
**Storage:** Embedded in the `Conversation` document (MongoDB).
**Retrieval:** `conversation.getRecentMessages(20)` — a simple array slice.
**Cost:** $0 — no extra API calls.

```
┌────────────────────────────────────────────┐
│             Session Memory                  │
│                                             │
│  [User] I'm thinking about a career change  │
│  [AI]   That's a big decision. What's...    │
│  [User] I'm 35 and worried about starting   │
│  [AI]   Age is just a number. Let's look... │
│  [User] What skills transfer from marketing?│
│  ... (up to 20 messages)                     │
└────────────────────────────────────────────┘
```

### Implementation

```typescript
// server/src/models/Conversation.ts
getRecentMessages(limit = 20): IMessage[] {
  return this.messages.slice(-limit);
}

// server/src/services/chatService.ts
const recentMessages = conversation.getRecentMessages(20);
const messages = recentMessages
  .filter((m) => m.role === 'user' || m.role === 'assistant')
  .map((m) => ({ role: m.role, content: m.content }));
```

These messages are sent to the LLM as the `messages` array (after the
assembled 5-layer system prompt). The persona prompt's Layer 4 simply notes
that this history is present — it does not retrieve anything else.

### TTL: 48 Hours

Conversations expire 48 hours after the last message via a MongoDB TTL index
on `expiresAt`, which is reset to `now + 48h` on every new message. Storage is
naturally bounded, which keeps the (free-tier) database footprint small.

## What is NOT here

- **No episodic memory** — no per-conversation summaries are generated or
  stored. Past conversations are not recalled.
- **No semantic memory** — no extracted facts/preferences about the user, no
  embeddings, no vector search.
- **No background jobs** — no BullMQ/Redis extraction or summarization workers.
- **No paid dependencies** — no Voyage embeddings, no Atlas Vector Search, no
  GPT-4o-mini extraction calls.

## Stale references

Historical planning docs (`phase-1-specification.md`, `plan1.md`, `plan2.md`)
and some older doc sections still describe the removed 3-layer system. Those
docs are marked SUPERSEDED and kept only for history; the code is the source of
truth.