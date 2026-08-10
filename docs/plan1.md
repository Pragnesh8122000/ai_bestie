> ⚠️ **SUPERSEDED — working notes, kept for history.** This brainstorm captured
> the original Phase 1 design (photorealistic avatar gallery, archetype wizard,
> semantic/episodic memory, vector search, paid LLM tiers). The shipped phase
> was re-scoped to a simple free-tier voice chat with one hard-coded "Friend"
> persona (Sam). Do not implement from this document; see
> [phase-1-specification.md](./phase-1-specification.md) (also superseded) and
> the current [architecture.md](./architecture.md) / [deployment.md](./deployment.md).

AI Avatar Companion — Phase 1 Specification

Great approach. No code until decisions are locked. Let's build this north star document pillar by pillar.

---
Pillar 1: Avatar Visuals

Industry Options

┌─────────────────────┬─────────────────────────────────────────┬────────────────────────────────────┬──────────────────┬────────────────────────────┐
│       Option        │              How It Works               │              MERN Fit              │     Latency      │     Mobile Scalability     │
├─────────────────────┼─────────────────────────────────────────┼────────────────────────────────────┼──────────────────┼────────────────────────────┤
│                     │ Single illustration (PNG/WebP)          │ ★★★★★ — Simple <img> tag. Zero     │ N/A (no          │                            │
│ A. Static 2D Image  │ displayed alongside chat. Avatar has no │ dependencies.                      │ animation)       │ Trivial — responsive image │
│                     │  motion.                                │                                    │                  │                            │
├─────────────────────┼─────────────────────────────────────────┼────────────────────────────────────┼──────────────────┼────────────────────────────┤
│                     │ Frame-based or CSS-animated avatar      │ ★★★★☆ — Lottie/Rive have excellent │                  │                            │
│ B. Animated 2D      │ (Lottie, Rive, or sprite sheet).        │  React libs (@lottiefiles/react,   │ ~0ms (local      │ Good — Lottie/Rive are     │
│ Sprite              │ Expressions change based on             │ rive-react).                       │ playback)        │ mobile-native              │
│                     │ mood/context.                           │                                    │                  │                            │
├─────────────────────┼─────────────────────────────────────────┼────────────────────────────────────┼──────────────────┼────────────────────────────┤
│                     │ Full-body 3D avatar rendered via        │ ★★★☆☆ — Adds three.js,             │ 50-200ms for     │ Complex — WebGL on mobile  │
│ C. 3D Model (Ready  │ Three.js/React Three Fiber.             │ @react-three/fiber,                │ expression       │ browsers has               │
│ Player Me)          │ Customizable appearance.                │ @react-three/drei. Bundle +200KB   │ morphs           │ performance/hit issues     │
│                     │                                         │ gzipped.                           │                  │                            │
├─────────────────────┼─────────────────────────────────────────┼────────────────────────────────────┼──────────────────┼────────────────────────────┤
│ D. AI-Generated     │ Server-side video generation from text. │ ★★☆☆☆ — Requires external API,     │ 2-8s initial,    │ Worst — bandwidth-heavy,   │
│ Video (D-ID/HeyGen) │  Avatar "speaks" with realistic         │ WebSocket streaming, significant   │ ~500ms per       │ codec issues on older      │
│                     │ lip-sync.                               │ server cost.                       │ segment after    │ devices                    │
├─────────────────────┼─────────────────────────────────────────┼────────────────────────────────────┼──────────────────┼────────────────────────────┤
│ E. Hybrid: Static + │ Static avatar image that swaps          │                                    │                  │                            │
│  Animated           │ expressions (emoji-like) based on       │ ★★★★★ — Pure React state + CSS     │ ~0ms             │ Excellent — just image     │
│ Expressions         │ conversation sentiment. Light CSS       │ transitions.                       │                  │ swaps                      │
│                     │ transitions between states.             │                                    │                  │                            │
└─────────────────────┴─────────────────────────────────────────┴────────────────────────────────────┴──────────────────┴────────────────────────────┘

Pros/Cons Deep Dive (MERN-specific)

Static 2D Image
- ✅ Zero implementation complexity
- ✅ Fastest load time, smallest bundle
- ✅ Easy to let users upload custom images
- ❌ Feels "lifeless" — undermines the "companion" emotional bond
- ❌ No visual feedback during response generation (users see nothing while waiting)

Animated 2D (Lottie/Rive)
- ✅ Rive is specifically designed for interactive state machines — you can wire avatar states (idle, talking, thinking, happy, sad) directly to React state
- ✅ Rive's runtime is ~130KB, renders at 60fps even on low-end devices
- ✅ Artists can create in Rive Editor, devs consume via rive-react — clean separation
- ✅ Web AND mobile (Rive has Flutter, iOS, Android runtimes)
- ❌ Requires upfront design investment (or purchase of pre-made Rive assets)
- ❌ Slightly more complex state management (but Rive's state machine handles most of it)

3D Model (Ready Player Me)
- ✅ Users love customization — "make it look like me" is a strong hook
- ✅ Ready Player Me has a great web SDK (@readyplayerme/rpm-react-sdk)
- ❌ Bundle size impact is significant on mobile web
- ❌ Lip-sync for voice requires morph targets + audio analysis — non-trivial
- ❌ React Native compatibility requires react-native-three-fibers (less mature)
- ❌ User expectations become "metaverse quality" — hard to scale back

AI-Generated Video (D-ID/HeyGen)
- ✅ Most "wow factor" — looks like a real person talking
- ✅ D-ID's API is well-documented, WebSocket-based streaming available
- ❌ Latency killer: 2-8 seconds initial render, even streaming has noticeable lag
- ❌ Cost: ~$0.06-0.12 per 15 seconds of video at scale
- ❌ Uncanny valley effect on lower-quality tiers
- ❌ Mobile bandwidth consumption is 10-50x text
- ❌ Hard to pause/resume mid-stream (user wants to interrupt)

Hybrid (Static + Expression Swaps)
- ✅ Best effort-to-impact ratio for MVP
- ✅ 5-8 expression states cover 90% of emotional feedback needs
- ✅ Can evolve to Rive/Lottie later without architecture change
- ✅ Users understand it immediately (WhatsApp stickers work this way)
- ❌ Less "impressive" than 3D or video
- ❌ Limited animation vocabulary (no head nods, gestures)

---
🎯 My MVP Recommendation: Option E (Hybrid) → Option B (Rive) in Phase 2

Why: The emotional core of your app is the conversation, not the visual fidelity. A static avatar with expression swaps gives you:
1. Sub-100ms visual feedback while the LLM streams text
2. Near-zero implementation time (focus engineering on the LLM/persona/RAG layer)
3. A clean abstraction: avatarState = "thinking" | "talking" | "listening" | emotion — this same state machine feeds Rive in Phase 2 or 3D morph targets later

Migration path: Your React component becomes <Avatar state={currentEmotion} />. Phase 1 renders image swaps. Phase 2 swaps in Rive. Phase 3 optionally adds 3D. The state interface never changes.

Clarifying Questions for You (Pillar 1)

1. Art style direction: Do you want the avatar to be illustrated/cartoon (think Duolingo owl, Replika's anime style) or photorealistic (think D-ID output)? This determines whether Rive makes sense in Phase 2 vs. whether you'd skip straight to D-ID later.
2. Customization depth in MVP: Should users be able to pick from a gallery of pre-made avatars (5-10 options), or upload their own image? Gallery is faster to build; upload increases emotional investment but adds moderation overhead.
3. Voice ambition: You mentioned "if voice is added later." If you know you want voice in Phase 2, that pushes toward Rive (Option B) now because Rive state machines already handle lip-sync viseme mapping — you'd be building the visual foundation for voice. If voice is a "maybe someday," Hybrid is fine. How committed are you to voice within the first 6 months?

---
Answer these three and we'll lock Pillar 1, then move to Pillar 2: Interaction Mode.