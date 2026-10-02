/**
 * Per-turn timeline of the browser half of a voice turn: mic registration,
 * speech recognition (or upload for the server-STT fallback), the chat request,
 * and each TTS chunk from queued → fetched → decoded → scheduled for playback.
 *
 * Every mark is a millisecond offset from the turn's start on the browser's
 * monotonic clock, so no clock sync is needed. The finished trace is posted once
 * to `/api/metrics/voice`, where the server logs it next to its own
 * `stt.transcribe` / `chat.turn` / `tts.synth` lines under the same `turnId`
 * (sent as the `X-Voice-Turn` header). `npm run voice-report -w server` joins them.
 *
 * Timings, sizes and outcome codes only — never transcript, reply or audio.
 */

export const VOICE_TURN_HEADER = 'X-Voice-Turn';

export type VoiceTraceOutcome = 'ok' | 'no_audio' | 'aborted' | 'error';
export type VoiceTracePath = 'browser' | 'server-fallback';
type MetaValue = number | boolean | string;

export interface ChunkTrace {
  /** Record a stage offset (first write wins). */
  mark(stage: ChunkStage, at?: number): void;
  set(fields: Partial<Omit<ChunkRecord, 'seq' | 'chars'>>): void;
}

export type ChunkStage = 'queued' | 'fetchStart' | 'headers' | 'body' | 'decoded' | 'scheduled';

export interface ChunkRecord {
  seq: number;
  chars: number;
  status: 'ok' | 'error' | 'skipped' | 'aborted' | 'local';
  engine?: 'remote' | 'local';
  attempts?: number;
  bytes?: number;
  audioMs?: number;
  queued?: number;
  fetchStart?: number;
  headers?: number;
  body?: number;
  decoded?: number;
  scheduled?: number;
  gapMs?: number;
}

export interface VoiceTrace {
  readonly id: string;
  /** Stage offset since turn start (first write wins). `at` is a performance.now() value. */
  mark(stage: string, at?: number): void;
  has(stage: string): boolean;
  meta(key: string, value: MetaValue): void;
  /** Bump a counter held in meta (e.g. recognition restarts). */
  count(key: string): void;
  setPath(path: VoiceTracePath): void;
  chunk(chars: number, queuedAt?: number): ChunkTrace;
  /** Close the trace and send it. Later calls are ignored. */
  finish(outcome: VoiceTraceOutcome): void;
}

const ENDPOINT = '/api/metrics/voice';
const MAX_CHUNKS = 48;

function newId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function post(body: unknown): void {
  if (typeof fetch === 'undefined') return;
  try {
    // keepalive lets the report survive the tab closing right after a reply.
    void fetch(ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    // Diagnostics must never affect the conversation.
  }
}

export function createVoiceTrace(path: VoiceTracePath = 'browser'): VoiceTrace {
  const id = newId();
  const t0 = performance.now();
  const startedAt = Date.now();
  const stages: Record<string, number> = { 'turn.start': 0 };
  const meta: Record<string, MetaValue> = {};
  const chunks: ChunkRecord[] = [];
  let finished = false;
  let currentPath = path;

  const offset = (at = performance.now()) => Math.max(0, Math.round(at - t0));

  return {
    id,
    mark(stage, at) {
      if (finished || stage in stages) return;
      stages[stage] = offset(at);
    },
    has: (stage) => stage in stages,
    meta(key, value) {
      if (!finished) meta[key] = value;
    },
    count(key) {
      if (finished) return;
      meta[key] = (typeof meta[key] === 'number' ? (meta[key] as number) : 0) + 1;
    },
    setPath(next) {
      currentPath = next;
    },
    chunk(chars, queuedAt) {
      const record: ChunkRecord = { seq: chunks.length + 1, chars, status: 'ok' };
      if (queuedAt !== undefined) record.queued = offset(queuedAt);
      if (chunks.length < MAX_CHUNKS) chunks.push(record);
      return {
        mark(stage, at) {
          if (!finished && record[stage] === undefined) record[stage] = offset(at);
        },
        set(fields) {
          if (!finished) Object.assign(record, fields);
        },
      };
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      const report = {
        turnId: id,
        path: currentPath,
        outcome,
        startedAt,
        stages: { ...stages, 'turn.end': offset() },
        meta,
        chunks,
      };
      if (import.meta.env?.DEV && import.meta.env.MODE !== 'test') {
        console.info(JSON.stringify({ evt: 'voice.turn.trace', ...report }));
      }
      post(report);
    },
  };
}

/* The reply being spoken. Module-level because the TTS queue is a singleton:
 * `chatStore` activates the trace for a voice turn, `tts.ts` reads it. */
let active: VoiceTrace | null = null;

export function setActiveVoiceTrace(trace: VoiceTrace | null): void {
  active = trace;
}

export function getActiveVoiceTrace(): VoiceTrace | null {
  return active;
}

/** Finish and clear the active trace (no-op when there is none). */
export function finishActiveVoiceTrace(outcome: VoiceTraceOutcome): void {
  const trace = active;
  active = null;
  if (!trace) return;
  // A reply that finished without ever producing audio is its own outcome.
  trace.finish(outcome === 'ok' && !trace.has('tts.first_audio') ? 'no_audio' : outcome);
}
