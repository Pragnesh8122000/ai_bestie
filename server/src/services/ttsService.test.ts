import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Voice replies come from Fish Audio. These tests pin the request we send,
 * the configuration contract, and that failures are reported instead of
 * silently falling back to the browser voice.
 *
 * Every relevant env var is set explicitly (blank rather than unset):
 * config's dotenv refills unset keys from a developer's real .env on each
 * module reload.
 */
const FISH_ENV = [
  'TTS_ENABLED',
  'FISH_API_KEY',
  'FISH_TTS_MODEL',
  'FISH_VOICE_ID',
  'FISH_REFERENCE_ID',
  'FISH_TTS_FORMAT',
  'FISH_TTS_SPEED',
  'FISH_TTS_LATENCY',
  'TTS_INFERENCE_TIMEOUT_MS',
];
const saved = Object.fromEntries(FISH_ENV.map((k) => [k, process.env[k]]));

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const k of FISH_ENV) process.env[k] = '';
  process.env.TTS_ENABLED = 'true';
  Object.assign(process.env, env);
  return import('./ttsService');
}

const ok = (bytes: number[]) => vi.fn(async () => new Response(new Uint8Array(bytes)));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of FISH_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('ttsStatus', () => {
  it('is unavailable without FISH_API_KEY', async () => {
    const mod = await load({});
    await mod.initTts();
    const s = mod.ttsStatus();
    expect(s).toMatchObject({ provider: 'fishaudio', available: false, model: 's2.1-pro-free' });
    expect(s.error).toMatch(/FISH_API_KEY/);
  });

  it('is unavailable when TTS is disabled, even with a key', async () => {
    const mod = await load({ TTS_ENABLED: 'false', FISH_API_KEY: 'k' });
    await mod.initTts();
    expect(mod.ttsStatus()).toMatchObject({
      available: false,
      error: expect.stringMatching(/disabled/),
    });
    await expect(mod.synthesize('Hi.', new AbortController().signal)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('reports queue and counters for the health endpoint without any text', async () => {
    const mod = await load({ FISH_API_KEY: 'k' });
    await mod.initTts();
    const s = mod.ttsStatus();
    expect(s.available).toBe(true);
    expect(s.queue).toMatchObject({ active: 0, queued: 0, concurrency: 4 });
    expect(s.counters).toEqual({ ok: 0, cancelled: 0, busy: 0, timeouts: 0, failures: 0 });
    expect(JSON.stringify(s)).not.toMatch(/text"/);
  });
});

describe('synthesize', () => {
  it('posts the chunk to Fish Audio and returns its mp3 untouched', async () => {
    const mp3 = [0x49, 0x44, 0x33, 1, 2, 3];
    const fetchMock = ok(mp3);
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load({ FISH_API_KEY: 'test-key', FISH_REFERENCE_ID: 'voice-123' });

    const out = await mod.synthesize('Hello there 😊', new AbortController().signal);

    expect(out.contentType).toBe('audio/mpeg');
    expect([...out.audio]).toEqual(mp3);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    });
    // Last-line normalization: emoji are stripped, never read out.
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Hello there',
      reference_id: 'voice-123',
      format: 'mp3',
    });
    expect(mod.ttsStatus().counters.ok).toBe(1);
  });

  it('picks the voice from FISH_VOICE_ID and sends optional speed/latency', async () => {
    const fetchMock = ok([1]);
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load({
      FISH_API_KEY: 'Bearer test-key',
      FISH_VOICE_ID: 'new-voice',
      FISH_REFERENCE_ID: 'old-voice',
      FISH_TTS_SPEED: '5',
      FISH_TTS_LATENCY: 'Balanced',
      FISH_TTS_FORMAT: 'opus',
    });
    const out = await mod.synthesize('Hi.', new AbortController().signal);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      reference_id: 'new-voice',
      prosody: { speed: 2 },
      latency: 'balanced',
      format: 'opus',
    });
    expect(out.contentType).toBe('audio/ogg');
  });

  it('answers emoji-only text with a moment of silence, without calling Fish Audio', async () => {
    const fetchMock = ok([1]);
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load({ FISH_API_KEY: 'k' });
    const out = await mod.synthesize('😊🎉', new AbortController().signal);
    expect(out.contentType).toBe('audio/wav');
    expect(out.audio.subarray(0, 4).toString()).toBe('RIFF');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rejected key on the health status instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    const mod = await load({ FISH_API_KEY: 'bad' });
    await expect(mod.synthesize('Hi.', new AbortController().signal)).rejects.toMatchObject({
      name: 'FishAudioError',
      status: 401,
    });
    expect(mod.ttsStatus().upstreamError).toMatch(/401.*FISH_API_KEY/);
    expect(mod.ttsStatus().counters.failures).toBe(1);
  });

  it('times out a stuck upstream call and aborts it', async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init.signal!;
            init.signal!.addEventListener('abort', () =>
              reject(new DOMException('', 'AbortError')),
            );
          }),
      ),
    );
    const mod = await load({ FISH_API_KEY: 'k', TTS_INFERENCE_TIMEOUT_MS: '1000' });
    await expect(mod.synthesize('Hi.', new AbortController().signal)).rejects.toMatchObject({
      name: 'TtsTimeoutError',
    });
    expect(upstreamSignal?.aborted).toBe(true);
    expect(mod.ttsStatus().counters.timeouts).toBe(1);
  });

  it('cancels the upstream call when the client goes away', async () => {
    let upstreamSignal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            upstreamSignal = init.signal!;
            init.signal!.addEventListener('abort', () =>
              reject(new DOMException('', 'AbortError')),
            );
          }),
      ),
    );
    const mod = await load({ FISH_API_KEY: 'k' });
    const client = new AbortController();
    const pending = mod.synthesize('Hi.', client.signal);
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    client.abort();
    await expect(pending).rejects.toBeTruthy();
    expect(upstreamSignal!.aborted).toBe(true);
    expect(mod.ttsStatus().counters.cancelled).toBe(1);
  });
});
