import { describe, expect, it } from 'vitest';
import { formatSummary, formatTurn, joinTurns, parseLines } from './voiceReport';

const id = 'turn-aaaa-1111';
const lines = [
  JSON.stringify({
    ts: 't', evt: 'voice.turn.client', turnId: id, path: 'server-fallback', outcome: 'ok', startedAt: '2026-10-02 10-00-00',
    stages: {
      'turn.start': 0, 'mic.request': 10, 'mic.granted': 150, 'recorder.started': 160,
      'stt.last_result': 3000, 'stt.upload_start': 4400, 'stt.upload_end': 5600, 'stt.transcript': 5600,
      'chat.send': 5610, 'chat.headers': 5700, 'chat.first_token': 6500, 'tts.first_queued': 6900,
      'tts.first_audio': 8000, 'turn.end': 12000,
    },
    meta: { audio_resume_ms: 4, output_latency_ms: 20 },
    chunks: [{ seq: 1, chars: 40, status: 'ok', engine: 'remote', queued: 6900, fetchStart: 6910, headers: 7700, body: 7720, decoded: 7800, scheduled: 8000, audioMs: 2500, gapMs: 0 }],
  }),
  JSON.stringify({ ts: 't', evt: 'stt.transcribe', turnId: id, latencyMs: 900, outcome: 'ok' }),
  JSON.stringify({ ts: 't', evt: 'chat.turn', turnId: id, prepMs: 30, llmConnectMs: 300, llmTtftMs: 400, ttfbMs: 450, streamMs: 2000, provider: 'gemini', model: 'flash', failedAttempts: 0 }),
  JSON.stringify({ ts: 't', evt: 'tts.synth', turnId: id, chunk: '7', outcome: 'ok', queueWaitMs: 10, inferMs: 700 }),
  JSON.stringify({ ts: 't', evt: 'tts.synth', turnId: 'other-turn-0000', chunk: '1', outcome: 'ok' }),
  'not json at all',
  '{"truncated":',
];

describe('voiceReport', () => {
  it('skips non-JSON noise', () => {
    expect(parseLines(lines.join('\n'))).toHaveLength(5);
  });

  it('joins browser and server lines by turnId and derives each step', () => {
    const turn = joinTurns(parseLines(lines.join('\n'))).find((t) => t.turnId === id)!;
    expect(turn.path).toBe('server-fallback');
    expect(turn.startedAt).toBe('2026-10-02 10-00-00');
    expect(turn.steps).toMatchObject({
      mic_open: 140,
      endpointing: 2600,
      stt_upload_total: 1200,
      stt_server: 900,
      stt_network: 300, // client upload time minus the server's transcribe time
      send_to_first_token: 890,
      llm_server_ttfb: 450,
      llm_network: 440,
      token_to_first_chunk: 400,
      tts_request: 790,
      tts_server_infer: 700,
      tts_network: 80,
      tts_decode: 80,
      speech_end_to_first_audio: 5000,
      transcript_to_first_audio: 2400,
      reaction: 5020, // + 20ms device output latency
      turn_total: 12000,
    });
  });

  it('shows legacy UTC ISO stamps from older logs in IST', () => {
    const old = JSON.stringify({ evt: 'chat.turn', turnId: 'legacy-turn-0001', startedAt: '2026-10-01T18:30:00.000Z' });
    expect(joinTurns(parseLines(old))[0].startedAt).toBe('2026-10-02 00-00-00');
  });

  it('formats a turn and a summary without throwing on partial data', () => {
    const turns = joinTurns(parseLines(lines.join('\n')));
    expect(formatTurn(turns[0])).toContain('turn ');
    expect(formatSummary(turns)).toContain('p50');
    // A turn with only a server line still renders (no browser report).
    const serverOnly = joinTurns(parseLines(lines[4]));
    expect(formatTurn(serverOnly[0])).toContain('no browser report');
  });
});
