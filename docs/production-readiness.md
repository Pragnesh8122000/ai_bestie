# Current-version production readiness

Date: 2026-09-16. Scope: stabilize existing chat, history switching, microphone
input, and voice replies before adding features. Expected usage: fewer than
100 simultaneous users. Hosted release readiness is **not yet established**.

## Implemented

- Streaming requires explicit completion. Interrupted, malformed, and empty
  replies fail visibly; stale callbacks and duplicate completion frames cannot
  update another conversation or append another assistant message.
- Speech fetches have cancellation and deadlines. Cancelling playback settles
  the queue even when a browser emits no end event. Audio failures show a toast,
  and the orb follows playback. Mic recognition times out, avoids duplicated
  cumulative transcripts, and stops on conversation changes or unmount.
- Default loading no longer races history switching. New-chat, rename, delete,
  and logout ignore superseded responses. Logout clears private state immediately;
  old auth, history, and persona responses cannot restore it. Failed sends reload saved history to resolve optimistic messages.
- Assistant completion IDs match persisted MongoDB message IDs. Persona ownership
  is checked; tied pagination timestamps use an ID cursor. One backend process
  rejects overlapping replies to the same conversation with HTTP 409.
- History summaries omit message arrays, and model context reads only the latest
  20 messages. Streaming avoids repeated smooth-scroll work. Chat loads separately
  from login to reduce the initial JavaScript bundle.
- Providers have 5-second connection and first-token deadlines. Fallback is
  allowed before output, while partial output is never spliced with another
  provider's response. The overall chat deadline remains 30 seconds.
- Neural TTS admits at most eight active/queued requests per process and rejects
  overload with 503. Cancelled queued inference is skipped. Native inference
  already running cannot safely be interrupted; its result is discarded.
- Root startup delegates to the server workspace. Native library lookup covers
  hoisted dependencies, static paths work in source and compiled layouts, and
  shutdown drains connections with a 10-second limit. Auth runs before API rate
  limiting so users have separate buckets. JSON input has bounded, clear errors.
- `/api/health` is liveness. `/api/ready` checks database connectivity and model
  key presence and reports voice availability. It does not verify provider key
  validity or remaining quota. Request IDs and route timings omit transcripts,
  credentials, and raw conversation IDs.
- ESLint flat configuration is restored. Compatible dependency fixes and the
  Vitest upgrade remove the vulnerabilities reported by npm audit.

## Local verification receipt

| Check | Result and limits |
| --- | --- |
| Tests | 237 passed: 56 server, 181 client |
| Lint | Both workspaces passed |
| Production build | Passed; initial JS 443.68 kB / 144.07 kB gzip; chat chunk 191.23 kB / 57.72 kB gzip |
| Dependency audit | Zero reported vulnerabilities after updates |
| Real chat and MongoDB | Completed SSE text equals refreshed saved content; completion ID matches saved ID; overlapping send returns 409 |
| History | Local indexes have no TTL; tied-timestamp cursor returns distinct pages |
| Neural TTS | Three real WAV responses: 2029, 1922, 1943 ms; valid RIFF/WAVE. Health during synthesis: 2 ms |
| Concurrent reads | 99 authenticated identities, 99 successful indexed history reads, local p95 38 ms |
| Provider latency | Latest single reply: first token 2632 ms, completion 2642 ms. Earlier first-token samples: 3326 and 20251 ms |
| Compiled startup | Root `npm start` with local development environment, port 3002, TTS disabled: startup, readiness, and SIGTERM exit passed |
| Browser review | Local Brave login and chat controls inspected. Full post-fix playback, mobile, and mic permissions walkthrough remains pending |

Latency samples are observations on the developer machine, not service-level
promises. The concurrent check reads empty history lists with distinct signed
test identities; it does **not** simulate 99 active model streams, voice requests,
or fully populated accounts. No hosted load or memory benchmark was completed.

Run `npm test`, `npm run lint`, and `npm run build`. The repeatable real integration
check is `npm run verify-readiness -w server`, with the local server and MongoDB
running and real model credentials configured. It refuses non-local server and
database targets, creates isolated test data, and deletes only its own records.
It reads indexes and never performs a migration.

## Hosting information still needed

Provide frontend and backend staging origins, hosting provider, instance CPU/RAM,
process count, idle behavior, proxy path, database environment, and required
browsers. Repository Vercel/Render domains are examples, not verified deployments.

The concurrency guard and TTS queue are in-memory. Validate one backend process
first. Multiple processes require a shared concurrency design before claiming
same-conversation guarantees across instances. Fewer than 100 online users does
not mean 99 people can generate neural voice at once. Agree on realistic active
chat and voice traffic and measure the actual instance.

## Remaining release gates

1. Validate HTTPS, secure cookie forwarding, authenticated API/TTS, avatar routing,
   unbuffered SSE, and direct SPA refresh through the real proxy. Confirm that
   its hop count matches Express's current `trust proxy: 1`.
2. Back up the target database, inspect TTL indexes and lifecycle fields, and
   apply the existing multi-conversation migration if needed. Local verification
   does not establish hosted migration status. Preserve retained history during
   rollback; never restore a destructive TTL index.
3. Run desktop/mobile browser checks for voice on/off, interruption, mic denied
   or unavailable, switching during speech, logout during requests, offline and
   reconnect, provider failure, and refresh after completion.
4. Measure warm/cold first-text and first-audio latency, playback gaps, cancellation,
   RSS, queue saturation, and event-loop response under agreed active traffic.
   The proposed discussion p95 targets remain unverified; a single sample cannot
   establish them.
5. Verify production environment configuration, native model files, startup,
   health/readiness, and graceful shutdown on the intended host. The local
   compiled startup check used development environment settings.

Rollback uses the previous application build and lockfile, followed by staging
smoke checks. New message IDs are additive. No destructive database migration
was performed in this stabilization work. Back up before any database operation.
