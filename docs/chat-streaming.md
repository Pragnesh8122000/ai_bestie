# Chat & Streaming

> How AI Bestie handles real-time chat with Server-Sent Events and avatar state animations.

## SSE Streaming Architecture

AI Bestie uses **Server-Sent Events (SSE)** for streaming chat responses. Unlike WebSockets, SSE works over plain HTTP, is simpler to implement, and naturally supports the unidirectional flow (server → client) that chat requires.

### Why SSE over WebSockets?

| Factor | SSE | WebSockets |
|--------|-----|------------|
| Direction | Server → Client only | Bidirectional |
| Protocol | HTTP/1.1+ | Upgrade to WS |
| Reconnection | Built-in auto-reconnect | Manual |
| Proxy/Firewall | Works everywhere | May be blocked |
| Complexity | Low | Higher (connection management) |
| Use case | Chat streaming (perfect fit) | Real-time gaming, sync |

### Why fetch + ReadableStream over EventSource?

The browser `EventSource` API only supports GET requests. Our streaming endpoint requires POST (to send the message body). We use `fetch()` with `ReadableStream` to handle POST-based SSE.

```typescript
// client/src/api/conversation.ts — SSE via fetch
export async function* streamMessage(
  conversationId: string,
  message: string,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const response = await fetch(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ message }),
    signal, // aborts the upstream fetch when the user leaves or sends a new message
  });

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        yield JSON.parse(line.slice(6));
      }
    }
  }
}
```

## Server-Side Streaming Flow

### 1. Request Enters

```
POST /api/conversations/:id/messages/stream
Authorization: Cookie (JWT)
Body: { "message": "I need career advice" }
```

### 2. chatService.handleChatStream()

```
handleChatStream(userId, conversationId, message, res)
  │
  ├─ 1. Load Conversation (user-scoped query)
  │     → 404 if not found
  │
  ├─ 2. Load Persona by conversation.personaId
  │     → 404 if not found
  │
  ├─ 3. Assemble System Prompt
  │     → personaService.assembleSystemPrompt(persona)
  │     → 5-layer prompt + Chain-of-Persona (no memory retrieval)
  │
  ├─ 4. Save User Message (atomic)
  │     → Conversation.updateOne({ $push: { messages: ... }, $set: { lastMessageAt, expiresAt } })
  │     → re-read recent messages for the context window
  │
  ├─ 5. Build LLM Messages
  │     → last 20 conversation messages
  │     → Filter to user/assistant roles only
  │     → Map to { role, content } format
  │
  ├─ 6. Set SSE Headers + Start Watchdog
  │     → Content-Type: text/event-stream
  │     → Cache-Control: no-cache
  │     → Connection: keep-alive
  │     → X-Accel-Buffering: no (nginx proxy)
  │     → AbortController: 30s timeout; res.on('close') → abort
  │     → 15s heartbeat (`: keepalive` comment frames)
  │     → Send: { type: "state", state: "thinking" }
  │
  ├─ 7. Stream LLM Response
  │     → llmService.streamChat({ systemPrompt, messages, signal, onToken, onEnd })
  │     → Gemini (primary) → OpenRouter (fallback); 429 → per-model cooldown
  │     → On first token: send { type: "state", state: "speaking" }
  │     → Per token: send { type: "token", content: token }
  │     → On end: fullResponse = text
  │
  ├─ 8. Save Assistant Message (atomic)
  │     → Conversation.updateOne({ $push: { messages: ... }, $set: { lastMessageAt, expiresAt } })
  │
  └─ 9. Send Final Events
        → { type: "state", state: "idle" }
        → { type: "done", messageId: "msg_..." }
        → res.end()
```

### 3. LLM Service

`llmService.streamChat()` calls the LLM provider chain with streaming enabled.
Primary is Google **Gemini Flash** (free tier, via its OpenAI-compatible
`/chat/completions` endpoint); fallback is **OpenRouter** free models. Both
speak the same OpenAI SSE format, so one parser handles either. The provider
chain tries models in order with retry+backoff; only auth errors (401/403)
skip a whole provider, and a 429 puts that model into a short in-process
cooldown.

```typescript
// Simplified — see server/src/services/llmService.ts
await streamChat({
  systemPrompt,
  messages,            // last 20 conversation messages
  signal,              // AbortController: fires on client disconnect or 30s timeout
  onToken: (t) => /* send { type: 'token', content: t } */,
  onEnd: (full) => /* fullResponse = full */,
});
```

### 4. Error Handling

If the LLM call fails:
```typescript
catch (error) {
  res.write(`data: ${JSON.stringify({ type: 'error', message: 'Failed to generate response' })}\n\n`);
  res.end();
}
```

The client receives this and displays an error message.

## Client-Side Streaming Flow

### chatStore.sendMessage()

```typescript
async sendMessage(content: string) {
  set({ isStreaming: true, avatarState: 'thinking', streamingContent: '' });

  try {
    const stream = streamMessage(activeConversationId, content);

    for await (const event of stream) {
      switch (event.type) {
        case 'state':
          set({ avatarState: event.state });
          break;

        case 'token':
          set((state) => ({
            streamingContent: state.streamingContent + event.content,
            avatarState: 'speaking', // First token triggers this
          }));
          break;

        case 'done':
          // Append final message to conversation
          set((state) => ({
            messages: [...state.messages, {
              role: 'assistant',
              content: state.streamingContent,
              timestamp: new Date().toISOString(),
            }],
            streamingContent: '',
            isStreaming: false,
            avatarState: 'idle',
          }));
          break;

        case 'error':
          set({ error: event.message, isStreaming: false, avatarState: 'idle' });
          break;
      }
    }
  } catch (error) {
    set({ error: 'Stream failed', isStreaming: false, avatarState: 'idle' });
  }
}
```

## Avatar State Machine

The avatar has 4 CSS animation states that correspond to conversation phases:

```
┌─────────────────────────────────────────────────┐
│                                                  │
│   IDLE ←──────────────────────────────┐           │
│   (gentle breathing animation)       │           │
│     │                                │           │
│     │ User sends message             │ Stream    │
│     │                                │ ends      │
│     ▼                                │           │
│   THINKING ──────────────────► SPEAKING          │
│   (bouncing dots animation)   (glow ring          │
│     │                          + pulse)           │
│     │ First token arrives          │              │
│     └──────────────────────────────┘              │
│                                                   │
│   User starts typing ─────► LISTENING            │
│   (wave bar animation)         │                 │
│                                │ User sends      │
│                                └──► THINKING      │
│                                                  │
└─────────────────────────────────────────────────┘
```

### State Transitions

| Current State | Trigger | Next State |
|---------------|---------|------------|
| idle | User sends message | thinking |
| thinking | First token received | speaking |
| thinking | Error | idle |
| speaking | Stream done event | idle |
| speaking | Error | idle |
| idle | User starts typing | listening |
| listening | User sends message | thinking |

### CSS Animations (globals.css)

```css
/* Idle — gentle breathing */
@keyframes breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.02); }
}

/* Thinking — bouncing dots */
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-8px); }
}

/* Speaking — glow ring */
@keyframes glow-ring {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
  50% { box-shadow: 0 0 0 12px rgba(99, 102, 241, 0); }
}

/* Listening — wave bars */
@keyframes wave-bar {
  0%, 100% { height: 4px; }
  50% { height: 16px; }
}
```

### AvatarCard Component

```typescript
interface AvatarCardProps {
  src: string;
  name: string;
  state: 'idle' | 'thinking' | 'speaking' | 'listening';
  selected?: boolean;
  onClick?: () => void;
  size?: 'sm' | 'md' | 'lg';
}
```

The `state` prop drives which CSS animation plays. The parent `ChatPage` passes `chatStore.avatarState` to `AvatarCard`.

## Context Window Management

Each conversation maintains a 20-message context window:

1. `conversation.getRecentMessages(20)` retrieves the last 20 messages
2. Messages are filtered to `user` and `assistant` roles only
3. The assembled system prompt + 20 messages form the LLM input (Gemini Flash primary → OpenRouter free fallback, both via the OpenAI-compatible `/chat/completions` SSE format)

### Message Lifecycle

```
User sends "I need help with my career"
  → Saved as { role: "user", content: "...", timestamp, tokenCount: 0 }
  → Context window: last 20 messages
  → LLM (Gemini → OpenRouter) streams response
  → Saved as { role: "assistant", content: "...", timestamp, tokenCount: 0 }
```

The `tokenCount` field tracks token usage for cost monitoring. It's set to `null` for user messages (we don't count those) and populated after streaming completes for assistant messages.

## Connection Handling

### Client Reconnection

If the SSE connection drops mid-stream:
1. The `fetch` ReadableStream throws an error
2. `chatStore` catches the error, sets `isStreaming: false`
3. The partial response is preserved in `streamingContent`
4. The user can retry by sending the message again

### Server Timeout

The Express response stays open for the duration of the upstream LLM call. A
30s `AbortController` deadline aborts a stalled provider, and a 15s SSE
heartbeat (`: keepalive` comment frames) keeps proxies/CDNs from dropping the
idle stream during backoff. If the client disconnects mid-stream, `res.on('close')`
aborts the upstream fetch so the free-tier LLM quota isn't burned into a dead
socket. We handle this gracefully:

- `X-Accel-Buffering: no` prevents nginx from buffering the response
- `Cache-Control: no-cache` prevents proxy caching
- The `Connection: keep-alive` header keeps the TCP connection open
