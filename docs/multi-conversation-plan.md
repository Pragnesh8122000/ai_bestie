# Multi-Conversation Management — Implementation Plan

Status: plan only. No code written yet.

## 0. Corrections to the starting assumptions

Before planning, the current code was read. Four things differ from the brief:

1. `Conversation.ts` **already has** `title` (default `'New Conversation'`), `lastMessageAt` (indexed with `userId`), and a compound index `{ userId: 1, lastMessageAt: -1 }`. No new title field is needed — only auto-generation and a rename route.
2. `routes/conversations.ts` **already has** `GET /`, `POST /`, `GET /:id`, `DELETE /:id`. Missing: `PATCH /:id` (rename), pagination, message preview.
3. `chatStore.ts` **already has** `conversations`, `fetchConversations`, `openConversation`, `createConversation`, `deleteConversation`. They are written but **no UI calls them**. `ChatPage.tsx:47` wires the "New Chat" button to `openDefaultConversation()` — which re-opens the *same* conversation, not a new one.
4. **Two blockers that will silently break multi-conversation:**
   - `Conversation.expiresAt` has a **TTL index** (`Conversation.ts:83`, `expireAfterSeconds: 0`) with a 48-hour window refreshed on every message. MongoDB will **delete** any conversation idle for 48h. "Persist chat history" is incompatible with this as written. Phase 1 addresses it.
   - `ensureDefaultConversation` (`chatService.ts:229`) does `Conversation.findOne({ userId, personaId })` with **no sort**. With more than one conversation per persona this returns an arbitrary document (natural order). It must sort or be replaced.

These become Phase 1.

---

## Phase 1: Durable Persistence Foundation

**Goal:** Conversations survive past 48 hours and the app deterministically opens the most recent one — user-visible behavior otherwise unchanged.

### Backend tasks

**Task B.1.1 — Retire the destructive TTL, keep the field**
→ files: `server/src/models/Conversation.ts`, `server/src/services/chatService.ts`

- Remove the TTL index line `conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })`.
- Keep the `expiresAt` field in the schema (documents already carry it; removing the path would make Mongoose ignore existing data but not delete it). Mark it `// deprecated — retained for existing docs, no longer enforced`.
- Delete the `expiresAt` writes from three places in `chatService.ts`: the `$set` in the user-message update (~line 72), the `$set` in the assistant-message update (~line 146), and the `expiresAt:` argument in `createConversation` (~line 200).
- Remove the `CONVERSATION_TTL_MS` constant (`chatService.ts:8`).
- Also remove the `expiresAt` reset inside `conversationSchema.methods.addMessage`.

> **Important — dropping the index is a live-database operation.** Removing the line from the schema does **not** drop the existing index in MongoDB; Mongoose only creates indexes, never drops them. The index must be dropped explicitly (see Migration below), and until it is dropped, MongoDB keeps deleting idle conversations. Do the index drop **before** deploying anything that depends on history surviving.

**Task B.1.2 — Add lifecycle fields**
→ file: `server/src/models/Conversation.ts` (schema + `IConversation` interface)

| Field | Type | Default | Index | Purpose |
|---|---|---|---|---|
| `messageCount` | `Number` | `0` | none | List rendering without loading `messages`; drives "empty conversation" logic |
| `lastMessagePreview` | `String` | `''` | none | Snippet under the title in the list; `maxlength: 120`, `trim: true` |
| `isArchived` | `Boolean` | `false` | part of compound below | Soft-delete / hide flag |
| `deletedAt` | `Date \| null` | `null` | none | When soft-deleted; enables a future purge job |
| `titleIsCustom` | `Boolean` | `false` | none | `true` once the user renames; blocks auto-title from overwriting |

Interface additions:

```ts
messageCount: number;
lastMessagePreview: string;
isArchived: boolean;
deletedAt: Date | null;
titleIsCustom: boolean;
```

Index change: replace `conversationSchema.index({ userId: 1, lastMessageAt: -1 })` with
`conversationSchema.index({ userId: 1, isArchived: 1, lastMessageAt: -1 })`.
Keep `{ userId: 1 }` as-is on the field (it is a prefix of nothing else needed; harmless).

**Task B.1.3 — Maintain the denormalized fields on every write**
→ file: `server/src/services/chatService.ts`

In `handleChatStream`, both `Conversation.updateOne` calls gain:

- `$inc: { messageCount: 1 }`
- `$set: { lastMessagePreview: <content truncated to 120 chars, whitespace-collapsed> }`

Add a module-local helper `function toPreview(text: string): string` — collapse `\s+` to a single space, `trim()`, slice to 120.

Also update `conversationSchema.methods.addMessage` in the model to increment `messageCount` and set `lastMessagePreview`, so the two write paths stay consistent.

**Task B.1.4 — Deterministic "most recent conversation"**
→ file: `server/src/services/chatService.ts`, function `ensureDefaultConversation(userId: string)`

Change the lookup to:
`Conversation.findOne({ userId, personaId: persona._id, isArchived: false }).sort({ lastMessageAt: -1 }).lean()`

Semantics stay "resume the newest, create one if none exists". Signature and response shape unchanged, so the client needs no change this phase.

**Task B.1.5 — Exclude archived from the list**
→ file: `server/src/services/chatService.ts`, function `listConversations(userId: string)`

Filter becomes `{ userId, isArchived: false }`. Select gains `messageCount lastMessagePreview`. Sort unchanged.

### Frontend tasks

None. Phase 1 is backend-only and behavior-preserving.

### Migration / seed notes

Two operations against the live database, in this order. Run as a one-off script at `server/src/scripts/migrate-multiconvo.ts`, invoked manually (`npx tsx src/scripts/migrate-multiconvo.ts`); it must be idempotent.

1. **Drop the TTL index.** `db.conversations.dropIndex('expiresAt_1')`. Wrap in try/catch — `IndexNotFound` (code 27) is a success case on re-run.
   > **Warning: this is the step that stops automatic deletion.** Until it runs, MongoDB continues removing conversations idle for 48 hours, and any history older than that is already gone and not recoverable. Take a `mongodump` of the `conversations` collection before running the script.
2. **Backfill the new fields.** One `updateMany({}, [...])` aggregation-pipeline update setting: `messageCount` = `{ $size: { $ifNull: ['$messages', []] } }`; `lastMessagePreview` = last element's `content` sliced to 120 (`$substrCP` on `$last: '$messages.content'`, `$ifNull` to `''`); `isArchived` = `false`; `deletedAt` = `null`; `titleIsCustom` = `{ $ne: ['$title', 'New Conversation'] }` — existing docs seeded with the persona name as title (`chatService.ts:235` passes `persona.name`) count as custom, which is the safe default since Phase 2 should not rewrite them.
3. **Drop the old compound index** `userId_1_lastMessageAt_-1` after the new three-field index builds, or leave it — it is redundant but harmless. Recommend leaving it until Phase 5 is verified.

### Edge cases

- **Re-running the migration** — every operation is a set-to-computed-value or a guarded index drop; safe to repeat.
- **A conversation already deleted by TTL** — unrecoverable. Accept the loss; note it in the release notes.
- **In-flight streams during deploy** — the `$set` on `expiresAt` disappearing is additive-safe; an old server instance still writing `expiresAt` does no harm once the index is gone.
- **`messageCount` drifting from `messages.length`** — possible if a write path is missed. Not user-visible enough to guard at runtime; Phase 2's list endpoint should never trust it for correctness, only for display.

### Verification

1. `mongosh` → `db.conversations.getIndexes()` — no index with `expireAfterSeconds`.
2. `db.conversations.findOne()` — has `messageCount`, `lastMessagePreview`, `isArchived: false`, `titleIsCustom`.
3. Send a message in the app → `messageCount` increases by 2 (user + assistant), `lastMessagePreview` matches the assistant's reply, truncated.
4. Manually set a conversation's `lastMessageAt` to 5 days ago, wait past the TTL sweep interval (~60s), re-query — document still exists.
5. Insert a second conversation for the same persona with a newer `lastMessageAt`; hit `GET /api/conversations/default` → returns the newer one, repeatably.

---

## Phase 2: Conversation Lifecycle API

**Goal:** Every conversation gets a meaningful auto-title, can be renamed, and can be listed with pagination and previews — all via HTTP, no UI yet.

### Backend tasks

**Task B.2.1 — Auto-title from the first user message**
→ file: `server/src/services/chatService.ts`

New exported helper:

```ts
export function deriveTitle(firstUserMessage: string): string
```

Rules: collapse whitespace, trim, strip a leading/trailing quote pair, slice to 50 chars; if the slice cut mid-word, back off to the last space and append `'…'`; if the result is empty, return `'New Conversation'`.

Wire into `handleChatStream`, in the same `updateOne` that pushes the user message. Because that call is a plain `updateOne` (not read-modify-write), apply the title conditionally with a **second, guarded update** rather than complicating the push:

`Conversation.updateOne({ _id, userId, titleIsCustom: false, messageCount: 0 }, { $set: { title: deriveTitle(userMessage) } })`

Run it **before** the message push, so `messageCount: 0` still holds and the guard is meaningful. A no-match is the expected outcome for every message after the first — do not treat it as an error.

**Task B.2.2 — Rename endpoint**
→ files: `server/src/routes/conversations.ts`, `server/src/services/chatService.ts`

Service:
```ts
export async function renameConversation(userId: string, conversationId: string, title: string)
```
Runs `Conversation.findOneAndUpdate({ _id, userId, isArchived: false }, { $set: { title, titleIsCustom: true } }, { new: true })`. Returns `null` when not found; the route maps `null` to a 404.

Route: `PATCH /api/conversations/:id`
- Validate `req.params.id` against the existing `objectIdSchema`; invalid → `AppError('Conversation not found', 404)` (matches the existing pattern in this file).
- Body: `z.object({ title: z.string().trim().min(1).max(100) })`.
- 200 → `{ success: true, data: { conversation: { id, title, titleIsCustom, lastMessageAt } } }`
- 400 on validation failure (handled by the existing zod error middleware), 404 when not owned, 401 via `requireAuth`.

**Task B.2.3 — Soft delete**
→ files: `server/src/routes/conversations.ts`, `server/src/services/chatService.ts`

Service:
```ts
export async function archiveConversation(userId: string, conversationId: string): Promise<boolean>
```
`updateOne({ _id, userId, isArchived: false }, { $set: { isArchived: true, deletedAt: new Date() } })`, returns `result.matchedCount > 0`.

Modify the existing `DELETE /api/conversations/:id` route to call `archiveConversation` instead of `Conversation.deleteOne`. Response shape stays `{ success: true, message: 'Conversation deleted' }` so the existing client keeps working unchanged. Returning 404 when `false`.

Rationale for soft over hard: an accidental delete during a live stream would otherwise 404 the in-flight write path with no recovery. Hard purge can be a later cron over `deletedAt < now - 30d`; out of scope here.

**Task B.2.4 — List with pagination and preview**
→ files: `server/src/services/chatService.ts`, `server/src/routes/conversations.ts`

Service signature changes:
```ts
export async function listConversations(
  userId: string,
  opts?: { limit?: number; before?: Date },
): Promise<{ conversations: ConversationSummary[]; hasMore: boolean }>
```
- `limit` default 30, clamped to 1..50.
- `before` — cursor on `lastMessageAt`; when present the filter gains `lastMessageAt: { $lt: before }`.
- Query `limit + 1` docs to compute `hasMore`, then slice.
- `.select('title lastMessageAt createdAt avatarId personaId messageCount lastMessagePreview titleIsCustom')`.

`ConversationSummary` (new exported type in `chatService.ts`): `{ id, title, titleIsCustom, personaId, avatarId, messageCount, lastMessagePreview, lastMessageAt, createdAt }`.

Route `GET /api/conversations` gains query validation:
`z.object({ limit: z.coerce.number().int().min(1).max(50).optional(), before: z.coerce.date().optional() })`.
Response becomes `{ success: true, data: { conversations, hasMore } }` — **additive**; the existing client reads `data.conversations` and is unaffected.

**Task B.2.5 — Reject streaming into an archived conversation**
→ file: `server/src/services/chatService.ts`, `handleChatStream`

The initial `Conversation.findOne` filter gains `isArchived: false`. An archived id then falls into the existing 404 branch. No new code path.

### Frontend tasks

None required. Optionally land the API-client additions from Phase 3 early — they are inert until called.

### Migration / seed notes

Optional backfill: for conversations where `titleIsCustom === false` and `messages.length > 0`, set `title = deriveTitle(messages[0].content)`. Ship as a second, separately-invokable function in `migrate-multiconvo.ts`. After the Phase 1 backfill marks persona-named titles as custom, this touches only genuinely-untitled rows.

### Edge cases

- **Two rapid first messages** — the title update is guarded on `messageCount: 0`, so only the first wins. The second matches nothing.
- **First message is emoji-only or 3 chars** — `deriveTitle` returns it verbatim; no minimum length enforced beyond non-empty.
- **First message longer than 50 chars with no spaces** — word-boundary backoff finds none; hard-slice at 50 plus `'…'`.
- **Rename to whitespace** — zod `.trim().min(1)` rejects with 400.
- **Rename an archived conversation** — filter excludes it; 404.
- **Delete twice** — second call finds no `isArchived: false` match; 404. The client should treat 404-on-delete as success (Phase 5).
- **Delete mid-stream** — the stream already loaded its document, so it finishes and writes its messages into the archived doc. Harmless: the conversation is hidden from the list either way.
- **Pagination cursor ties** — two conversations sharing an exact `lastMessageAt` millisecond can skip one across page boundaries. Acceptable at this scale; note it. A tiebreak on `_id` is the fix if it ever matters.

### Verification

1. `POST /api/conversations` with a persona → 201, title `"New Conversation"`.
2. Stream `"I need help planning a trip to Lisbon next month"` into it → `GET /:id` shows title `"I need help planning a trip to Lisbon next…"` (≤50 chars + ellipsis).
3. Send a second message → title unchanged.
4. `PATCH /:id` with `{"title":"Lisbon"}` → 200, `titleIsCustom: true`. Send another message → still `"Lisbon"`.
5. `PATCH /:id` with `{"title":"   "}` → 400.
6. `DELETE /:id` → 200. `GET /api/conversations` no longer lists it. `GET /:id` still returns it (by design — detail-by-id is not filtered; Phase 5 handles the client side). `POST /:id/messages/stream` → 404.
7. Create 35 conversations, `GET /api/conversations?limit=30` → 30 items + `hasMore: true`. Re-request with `before=<last item's lastMessageAt>` → the remainder, `hasMore: false`.

---

## Phase 3: Frontend State Layer

**Goal:** The store can create, list, switch, rename, and delete conversations safely — including mid-stream — with no visual change yet.

### Frontend tasks

**Task F.3.1 — API client**
→ file: `client/src/api/conversation.ts`

Extend the `Conversation` interface with `messageCount: number`, `lastMessagePreview: string`, `titleIsCustom: boolean`. Make all three optional (`?`) so responses that predate the deploy still typecheck.

`ConversationsResponse.data` becomes `{ conversations: Conversation[]; hasMore: boolean }`.

Add to `conversationApi`:
```ts
list: (params?: { limit?: number; before?: string }) => ...
rename: (id: string, title: string) =>
  apiClient.patch<{ success: boolean; data: { conversation: Conversation } }>(`/conversations/${id}`, { title })
```

**Task F.3.2 — Store state and actions**
→ file: `client/src/stores/chatStore.ts`

New state fields on `ChatState`:
```ts
activeConversationId: string | null;
isLoadingConversation: boolean;
isLoadingList: boolean;
hasMoreConversations: boolean;
isSidebarOpen: boolean;
```

New / changed actions:
```ts
fetchConversations: (opts?: { append?: boolean }) => Promise<void>;
switchConversation: (id: string) => Promise<void>;
startNewConversation: () => Promise<string | null>;
renameConversation: (id: string, title: string) => Promise<void>;
setSidebarOpen: (open: boolean) => void;
```

Behavioral requirements, action by action:

- **`switchConversation(id)`**
  1. No-op when `id === getState().activeConversationId`.
  2. Call `abortStream()` unconditionally, then `stopSpeaking()` (already inside `abortStream`).
  3. `set({ activeConversationId: id, isLoadingConversation: true, activeConversation: null, streamingContent: '', isStreaming: false, avatarState: 'idle', error: null })` — clearing `activeConversation` prevents the previous conversation's messages flashing under the new title.
  4. `await conversationApi.get(id)`. **Guard the response**: if `getState().activeConversationId !== id` by the time it resolves, discard it (rapid-switch race). Same pattern as the existing `myStreamId !== streamId` guard.
  5. On success set `activeConversation` and `isLoadingConversation: false`.
  6. On 404 → remove the id from `conversations`, `set({ activeConversation: null, activeConversationId: null, error: 'That conversation is no longer available.' })`, then call `openDefaultConversation()`.

- **`startNewConversation()`** — reads `personaId`/`avatarId` from `usePersonaStore.getState()`. If no persona is loaded, call `openDefaultConversation()` first to seed one, then proceed. Calls `conversationApi.create`, prepends to `conversations`, then sets it active **directly from the create response** (it is known-empty; no `GET /:id` round-trip). Returns the new id, or `null` on failure. Closes the sidebar (`isSidebarOpen: false`).

- **`sendMessage`** — two additions:
  1. Capture `const convId = activeConversation.id` before the fetch, and inside the `'done'` handler bail out if `getState().activeConversationId !== convId` (user switched away mid-stream).
  2. After `'done'`, patch the matching entry in the `conversations` array: bump `lastMessageAt` to now, set `lastMessagePreview` to the assistant text truncated to 120, `messageCount += 2`, and re-sort the array by `lastMessageAt` descending so the list reorders live. If the conversation's `titleIsCustom` is false and `messageCount` was 0, also apply `deriveTitle`-equivalent client-side truncation so the sidebar title updates without a refetch — keep a small `deriveTitle` copy in `client/src/utils/` mirroring the server rule, and treat the server as authoritative on the next `fetchConversations`.

- **`renameConversation(id, title)`** — optimistic: write the new title into `conversations` (and `activeConversation` when it matches) immediately, call the API, and on failure restore the previous title and set `error`.

- **`deleteConversation(id)`** (existing, extend) — if `id === activeConversationId`, `abortStream()` first, then after the API call switch to the next conversation in the sorted list, or call `openDefaultConversation()` when the list is now empty. Treat a 404 response as success (already gone).

- **`fetchConversations({ append })`** — when `append` is true, pass `before` = the last loaded item's `lastMessageAt` and concatenate; otherwise replace. Always set `hasMoreConversations` from the response.

- **`openDefaultConversation`** (existing) — also set `activeConversationId` from the returned conversation, so the sidebar can highlight it.

### Backend tasks

None.

### Edge cases

- **Rapid switching (A→B→C in under a second)** — the `activeConversationId` guard on every `get` response discards stale loads; the last click wins.
- **Switching mid-stream** — `abortStream()` fires immediately, killing the fetch and the TTS queue. The server has already persisted the user message and will persist the assistant reply when it completes, so **the reply is not lost** — it appears when the user switches back. State that clearly in the UI copy? No — silent is fine, since the message reappears.
- **Sending a message immediately after switching, while the load is still in flight** — `sendMessage` early-returns when `activeConversation` is null. `ChatInput` must disable send while `isLoadingConversation` (Phase 4).
- **Delete the last remaining conversation** — falls back to `openDefaultConversation()`, which creates a fresh one server-side. The user never sees a truly empty app.
- **Create fails (network)** — action returns `null` and sets `error`; the UI must not optimistically add a row (the create is not optimistic, deliberately — an id is required).
- **Session expiry (401) on any of these** — the existing axios interceptor in `client.ts` governs; no new handling.

### Verification

Browser console against the running app:
1. `useChatStore.getState().startNewConversation()` → returns an id; `activeConversation.messages` is `[]`.
2. `fetchConversations()` → `conversations.length` grew by one; new item is first.
3. Send a message, then `switchConversation(<other id>)` mid-stream → orb returns to idle, TTS stops, no console errors. Switch back → the completed assistant reply is there.
4. Fire `switchConversation(A)` and `switchConversation(B)` back to back → final `activeConversation.id === B`.
5. `renameConversation(id, 'Test')` → title changes instantly; reload → still `'Test'`.

---

## Phase 4: Conversation List UI

**Goal:** The user can see their recent conversations, start a new one, and switch between them — on desktop and mobile.

### Frontend tasks

**Task F.4.1 — `ConversationList` component**
→ new file: `client/src/components/ConversationList.tsx`

Props: none — reads the store directly (consistent with `ChatWindow`).

Renders:
- A `New Chat` button at the top, calling `startNewConversation()`.
- A scrollable `<nav>` of rows, one per conversation, sorted newest-first (the store keeps the array sorted).
- Each row: title (truncated, one line), `lastMessagePreview` beneath in dimmed 12px, relative timestamp on the right (`now`, `12m`, `3h`, `Tue`, `12 Mar`) via a new `client/src/utils/relativeTime.ts` exporting `formatRelative(iso: string): string`.
- Active row: `aria-current="page"`, left ember border, `bg-ember/10` — matching the existing `NavItem` active treatment in `ChatPage.tsx:139`.
- Row click → `switchConversation(id)`, then `setSidebarOpen(false)` (harmless on desktop).
- Empty state: centered, "No conversations yet" + "Start one below" — only reachable transiently, since `openDefaultConversation` always seeds one.
- Loading state: three shimmer placeholder rows while `isLoadingList && conversations.length === 0`.
- `hasMoreConversations` → a `Load more` text button calling `fetchConversations({ append: true })`.

Mount `useEffect(() => { fetchConversations(); }, [])` in this component.

**Task F.4.2 — Responsive shell**
→ file: `client/src/pages/ChatPage.tsx`

No new dependency. `framer-motion` is already a dependency (used in `ChatWindow.tsx`) and covers the drawer animation; a drawer library would be pure overhead for one panel.

Structure:
- **Desktop (`sm:` and up)** — the existing `<aside className="hidden ... sm:flex">` stays a permanent 16rem column. `<ConversationList />` goes between the brand header and the bottom user block, replacing the current `New Chat` button + `NavItem` nav (keep `Memory` / `Profile` / `Settings` as disabled items **below** the list, or drop them — they are non-functional placeholders; recommend keeping them below the list to preserve the existing look).
- **Mobile (below `sm:`)** — the same `<ConversationList />` inside a `framer-motion` drawer:
  - A backdrop `motion.div` (`fixed inset-0 bg-ink/70 z-40`) fading `opacity 0→1`, click closes.
  - A `motion.aside` (`fixed inset-y-0 left-0 w-[82vw] max-w-xs z-50`) sliding `x: '-100%' → 0`, `transition={{ type: 'spring', damping: 30, stiffness: 300 }}`.
  - Wrapped in `<AnimatePresence>`, rendered when `isSidebarOpen`.
  - Escape key closes (`useEffect` keydown listener).
  - Focus moves to the drawer's close button on open, returns to the hamburger on close.
  - `role="dialog"` + `aria-modal="true"` + `aria-label="Conversations"`.
  - Lock body scroll while open (`document.body.style.overflow = 'hidden'` in an effect, restored on cleanup).

**Task F.4.3 — Header: hamburger + active title**
→ file: `client/src/pages/ChatPage.tsx`, the `<header>` block

- Prepend a hamburger button, `className="sm:hidden"`, min 44×44 tap target, `aria-label="Open conversations"`, `aria-expanded={isSidebarOpen}` → `setSidebarOpen(true)`.
- Next to it, the active conversation title, truncated, `font-display text-base`. This satisfies target-state item 7 on mobile, where no sidebar is visible.
- The header currently uses `justify-end`; change to `justify-between` with the left group (hamburger + title) and the existing right group (Voice / Personas / Sign out).
- On desktop the title is redundant with the highlighted sidebar row — render it anyway, it is cheap and unambiguous.

**Task F.4.4 — Disable input while loading**
→ file: `client/src/components/ChatInput.tsx`

Subscribe to `isLoadingConversation` and include it in the existing disabled condition for the textarea, send button, and mic button. Placeholder becomes `"Loading…"` while true.

**Task F.4.5 — Loading state in the transcript**
→ file: `client/src/components/ChatWindow.tsx`

The existing `if (!activeConversation)` branch renders `· connecting ·`. Split it: when `isLoadingConversation` show `· loading ·`; otherwise keep `· connecting ·`. Small change, but it keeps a switch from looking like a reconnect.

### Backend tasks

None.

### New dependencies

None. `framer-motion` and Tailwind are already in `client/package.json`.

### Edge cases

- **Drawer open while a stream is running** — allowed; the transcript keeps streaming behind the backdrop. Tapping a different conversation aborts it (Phase 3 behavior).
- **Very long title** — single-line `truncate`; the full text goes in `title=` for a native tooltip.
- **Title is still `"New Conversation"`** (created, never messaged) — render it in italic dimmed style so it reads as a placeholder.
- **Orientation change / resize across the `sm` breakpoint while the drawer is open** — the drawer is `sm:hidden`; on widening it vanishes and the permanent sidebar appears. Reset `isSidebarOpen` to `false` on a `matchMedia('(min-width: 640px)')` change so the backdrop cannot strand a locked body scroll. **This is the one to get right — a stuck `overflow: hidden` on `body` makes the app look frozen.**
- **List longer than the viewport** — the `<nav>` scrolls independently (`overflow-y-auto flex-1`), the New Chat button and user block stay pinned.
- **Timestamp staleness** — `formatRelative` is computed at render; the list re-renders on every store change, which is frequent enough. No interval timer.

### Verification

1. Desktop: sidebar lists conversations newest-first with previews. Click a different one → transcript swaps, that row highlights, header title updates.
2. Click `New Chat` → a new empty conversation appears at the top, is active, transcript shows the suggested-prompt empty state.
3. Send a message in it → the sidebar row's title changes from "New Conversation" to the message's first 50 chars, and it stays at the top.
4. Mobile (DevTools 390×844): sidebar is gone, hamburger visible. Tap → drawer slides in over a dimmed backdrop. Tap a row → drawer closes, conversation switches. Tap backdrop / press Escape → closes. Page behind never scrolls while open.
5. Resize from 390px to 900px with the drawer open → drawer disappears, page scrolls normally.
6. Start a stream, open the drawer, tap another conversation → stream stops, TTS silences, new transcript loads.
7. Keyboard only: Tab reaches the hamburger, Enter opens, focus lands inside the drawer, Escape closes and focus returns to the hamburger.

---

## Phase 5: Rename & Delete UI

**Goal:** The user can rename a conversation inline and delete one, with confirmation and correct fallback.

### Frontend tasks

**Task F.5.1 — Row actions menu**
→ file: `client/src/components/ConversationList.tsx`

Each row gains a trailing `⋯` button (`aria-label="Conversation options"`, `aria-haspopup="menu"`), revealed on hover/focus on desktop and always visible on touch (`sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100`). Opens a small popover with `Rename` and `Delete`.

Popover implementation: local `useState<string | null>(openMenuId)`, absolutely positioned, closed on outside click (document `mousedown` listener), Escape, and on any `switchConversation`. No dependency — Radix or Headless UI would be justified only if this app grows several more menus; one menu does not earn 40kB.

**Task F.5.2 — Inline rename**
→ file: `client/src/components/ConversationList.tsx`

`Rename` swaps the row's title into a controlled `<input>`, pre-filled and text-selected, `maxLength={100}`.
- Enter or blur → `renameConversation(id, value.trim())`, exit edit mode.
- Escape → discard, exit edit mode.
- Empty or unchanged value → exit without an API call.
- While editing, clicking the row does not switch conversations (stop propagation).

**Task F.5.3 — Delete with confirmation**
→ new file: `client/src/components/ConfirmDialog.tsx`

A small reusable `framer-motion` modal: `title`, `body`, `confirmLabel`, `onConfirm`, `onCancel`. `role="alertdialog"`, `aria-modal`, focus trapped, Escape cancels, initial focus on Cancel (destructive default). Confirm button styled destructive (red-tinted border, not the ember accent).

Wired from the row menu's `Delete`, with body copy naming the conversation: *"Delete "Lisbon trip"? This can't be undone."* On confirm → `deleteConversation(id)`, dialog closes, sidebar row disappears; if it was active, the store falls back per Phase 3.

`window.confirm` would work and cost nothing — but it is unstyled, blocks the main thread, and looks broken next to this design. The component is ~50 lines.

**Task F.5.4 — Error surfacing**
→ file: `client/src/pages/ChatPage.tsx`

`error` in `chatStore` is currently set but never rendered anywhere. Add a dismissible toast: fixed bottom-center, ember-bordered, auto-dismiss after 5s, click to dismiss (`clearError()`). Without it, every failure in Phases 3–5 is silent.

### Backend tasks

None — `PATCH /:id` and the soft-delete `DELETE /:id` ship in Phase 2.

### Edge cases

- **Rename to the same title** — no API call.
- **Rename while a stream is running in that conversation** — allowed; independent writes, different fields.
- **Rename fails** — the optimistic title reverts and the toast explains. The input has already closed; do not reopen it.
- **Delete the active conversation** — Phase 3's fallback runs; the user lands on the next-newest, or a freshly seeded one.
- **Delete a conversation that a second tab already deleted** — server returns 404, client treats it as success and removes the row.
- **Menu open when the list re-sorts** (a reply lands and bumps another conversation) — close the menu on any `conversations` identity change, so the popover never detaches from its row.
- **Long title in the confirm dialog** — truncate to 40 chars with an ellipsis inside the copy.

### Verification

1. Hover a row → `⋯` appears. Click → menu with Rename / Delete.
2. Rename → input appears text-selected. Type, Enter → title updates instantly. Reload → persisted.
3. Rename, then Escape → original title, no network request in the Network tab.
4. Delete a non-active conversation → dialog names it; confirm → row disappears; reload → still gone; `GET /api/conversations` omits it.
5. Delete the active conversation → the app switches to the next one, transcript loads, no blank screen.
6. Delete the only conversation → a fresh empty one is created and opened.
7. Kill the server, attempt a rename → title reverts, toast reads the error, app stays usable.
8. Mobile: the `⋯` is visible without hover and is at least 44×44.

---

## API Reference (New / Modified Endpoints)

All routes are under `/api/conversations` and behind `requireAuth` (cookie JWT). `401` on missing/invalid session throughout.

| Method | Route | Body / Query | Response (200 unless noted) | Auth | Description |
|---|---|---|---|---|---|
| GET | `/api/conversations` | query `limit?: 1–50` (default 30), `before?: ISO date` | `{ success, data: { conversations: ConversationSummary[], hasMore: boolean } }` | required | **Modified.** Paginated, excludes archived, includes `messageCount` + `lastMessagePreview`. |
| GET | `/api/conversations/default` | — | `{ success, data: { conversation, persona } }` | required | **Modified (internally).** Now returns the *most recently active* conversation. Shape unchanged. |
| POST | `/api/conversations` | `{ personaId: string, avatarId: string, title?: string ≤100 }` | `201 { success, data: { conversation: { id, title, personaId, avatarId, createdAt } } }` | required | Unchanged. |
| GET | `/api/conversations/:id` | — | `{ success, data: { conversation: { id, title, personaId, avatarId, messages, createdAt, lastMessageAt } } }` | required | Unchanged. `404` when not owned. |
| PATCH | `/api/conversations/:id` | `{ title: string, 1–100 after trim }` | `{ success, data: { conversation: { id, title, titleIsCustom, lastMessageAt } } }` | required | **New.** Rename. `400` invalid title, `404` not owned or archived. |
| DELETE | `/api/conversations/:id` | — | `{ success, message: 'Conversation deleted' }` | required | **Modified.** Now a soft delete (`isArchived: true`). `404` when not owned or already archived. |
| POST | `/api/conversations/:id/messages/stream` | `{ message: string, 1–10000 }` | `text/event-stream` — `state` / `token` / `done` / `error` frames | required + `chatRateLimiter` | **Modified.** `404` when the conversation is archived. Auto-titles on the first message. |

`ConversationSummary` = `{ id, title, titleIsCustom, personaId, avatarId, messageCount, lastMessagePreview, lastMessageAt, createdAt }`.

---

## Schema Diff

### `server/src/models/Conversation.ts`

**Removed**

```
conversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })   // TTL — deletes history
conversationSchema.index({ userId: 1, lastMessageAt: -1 })              // superseded
```

**Added fields**

```
messageCount:       { type: Number,  default: 0 }
lastMessagePreview: { type: String,  default: '', maxlength: 120, trim: true }
isArchived:         { type: Boolean, default: false }
deletedAt:          { type: Date,    default: null }
titleIsCustom:      { type: Boolean, default: false }
```

**Added index**

```
conversationSchema.index({ userId: 1, isArchived: 1, lastMessageAt: -1 })
```

**Unchanged but noted:** `expiresAt` remains as a field (no longer written or enforced); `title` already existed with `default: 'New Conversation'`.

**`IConversation` interface** — five additions matching the fields above.

**`addMessage` method** — drops the `expiresAt` reset; gains `messageCount` increment and `lastMessagePreview` assignment.

### `server/src/models/Persona.ts`, `User.ts`

No changes.

---

## State Store Diff

### `client/src/stores/chatStore.ts`

**Added state**

```ts
activeConversationId: string | null;   // null
isLoadingConversation: boolean;        // false
isLoadingList: boolean;                // false
hasMoreConversations: boolean;         // false
isSidebarOpen: boolean;                // false
```

**Added actions**

```ts
switchConversation: (id: string) => Promise<void>;
startNewConversation: () => Promise<string | null>;
renameConversation: (id: string, title: string) => Promise<void>;
setSidebarOpen: (open: boolean) => void;
```

**Changed signatures / behavior**

```ts
fetchConversations: (opts?: { append?: boolean }) => Promise<void>;  // was: () => Promise<void>
deleteConversation: (id: string) => Promise<void>;                  // same signature; now aborts an
                                                                    // active stream and falls back
openDefaultConversation: () => Promise<void>;                       // same signature; also sets
                                                                    // activeConversationId
sendMessage: (content: string) => Promise<void>;                    // same signature; now guards on
                                                                    // activeConversationId and
                                                                    // updates the list entry
```

**Unchanged:** `conversations`, `activeConversation`, `avatarState`, `isStreaming`, `streamingContent`, `error`, `ttsEnabled`, `createConversation`, `openConversation`, `abortStream`, `clearError`, `toggleTts`.

> `createConversation` and `openConversation` stay as the thin API wrappers they are today; `startNewConversation` and `switchConversation` are the higher-level actions the UI calls. Keeping both avoids rewriting the existing call sites.

### `client/src/stores/personaStore.ts`, `authStore.ts`

No changes.

---

## Phase Dependency Summary

```
Phase 1 (backend, durability)   ──▶ everything
Phase 2 (backend, lifecycle)    ──▶ Phase 3
Phase 3 (store)                 ──▶ Phase 4 ──▶ Phase 5
```

Phases 1 and 2 are backend-only and invisible to the current client. Phase 3 is store-only and invisible to the current UI. The single-conversation flow keeps working at every point: `openDefaultConversation` is never removed, and `ChatPage`'s existing structure is extended rather than replaced.
