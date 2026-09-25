import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

vi.mock('../services/transcriptionService', async () => {
  const actual = await vi.importActual<typeof import('../services/transcriptionService')>(
    '../services/transcriptionService',
  );
  return { ...actual, transcribeAudio: vi.fn() };
});

import app from '../app';
import { config } from '../config';
import { transcribeAudio } from '../services/transcriptionService';
import { generateToken } from '../utils/jwt';

const token = generateToken('voice-route-user');

describe('POST /api/transcriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transcribeAudio).mockResolvedValue('hello bestie');
  });

  it('requires an authenticated session before accepting audio', async () => {
    await request(app)
      .post('/api/transcriptions')
      .set('Content-Type', 'audio/webm')
      .set('X-Audio-Duration-Ms', '1000')
      .send(Buffer.from('voice'))
      .expect(401);

    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('accepts a supported bounded clip without logging or returning audio', async () => {
    const response = await request(app)
      .post('/api/transcriptions')
      .set('Cookie', `token=${token}`)
      .set('Content-Type', 'audio/webm;codecs=opus')
      .set('X-Audio-Duration-Ms', '8000')
      .send(Buffer.from('voice'))
      .expect(200);

    expect(response.body).toEqual({ success: true, data: { text: 'hello bestie' } });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transcribeAudio).mock.calls[0][1]).toBe('audio/webm');
  });

  it('rejects clips whose declared duration exceeds the server limit', async () => {
    const response = await request(app)
      .post('/api/transcriptions')
      .set('Cookie', `token=${token}`)
      .set('Content-Type', 'audio/webm')
      .set('X-Audio-Duration-Ms', String(config.transcription.maxDurationMs + 1))
      .send(Buffer.from('voice'))
      .expect(413);

    expect(response.body.code).toBe('AUDIO_TOO_LONG');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('rejects oversized audio before external processing', async () => {
    const response = await request(app)
      .post('/api/transcriptions')
      .set('Cookie', `token=${token}`)
      .set('Content-Type', 'audio/webm')
      .set('X-Audio-Duration-Ms', '8000')
      .send(Buffer.alloc(config.transcription.maxBytes + 1, 1))
      .expect(413);

    expect(response.body.code).toBe('UPLOAD_TOO_LARGE');
    expect(transcribeAudio).not.toHaveBeenCalled();
  });
});
