import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import app from '../app';
import { generateToken } from '../utils/jwt';
import { setMetricSink } from '../utils/metricsLog';

const token = generateToken('metrics-route-user');
const turnId = '3f2b8c1e-9a7d-4e55-8b0a-1c2d3e4f5a6b';

const report = {
  turnId,
  path: 'browser',
  outcome: 'ok',
  startedAt: 1_790_000_000_000,
  stages: { 'turn.start': 0, 'mic.request': 5, 'mic.granted': 120, 'stt.transcript': 3400 },
  meta: { brave: false, stt_attempts: 1, ctx_state: 'running' },
  chunks: [{ seq: 1, chars: 42, status: 'ok', engine: 'remote', queued: 3900, fetchStart: 3910 }],
};

describe('POST /api/metrics/voice', () => {
  afterEach(() => setMetricSink(null));

  it('requires an authenticated session', async () => {
    await request(app).post('/api/metrics/voice').send(report).expect(401);
  });

  it('logs the browser timeline as voice.turn.client under the turn id', async () => {
    const lines: string[] = [];
    setMetricSink((l) => lines.push(l));

    await request(app)
      .post('/api/metrics/voice')
      .set('Cookie', `token=${token}`)
      .send(report)
      .expect(204);

    const row = JSON.parse(lines[0]);
    expect(row).toMatchObject({ evt: 'voice.turn.client', turnId, userId: 'metrics-route-user' });
    expect(row.stages['stt.transcript']).toBe(3400);
    expect(row.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/);
  });

  it('rejects free text so transcripts cannot be written into the log', async () => {
    const lines: string[] = [];
    setMetricSink((l) => lines.push(l));
    const post = (body: unknown) =>
      request(app).post('/api/metrics/voice').set('Cookie', `token=${token}`).send(body);

    await post({ ...report, stages: { 'hello i am a transcript': 5 } }).expect(400);
    await post({ ...report, meta: { note: 'what the user said' } }).expect(400);
    await post({ ...report, chunks: [{ seq: 1, chars: 3, status: 'ok', text: 'hi' }].map((c) => ({ ...c, status: 'said hi' })) }).expect(400);
    await post({ ...report, turnId: 'has spaces and <script>' }).expect(400);
    expect(lines).toHaveLength(0);
  });
});
