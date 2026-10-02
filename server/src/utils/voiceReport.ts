/**
 * Joins the voice-metrics JSONL (see metricsLog.ts) into one timeline per voice
 * turn. The browser reports `voice.turn.client` (stage offsets, TTS chunk
 * timings); the server logs `stt.transcribe`, `chat.turn` and `tts.synth`.
 * All of them carry the same `turnId`.
 *
 * Browser offsets are on the browser clock and server durations on the server
 * clock, so the two are only ever compared as *durations* — never as absolute
 * timestamps. "Network/overhead" below is `client-measured − server-measured`
 * for the same step.
 */

import { formatIst, parseIst } from './time';

type Row = Record<string, unknown>;

export interface ClientChunk {
  seq: number;
  chars: number;
  status: string;
  engine?: string;
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

export interface TurnReport {
  turnId: string;
  startedAt: string | null;
  path: string;
  outcome: string;
  client: { stages: Record<string, number>; meta: Record<string, unknown>; chunks: ClientChunk[] } | null;
  stt: Row | null;
  chat: Row | null;
  tts: Row[];
  /** Named step durations in ms; absent when an input mark is missing. */
  steps: Record<string, number>;
}

export function parseLines(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const row = JSON.parse(trimmed) as Row;
      if (typeof row.evt === 'string') rows.push(row);
    } catch {
      // A truncated last line or interleaved stdout: skip it.
    }
  }
  return rows;
}

/** Older logs used UTC ISO stamps; show every turn in the same IST format. */
function normalizeStamp(value: string): string {
  if (!Number.isNaN(parseIst(value))) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatIst(ms);
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

function diff(stages: Record<string, number>, from: string, to: string): number | undefined {
  const a = stages[from];
  const b = stages[to];
  return a === undefined || b === undefined ? undefined : Math.max(0, b - a);
}

function set(steps: Record<string, number>, name: string, value: number | undefined): void {
  if (value !== undefined) steps[name] = Math.round(value);
}

/** Per-step durations for one joined turn. */
export function computeSteps(turn: Omit<TurnReport, 'steps'>): Record<string, number> {
  const steps: Record<string, number> = {};
  const s = turn.client?.stages ?? {};
  const meta = turn.client?.meta ?? {};
  const first = turn.client?.chunks.find((c) => c.fetchStart !== undefined);

  // 1. Register / open the microphone.
  set(steps, 'mic_open', diff(s, 'mic.request', 'mic.granted'));
  set(steps, 'recorder_start', diff(s, 'mic.granted', 'recorder.started'));

  // 2. STT. `listen_to_first_result` includes the user's own reaction time.
  set(steps, 'stt_engine_ready', diff(s, 'stt.start', 'stt.audio_start'));
  set(steps, 'listen_to_first_result', diff(s, s['stt.audio_start'] === undefined ? 'stt.start' : 'stt.audio_start', 'stt.first_result'));
  set(steps, 'speaking', diff(s, 'stt.first_result', 'stt.last_result'));
  set(steps, 'endpointing', diff(s, 'stt.last_result', 'stt.transcript'));
  if (turn.path === 'server-fallback') {
    const upload = diff(s, 'stt.upload_start', 'stt.upload_end');
    set(steps, 'stt_upload_total', upload);
    set(steps, 'stt_server', num(turn.stt?.latencyMs));
    if (upload !== undefined && num(turn.stt?.latencyMs) !== undefined) {
      set(steps, 'stt_network', upload - (turn.stt!.latencyMs as number));
    }
  }

  // 3. LLM. Server steps are from `chat.turn`; the client figure includes the network.
  set(steps, 'send_to_headers', diff(s, 'chat.send', 'chat.headers'));
  set(steps, 'send_to_first_token', diff(s, 'chat.send', 'chat.first_token'));
  set(steps, 'llm_server_prep', num(turn.chat?.prepMs));
  set(steps, 'llm_server_connect', num(turn.chat?.llmConnectMs));
  set(steps, 'llm_server_ttft', num(turn.chat?.llmTtftMs));
  set(steps, 'llm_server_ttfb', num(turn.chat?.ttfbMs));
  const sendToToken = steps.send_to_first_token;
  const ttfb = num(turn.chat?.ttfbMs);
  if (sendToToken !== undefined && ttfb !== undefined) {
    set(steps, 'llm_network', sendToToken - ttfb);
  }
  set(steps, 'llm_stream', num(turn.chat?.streamMs));

  // 4. TTS: waiting for the chunker, then the first chunk's trip to audio.
  set(steps, 'token_to_first_chunk', diff(s, 'chat.first_token', 'tts.first_queued'));
  if (first) {
    const f = first;
    const d = (a?: number, b?: number) => (a === undefined || b === undefined ? undefined : b - a);
    set(steps, 'tts_queue_wait', d(f.queued, f.fetchStart));
    set(steps, 'tts_request', d(f.fetchStart, f.headers));
    set(steps, 'tts_download', d(f.headers, f.body));
    set(steps, 'tts_decode', d(f.body, f.decoded));
    set(steps, 'tts_to_schedule', d(f.decoded, f.scheduled));
    const sv = turn.tts[0];
    set(steps, 'tts_server_queue', num(sv?.queueWaitMs));
    set(steps, 'tts_server_infer', num(sv?.inferMs));
    const request = steps.tts_request;
    if (request !== undefined && sv) {
      set(steps, 'tts_network', request - (num(sv.queueWaitMs) ?? 0) - (num(sv.inferMs) ?? 0));
    }
  }

  // 5. Audio output.
  set(steps, 'audio_resume', num(meta.audio_resume_ms));
  set(steps, 'output_latency', num(meta.output_latency_ms));

  // Headlines. `reaction` is what the user feels after finishing a sentence.
  set(steps, 'speech_end_to_first_audio', diff(s, 'stt.last_result', 'tts.first_audio'));
  set(steps, 'transcript_to_first_audio', diff(s, 'stt.transcript', 'tts.first_audio'));
  const reaction = steps.speech_end_to_first_audio;
  if (reaction !== undefined) set(steps, 'reaction', reaction + (steps.output_latency ?? 0));
  set(steps, 'turn_total', s['turn.end']);
  return steps;
}

export function joinTurns(rows: Row[]): TurnReport[] {
  const byTurn = new Map<string, Omit<TurnReport, 'steps'>>();
  const get = (id: string) => {
    let t = byTurn.get(id);
    if (!t) {
      t = { turnId: id, startedAt: null, path: 'unknown', outcome: 'unknown', client: null, stt: null, chat: null, tts: [] };
      byTurn.set(id, t);
    }
    return t;
  };

  for (const row of rows) {
    const id = typeof row.turnId === 'string' ? row.turnId : null;
    if (!id) continue;
    const turn = get(id);
    switch (row.evt) {
      case 'voice.turn.client':
        turn.client = {
          stages: (row.stages as Record<string, number>) ?? {},
          meta: (row.meta as Record<string, unknown>) ?? {},
          chunks: (row.chunks as ClientChunk[]) ?? [],
        };
        turn.path = String(row.path ?? turn.path);
        turn.outcome = String(row.outcome ?? turn.outcome);
        if (typeof row.startedAt === 'string') turn.startedAt = normalizeStamp(row.startedAt);
        break;
      case 'stt.transcribe':
        turn.stt = row;
        break;
      case 'chat.turn':
        turn.chat = row;
        break;
      case 'tts.synth':
        turn.tts.push(row);
        break;
    }
  }

  return [...byTurn.values()]
    .map((turn) => {
      // `chunk` is a page-wide counter; ordering it lines the server lines up
      // with the client's per-reply chunks. A retried chunk keeps its last line.
      const latest = new Map<string, Row>();
      for (const row of turn.tts) latest.set(String(row.chunk ?? row.reqId), row);
      turn.tts = [...latest.values()].sort((a, b) => Number(a.chunk ?? 0) - Number(b.chunk ?? 0));
      const chatStart = turn.chat?.startedAt;
      turn.startedAt ??= typeof chatStart === 'string' ? normalizeStamp(chatStart) : null;
      return { ...turn, steps: computeSteps(turn) };
    })
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/* ------------------------------ formatting ------------------------------ */

const STEP_ORDER: Array<[string, string]> = [
  ['mic_open', '1 mic: getUserMedia (permission + device)'],
  ['recorder_start', '1 mic: recorder start'],
  ['stt_engine_ready', '2 stt: recognizer mic live'],
  ['listen_to_first_result', '2 stt: wait for first words (incl. user)'],
  ['speaking', '2 stt: user speaking'],
  ['endpointing', '2 stt: silence wait before commit'],
  ['stt_upload_total', '2 stt: upload + server transcribe'],
  ['stt_server', '2 stt:   server (openai)'],
  ['stt_network', '2 stt:   network/overhead'],
  ['send_to_headers', '3 llm: request -> response headers'],
  ['llm_server_prep', '3 llm:   server prep (db, prompt)'],
  ['llm_server_connect', '3 llm:   provider connect/failover'],
  ['llm_server_ttft', '3 llm:   provider first token'],
  ['llm_server_ttfb', '3 llm:   server request -> first token'],
  ['llm_network', '3 llm:   network/overhead'],
  ['send_to_first_token', '3 llm: request -> first token (client)'],
  ['llm_stream', '3 llm: first token -> stream end'],
  ['token_to_first_chunk', '4 tts: first token -> first chunk ready'],
  ['tts_queue_wait', '4 tts: chunk waits for a slot'],
  ['tts_request', '4 tts: /api/tts request -> headers'],
  ['tts_server_queue', '4 tts:   server queue wait'],
  ['tts_server_infer', '4 tts:   server inference'],
  ['tts_network', '4 tts:   network/overhead'],
  ['tts_download', '4 tts: audio download'],
  ['tts_decode', '4 tts: decode'],
  ['tts_to_schedule', '4 tts: decoded -> scheduled'],
  ['audio_resume', '5 out: audio context resume'],
  ['output_latency', '5 out: device output latency'],
  ['transcript_to_first_audio', '= transcript -> first audio'],
  ['speech_end_to_first_audio', '= speech end -> first audio'],
  ['reaction', '= reaction (incl. output latency)'],
  ['turn_total', '= whole turn (to playback end)'],
];

const fmt = (v: number | undefined) => (v === undefined ? '-' : `${v}`);

export function formatTurn(turn: TurnReport): string {
  const out: string[] = [];
  const c = turn.chat;
  out.push(
    `turn ${turn.turnId}  ${turn.startedAt ?? '?'}  path=${turn.path}  outcome=${turn.outcome}` +
      (c ? `  llm=${String(c.provider)}/${String(c.model)} failovers=${fmt(num(c.failedAttempts))}` : ''),
  );
  if (!turn.client) out.push('  (no browser report: mic/STT/audio-output stages unavailable)');
  for (const [key, label] of STEP_ORDER) {
    if (turn.steps[key] !== undefined) out.push(`  ${label.padEnd(44)} ${String(turn.steps[key]).padStart(7)} ms`);
  }
  const chunks = turn.client?.chunks ?? [];
  if (chunks.length) {
    out.push('  tts chunks (ms offsets from turn start):');
    out.push('    #  chars  status   queued  fetch  headers  body  decoded  sched  audioMs  gap  srvQueue  srvInfer');
    // Server lines pair with the chunks that actually went to /api/tts, in order.
    let svIdx = 0;
    chunks.forEach((ch) => {
      const sv = ch.fetchStart !== undefined && ch.engine !== 'local' ? turn.tts[svIdx++] : undefined;
      const cells = [ch.seq, ch.chars, ch.status, ch.queued, ch.fetchStart, ch.headers, ch.body, ch.decoded, ch.scheduled, ch.audioMs, ch.gapMs, num(sv?.queueWaitMs), num(sv?.inferMs)];
      const w = [3, 6, 8, 7, 6, 8, 5, 8, 6, 8, 4, 9, 9];
      out.push('  ' + cells.map((v, k) => String(v ?? '-').padStart(w[k])).join(' '));
    });
  }
  return out.join('\n');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function formatSummary(turns: TurnReport[]): string {
  const complete = turns.filter((t) => t.steps.reaction !== undefined || t.steps.speech_end_to_first_audio !== undefined);
  const lines = [`${turns.length} turns (${complete.length} with a measured speech-end -> first-audio)`];
  lines.push(`  ${'step'.padEnd(44)} ${'n'.padStart(3)} ${'p50'.padStart(7)} ${'p90'.padStart(7)} ${'max'.padStart(7)}`);
  for (const [key, label] of STEP_ORDER) {
    const values = turns.map((t) => t.steps[key]).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    if (values.length === 0) continue;
    lines.push(
      `  ${label.padEnd(44)} ${String(values.length).padStart(3)} ${String(percentile(values, 50)).padStart(7)} ${String(percentile(values, 90)).padStart(7)} ${String(values[values.length - 1]).padStart(7)}`,
    );
  }
  // Which step dominates? Largest median among the controllable, non-user steps.
  const candidates = ['endpointing', 'stt_upload_total', 'send_to_first_token', 'token_to_first_chunk', 'tts_request', 'tts_decode', 'audio_resume', 'output_latency', 'tts_queue_wait'];
  const medians = candidates
    .map((k) => {
      const v = turns.map((t) => t.steps[k]).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      return [k, v.length ? percentile(v, 50) : -1] as const;
    })
    .filter(([, m]) => m >= 0)
    .sort((a, b) => b[1] - a[1]);
  if (medians.length) lines.push(`  biggest median contributors: ${medians.slice(0, 3).map(([k, m]) => `${k} ${m}ms`).join(', ')}`);
  return lines.join('\n');
}
