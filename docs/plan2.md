> ⚠️ **SUPERSEDED — working notes, kept for history.** This was a follow-up
> brainstorm iterating on the original Phase 1 design (photorealistic avatars,
> gallery, voice, paid-tier dependencies). The shipped phase was re-scoped to a
> simple free-tier voice chat with one hard-coded "Friend" persona (Sam) and
> none of the architecture described here. Do not implement from this document;
> see [architecture.md](./architecture.md) and [deployment.md](./deployment.md)
> for what actually ships.

Pillar 1 — Locked (with your answers)

Good. Photorealistic + gallery + voice in Phase 2 changes the architecture meaningfully. Let me revise.

---
Revised Analysis: Photorealistic Avatars

Photorealistic faces work differently from illustrated ones. Here's the key problem:

Expression swapping with photos is hard. Switching between avatar-happy.jpg and avatar-sad.jpg of the same "person" looks jarring unless the photos are shot/generated with identical lighting, angle, and background. Most stock photo sets don't have this consistency. And AI-generated expression variants of the same face require careful seed control.

This means the common "5-8 expression states" approach needs adjustment for photorealistic avatars. Here are the viable approaches:

┌───────────────────────┬───────────────────────────────────────────────────────────┬───────────────────────────────────────────────┬────────────────┐
│       Approach        │                       Phase 1 Look                        │                 Voice-Ready?                  │   Complexity   │
├───────────────────────┼───────────────────────────────────────────────────────────┼───────────────────────────────────────────────┼────────────────┤
│ A. Single photo + CSS │ Static realistic face. "Thinking" = slow pulse/glow       │ ✅ Voice in Phase 2 works — avatar shows      │                │
│  animation states     │ border. "Speaking" = waveform animation overlay.          │ speaking animation while TTS plays audio. No  │ ★☆☆☆☆          │
│                       │ "Listening" = subtle breathing animation.                 │ lip-sync needed.                              │                │
├───────────────────────┼───────────────────────────────────────────────────────────┼───────────────────────────────────────────────┼────────────────┤
│ B. AI-generated       │ Same face, 4-5 expressions generated via Stable Diffusion │ ✅ Works, but switching photos                │                │
│ consistent expression │  with ControlNet or IP-Adapter for face consistency. Swap │ mid-conversation can feel uncanny.            │ ★★★☆☆          │
│  set                  │  on sentiment.                                            │                                               │                │
├───────────────────────┼───────────────────────────────────────────────────────────┼───────────────────────────────────────────────┼────────────────┤
│ C. D-ID/HeyGen from   │ Photorealistic talking video. Highest "wow."              │ ✅ Built for voice.                           │ ★★★★★ (cost +  │
│ Day 1                 │                                                           │                                               │ latency)       │
└───────────────────────┴───────────────────────────────────────────────────────────┴───────────────────────────────────────────────┴────────────────┘

---
🎯 Locked Recommendation for Pillar 1

Phase 1 MVP: Approach A — Single photorealistic image + CSS animation states

Here's exactly how it works:

┌─────────────────────────────────────────────┐
│  Avatar Component Architecture               │
│                                             │
│  <AvatarCard>                               │
│    ┌──────────────┐                          │
│    │  Photo of    │  ← Single high-res       │
│    │  "person"    │     realistic face         │
│    │              │     (webp, ~200KB)         │
│    └──────────────┘                          │
│    ┌──────────────┐                          │
│    │  ◉ Speaking   │  ← CSS animation layer   │
│    │  ↻ Thinking   │     overlaid (not a      │
│    │  ✓ Listening  │     different photo)     │
│    └──────────────┘                          │
│                                             │
│  State machine:                             │
│  idle → thinking (LLM call starts)          │
│  thinking → speaking (LLM stream starts)    │
│  speaking → listening (user starts typing) │
│  listening → thinking (next turn)           │
│                                             │
│  CSS Effects per state:                     │
│  thinking: soft radial pulse + "..." dots   │
│  speaking:  audio waveform bar animation     │
│  listening: subtle brightness increase       │
│  idle:      gentle breathing scale loop      │
└─────────────────────────────────────────────┘

Why this wins for your stack:

1. Zero latency — CSS animations are local, instant, no API call for expression changes
2. Gallery model fits perfectly — you ship 8-12 realistic face images. Each is just a .webp file in /public/avatars/. User picks one.
3. Phase 2 voice path is clean — when you add TTS, the avatar already has a "speaking" animation state. You just wire audio playback to it. The user hears voice + sees the speaking animation. No lip-sync needed.
4. Mobile-ready — CSS animations + single image = trivial React Native port. The same <Avatar> component maps to a <View> with Animated API.
5. Cost: $0 per interaction. No external avatar API.

Gallery specification:

/public/avatars/
  ├── male-01.webp      ← AI-generated photorealistic face
  ├── male-02.webp         (generated via Midjourney / SD3 /
  ├── male-03.webp          Adobe Firefly with consistent
  ├── female-01.webp       lighting/neutral expression)
  ├── female-02.webp
  ├── female-03.webp
  └── manifest.json      ← { id, name, src, attribution }

Each avatar is one neutral-expression photo. The "emotion" comes from the CSS overlay, not from swapping to a different photo.

Phase 2 voice upgrade path:

Phase 1: Photo + CSS animation + text chat
   ↓
Phase 2: Photo + CSS animation + TTS audio stream
   ↓       (avatar "speaks" with waveform animation
   ↓        while audio plays through speakers)
   ↓
Phase 3 (optional): D-ID/HeyGen talking video
              (only if lip-sync is a must-have)

Most successful companion apps (Character.AI, Pi by Inflection, Replika in its early days) started exactly this way — static or minimally animated avatar + text, then added voice. None led with video generation.

---
📋 Pillar 1 — Finalized Spec

┌─────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────────────────────┐
│          Decision           │                                              Choice                                               │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Visual representation       │ Single photorealistic static image per avatar                                                     │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Animation/emotion           │ CSS-based animation states (pulse, waveform, breathing) — no photo swapping                       │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Customization               │ Gallery of 8-12 AI-generated realistic faces. User picks one. No upload in MVP (moderation risk). │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Avatar state machine        │ idle → thinking → speaking → listening (4 states)                                                 │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Phase 2 voice compatibility │ TTS audio + speaking animation overlay. No lip-sync video.                                        │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Mobile portability          │ CSS → React Native Animated API (1:1 mapping)                                                     │
├─────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────────────────────┤
│ Image format                │ WebP, ~200KB per face, served from /public/avatars/                                               │
└─────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────────────────────┘

---
Now let's move to Pillar 2.

---
Pillar 2: Interaction Mode

Industry Options

┌─────────────────┬───────────────────────────────────────────────┬───────────────────────────┬──────────────────────────┬───────────────────────────┐
│     Option      │                User Experience                │      MERN Complexity      │    Streaming Latency     │    Mobile Feasibility     │
├─────────────────┼───────────────────────────────────────────────┼───────────────────────────┼──────────────────────────┼───────────────────────────┤
│ A. Text-only    │ Classic chat interface. User types, avatar    │ ★☆☆☆☆ — Standard chat UI. │ 200-500ms (LLM streaming │ ★★★★★ — Native keyboard + │
│                 │ types back.                                   │                           │  first token)            │  scroll                   │
├─────────────────┼───────────────────────────────────────────────┼───────────────────────────┼──────────────────────────┼───────────────────────────┤
│ B. Voice-only   │ User speaks, avatar speaks back. No text      │ ★★★★☆ — STT + TTS         │ 1.5-4s total roundtrip   │ ★★★☆☆ — Mic permissions,  │
│                 │ interface.                                    │ pipeline, audio handling  │                          │ background audio          │
├─────────────────┼───────────────────────────────────────────────┼───────────────────────────┼──────────────────────────┼───────────────────────────┤
│ C. Text + Voice │ Text chat is primary. User can tap mic to     │ ★★★☆☆ — Text is base,     │ Same as A for text;      │ ★★★★☆ — Graceful          │
│  (dual)         │ speak, avatar responds with voice AND text.   │ voice is additive         │ 1.5-4s for voice turns   │ degradation               │
└─────────────────┴───────────────────────────────────────────────┴───────────────────────────┴──────────────────────────┴───────────────────────────┘

Deep Dive: Technical Complexity in MERN Stack

Text-Only (Option A)
User types message
    ↓
React state update (instant)
    ↓
POST /api/chat { message, avatarId, conversationHistory }
    ↓
Node.js → LLM API (streaming SSE)
    ↓
React renders tokens as they arrive
    ↓
Avatar state: thinking → speaking (streaming)

- Implementation time: 1-2 weeks for a solid streaming chat
- Key libraries: @ai-sdk/anthropic or OpenAI SDK with streaming, Server-Sent Events on Express
- Latency: First token in 200-500ms. Perceived responsiveness is excellent with streaming.
- Risk: Nearly zero. This is a solved problem in MERN.

Voice-Only (Option B)

User taps mic, speaks
    ↓
Browser MediaRecorder API → audio blob
    ↓
POST /api/stt { audioBlob }
    ↓
Node.js → STT API (Deepgram/Whisper)
    ↓
Transcribed text (1-3s latency)
    ↓
Same as text pipeline (LLM streaming)
    ↓
Full text response → TTS API (ElevenLabs/OpenAI TTS)
    ↓
Audio stream back to browser
    ↓
Play via Web Audio API + avatar speaking animation

- Implementation time: 3-5 weeks additional beyond text
- Key libraries: MediaRecorder API, @deepgram/sdk or OpenAI Whisper API, ElevenLabs API or OpenAI TTS, EventSource for streaming audio
- Latency breakdown:
  - STT: 500ms-2s (depends on audio length)
  - LLM: 200-500ms to first token
  - TTS: 500ms-1.5s for first audio chunk (streaming TTS reduces this)
  - Total: 1.2-4s before user hears first word
- Risks:
  - Mic permissions on mobile browsers are inconsistent
  - Background audio handling differs across mobile browsers
  - STT accuracy degrades with accents, background noise
  - Cost multiplier: STT (~$0.006/min) + TTS (~$0.18-0.30/min) on top of LLM costs

Text + Voice (Option C)

Same as Option A, plus voice as an additive feature. User can type OR tap mic. Avatar always responds in text. Voice responses are optional.

- Implementation time: 2 weeks for text + 2-3 weeks for voice add-on
- Key insight: Voice is a mode, not the default. This means you can ship text first and add voice incrementally.

---
🎯 My MVP Recommendation: Option A (Text-only) for MVP, Option C (Text + Voice) in Phase 2

Why text-only for Phase 1:

1. Product validation first. You need to validate that people want to talk to this avatar, that the persona system works, that the "learning" mechanism is valuable. None of these require voice. If text doesn't engage users, voice won't save it.
2. Engineering focus. Your complexity budget should go toward Pillar 3 (Persona) and Pillar 4 (RAG/Learning) — those are your differentiators. Voice is table stakes, not a moat.
3. Cost discipline. A text-only MVP costs ~$0.002-0.01 per conversation (just LLM tokens). Adding voice triples that. Until you have user validation, you're burning 3x per conversation.
4. Mobile portability. React Native chat is trivial. React Native audio recording/playback has edge cases (permissions, background audio, Bluetooth routing). Ship text, validate, then tackle audio.

Phase 2 voice architecture (preview, to lock the path):

Phase 2 adds:
- Mic button in chat input bar (next to send button)
- Web Speech API or Deepgram for STT
- ElevenLabs or OpenAI TTS for avatar voice
- Streaming audio via chunked transfer
- Same avatar state machine, "speaking" state now plays audio

---
Clarifying Questions for You (Pillar 2)

1. Conversational memory scope: For MVP text chat, should the avatar remember the full conversation history within a session, or should it also remember across sessions (e.g., "Last time we talked about your fear of public speaking..."). Cross-session memory requires persistent storage (MongoDB) and affects your RAG architecture in Pillar 4. Do you want session-only or persistent memory for MVP?
2. Streaming UX preference: When the avatar "types back," do you want:
  - (a) Token streaming — characters appear one by one as the LLM generates them (like ChatGPT) — feels alive, responsive
  - (b) Typing indicator + full response — user sees "avatar is thinking..." then gets the full message at once — simpler, but feels slower
(I strongly recommend (a) — it's expected for chat apps and pairs well with your avatar state machine)
3. Multi-turn context window: How many previous messages should the avatar consider when responding? Options:
  - Last 10 messages (cheap, fast, may lose early context)
  - Last 20 messages (balanced)
  - Full conversation history (expensive, hits token limits, best quality)
(This directly impacts your LLM cost per conversation)

Answer these and we lock Pillar 2, then move to Pillar 3: Persona System.