import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/ttsService', async () => {
  const actual =
    await vi.importActual<typeof import('../services/ttsService')>('../services/ttsService');
  return { ...actual, synthesize: vi.fn() };
});

import app from '../app';
import { synthesize } from '../services/ttsService';
import { TtsBusyError, TtsQueueTimeoutError } from '../services/ttsQueue';
import { FishAudioError } from '../services/fishAudioTts';
import { generateToken } from '../utils/jwt';

const token = generateToken('tts-route-user');
const wav = Buffer.from('RIFF....WAVE');

function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('/api/tts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(synthesize).mockResolvedValue({
      audio: wav,
      contentType: 'audio/wav',
      queueWaitMs: 0,
      inferMs: 300,
    });
  });

  it('requires auth to synthesize', async () => {
    await request(app).post('/api/tts').send({ text: 'Hi.' }).expect(401);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('returns binary WAV (not base64 JSON) with no-store caching', async () => {
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi there.' })
      .expect(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(Buffer.compare(res.body, wav)).toBe(0);
  });

  it('passes numeric correlation ids through and drops anything else', async () => {
    await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .set('X-TTS-Generation', '12')
      .set('X-TTS-Chunk', 'hello; drop table')
      .send({ text: 'Hi.' })
      .expect(200);
    const ctx = vi.mocked(synthesize).mock.calls[0][2]!;
    expect(ctx.generation).toBe('12');
    expect(ctx.chunk).toBeUndefined();
    expect(ctx.reqId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('answers a full queue with 503 + Retry-After so the client can retry once', async () => {
    vi.mocked(synthesize).mockRejectedValue(new TtsBusyError());
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi.' })
      .expect(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('TTS_BUSY');
  });

  it('answers timeouts with 503 and no Retry-After (not worth retrying)', async () => {
    for (const err of [new TtsQueueTimeoutError(), named('TtsTimeoutError')]) {
      vi.mocked(synthesize).mockRejectedValueOnce(err);
      const res = await request(app)
        .post('/api/tts')
        .set('Cookie', `token=${token}`)
        .send({ text: 'Hi.' })
        .expect(503);
      expect(res.headers['retry-after']).toBeUndefined();
      expect(res.body.code).toBe('TTS_TIMEOUT');
    }
  });

  it("serves the provider's own audio format (Fish Audio mp3)", async () => {
    const mp3 = Buffer.from('ID3fake-mp3');
    vi.mocked(synthesize).mockResolvedValue({
      audio: mp3,
      contentType: 'audio/mpeg',
      queueWaitMs: 0,
      inferMs: 400,
    });
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi.' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(Buffer.compare(res.body, mp3)).toBe(0);
  });

  it('treats a hosted-provider rate limit like a full queue (503 + Retry-After)', async () => {
    vi.mocked(synthesize).mockRejectedValue(new FishAudioError(429));
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi.' })
      .expect(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body.code).toBe('TTS_BUSY');
  });

  it('answers a rejected provider key with TTS_UNAVAILABLE and no Retry-After', async () => {
    vi.mocked(synthesize).mockRejectedValue(new FishAudioError(401));
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi.' })
      .expect(503);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.body.code).toBe('TTS_UNAVAILABLE');
  });

  it('turns unexpected failures into a fallback-friendly 503', async () => {
    vi.mocked(synthesize).mockRejectedValue(new Error('boom'));
    const res = await request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .send({ text: 'Hi.' })
      .expect(503);
    expect(res.body.code).toBe('TTS_FAILED');
  });

  it('cancels synthesis when the client disconnects', async () => {
    let seen: AbortSignal | null = null;
    vi.mocked(synthesize).mockImplementation(
      (_text, signal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal.addEventListener('abort', () => reject(named('TtsCancelledError')));
        }),
    );
    const pending = request(app)
      .post('/api/tts')
      .set('Cookie', `token=${token}`)
      .timeout(150)
      .send({ text: 'Hi.' });
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen!.aborted).toBe(true);
  });

  it('exposes a content-free health check without auth', async () => {
    const res = await request(app).get('/api/tts/health');
    expect([200, 503]).toContain(res.status);
    expect(res.body).toHaveProperty('queue');
    expect(res.body).toHaveProperty('counters');
    expect(res.body).not.toHaveProperty('text');
  });
});
