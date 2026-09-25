import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { transcribeAudio } from './transcriptionService';

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sends bounded audio to the configured transcription model', async () => {
    const originalKey = config.llm.openaiApiKey;
    Object.defineProperty(config.llm, 'openaiApiKey', { value: 'test-key', configurable: true });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: '  hello bestie  ' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(transcribeAudio(Buffer.from('audio'), 'audio/webm')).resolves.toBe(
        'hello bestie',
      );
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers).toEqual({ Authorization: 'Bearer test-key' });
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('model')).toBe(config.transcription.model);
    } finally {
      Object.defineProperty(config.llm, 'openaiApiKey', {
        value: originalKey,
        configurable: true,
      });
    }
  });

  it('fails actionably without inventing a credential or making a request', async () => {
    const originalKey = config.llm.openaiApiKey;
    Object.defineProperty(config.llm, 'openaiApiKey', { value: '', configurable: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(transcribeAudio(Buffer.from('audio'), 'audio/webm')).rejects.toMatchObject({
        statusCode: 503,
        code: 'TRANSCRIPTION_NOT_CONFIGURED',
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(config.llm, 'openaiApiKey', {
        value: originalKey,
        configurable: true,
      });
    }
  });

  it('summarizes upstream errors without forwarding opaque provider bodies', async () => {
    const originalKey = config.llm.openaiApiKey;
    Object.defineProperty(config.llm, 'openaiApiKey', { value: 'test-key', configurable: true });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(`secret provider details ${'x'.repeat(5000)}`, { status: 503 }),
        ),
    );

    try {
      await expect(transcribeAudio(Buffer.from('audio'), 'audio/ogg')).rejects.toMatchObject({
        statusCode: 502,
        code: 'TRANSCRIPTION_UNAVAILABLE',
        message: 'Transcription service is temporarily unavailable. Please try again.',
      });
    } finally {
      Object.defineProperty(config.llm, 'openaiApiKey', {
        value: originalKey,
        configurable: true,
      });
    }
  });
});
