import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The companion has one voice. These tests pin the speaker-id contract so a
 * stray TTS_SID can never silently change it (or its gender), which is one of
 * the two ways replies ended up sounding like several different people.
 *
 * The id space depends on the Kokoro release in use, so the contract is
 * checked for both: v1_0 (default, 53 speakers) and v0_19 (legacy, 11).
 */

// v1.0: English female ids. 11-19/24-27 are male, 28+ are other languages.
const V1_FEMALE_SIDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 21, 22, 23];
const V1_REJECTED_SIDS = [11, 16, 19, 24, 27, 28, 37, 45, 52];
const V1_DEFAULT_SID = 3; // af_heart

// v0_19: legacy English-only model.
const V0_FEMALE_SIDS = [0, 1, 2, 3, 4, 7, 8];
const V0_MALE_SIDS = [5, 6, 9, 10];
const V0_DEFAULT_SID = 2; // af_nicole

async function load(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('./ttsService');
}

async function resolveWith(sid: string | undefined, version?: string): Promise<number> {
  const mod = await load({ TTS_SID: sid, TTS_MODEL_VERSION: version });
  return mod.resolveSid();
}

const originalSid = process.env.TTS_SID;
const originalVersion = process.env.TTS_MODEL_VERSION;
const originalSpeed = process.env.TTS_SPEED;

beforeEach(() => {
  // The model itself is never loaded here — resolveSid() is pure config.
  process.env.TTS_ENABLED = 'false';
});

afterEach(() => {
  for (const [k, v] of [
    ['TTS_SID', originalSid],
    ['TTS_MODEL_VERSION', originalVersion],
    ['TTS_SPEED', originalSpeed],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('resolveSid (Kokoro v1.0, the default model)', () => {
  it('honours every English female speaker id', async () => {
    for (const sid of V1_FEMALE_SIDS) {
      expect(await resolveWith(String(sid))).toBe(sid);
    }
  });

  it('rejects male and non-English ids and uses the default female voice', async () => {
    // A non-English id would change the character's language mid-app, which is
    // just as wrong as changing her gender.
    for (const sid of V1_REJECTED_SIDS) {
      expect(await resolveWith(String(sid))).toBe(V1_DEFAULT_SID);
    }
  });

  it('rejects out-of-range, fractional, and non-numeric ids', async () => {
    for (const bad of ['99', '-1', '2.5', 'abc', 'NaN']) {
      expect(await resolveWith(bad)).toBe(V1_DEFAULT_SID);
    }
  });

  it('treats blank/whitespace/unset as the default female voice', async () => {
    // `Number('')` is 0, which is a *different* voice — the blank case must not
    // silently drift away from the configured default.
    expect(await resolveWith('')).toBe(V1_DEFAULT_SID);
    expect(await resolveWith('   ')).toBe(V1_DEFAULT_SID);
    expect(await resolveWith(undefined)).toBe(V1_DEFAULT_SID);
  });

  it('is stable across calls (one voice for the whole process)', async () => {
    const mod = await load({ TTS_SID: '7', TTS_MODEL_VERSION: undefined });
    expect(mod.resolveSid()).toBe(7);
    expect(mod.resolveSid()).toBe(7);
    expect(mod.ttsStatus().sid).toBe(7);
  });
});

describe('resolveSid (Kokoro v0_19, the legacy model)', () => {
  it('honours every female speaker id', async () => {
    for (const sid of V0_FEMALE_SIDS) {
      expect(await resolveWith(String(sid), 'v0_19')).toBe(sid);
    }
  });

  it('rejects male speaker ids and uses the legacy default female voice', async () => {
    for (const sid of V0_MALE_SIDS) {
      expect(await resolveWith(String(sid), 'v0_19')).toBe(V0_DEFAULT_SID);
    }
  });

  it('rejects ids that only exist in v1.0', async () => {
    // 21 is bf_emma in v1.0 but out of range in v0_19 — the id space must not
    // leak across versions.
    expect(await resolveWith('21', 'v0_19')).toBe(V0_DEFAULT_SID);
  });

  it('defaults to af_nicole when unset', async () => {
    expect(await resolveWith(undefined, 'v0_19')).toBe(V0_DEFAULT_SID);
  });
});

describe('resolveSpeed', () => {
  it('defaults to a slightly relaxed conversational rate', async () => {
    const mod = await load({ TTS_SPEED: undefined });
    expect(mod.resolveSpeed()).toBe(0.95);
  });

  it('honours a sane override', async () => {
    const mod = await load({ TTS_SPEED: '1.05' });
    expect(mod.resolveSpeed()).toBeCloseTo(1.05);
  });

  it('clamps extreme values so the companion stays intelligible', async () => {
    expect((await load({ TTS_SPEED: '5' })).resolveSpeed()).toBe(1.3);
    expect((await load({ TTS_SPEED: '0.05' })).resolveSpeed()).toBe(0.7);
  });

  it('falls back to the default for non-numeric input', async () => {
    expect((await load({ TTS_SPEED: 'fast' })).resolveSpeed()).toBe(0.95);
  });
});

describe('resolveNumThreads', () => {
  it('honours an explicit positive integer, capped at 8', async () => {
    const mod = await load({});
    expect(mod.resolveNumThreads('1')).toBe(1);
    expect(mod.resolveNumThreads('3')).toBe(3);
    expect(mod.resolveNumThreads('64')).toBe(8);
  });

  it("sizes 'auto' (and junk) from the CPU grant, between 1 and 2 threads", async () => {
    const mod = await load({});
    for (const raw of ['auto', '0', '-2', '1.5', 'lots']) {
      const n = mod.resolveNumThreads(raw);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(2);
      expect(n).toBe(Math.max(1, Math.min(2, Math.floor(mod.availableCpus()))));
    }
  });
});

describe('ttsStatus', () => {
  it('reports queue and counters for the health endpoint without any text', async () => {
    const mod = await load({});
    const s = mod.ttsStatus();
    expect(s.available).toBe(false);
    expect(s.queue).toMatchObject({ active: 0, queued: 0 });
    expect(s.counters).toEqual({ ok: 0, cancelled: 0, busy: 0, timeouts: 0, failures: 0 });
    expect(JSON.stringify(s)).not.toMatch(/text"/);
  });
});

describe('TTS_PROVIDER=fishaudio', () => {
  const fishEnv = [
    'TTS_PROVIDER',
    'FISH_API_KEY',
    'FISH_VOICE_ID',
    'FISH_REFERENCE_ID',
    'FISH_TTS_FORMAT',
    'FISH_TTS_SPEED',
    'FISH_TTS_LATENCY',
  ];
  const saved = Object.fromEntries(fishEnv.map((k) => [k, process.env[k]]));

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of fishEnv) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('is unavailable without FISH_API_KEY and never loads Kokoro', async () => {
    const mod = await load({ TTS_ENABLED: 'true', TTS_PROVIDER: 'fishaudio', FISH_API_KEY: '' });
    await mod.initTts();
    const s = mod.ttsStatus();
    expect(s.provider).toBe('fishaudio');
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/FISH_API_KEY/);
    expect(s.sampleRate).toBeNull();
  });

  it('posts the chunk to Fish Audio and returns its mp3 untouched', async () => {
    const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
    const fetchMock = vi.fn(async () => new Response(mp3, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load({
      TTS_ENABLED: 'true',
      TTS_PROVIDER: 'fishaudio',
      FISH_API_KEY: 'test-key',
      // Blank, not unset: config's dotenv would refill unset keys from a
      // developer's real .env on every module reload.
      FISH_VOICE_ID: '',
      FISH_REFERENCE_ID: 'voice-123',
      FISH_TTS_FORMAT: '',
      FISH_TTS_SPEED: '',
      FISH_TTS_LATENCY: '',
    });

    const out = await mod.synthesize('Hello there 😊', new AbortController().signal);

    expect(out.contentType).toBe('audio/mpeg');
    expect(out.audioMs).toBeNull();
    expect([...out.audio]).toEqual([...mp3]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.fish.audio/v1/tts');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
      model: 's2.1-pro-free',
    });
    // Same last-line normalization as Kokoro (emoji stripped).
    expect(JSON.parse(String(init.body))).toEqual({
      text: 'Hello there',
      reference_id: 'voice-123',
      format: 'mp3',
    });
    expect(mod.ttsStatus().counters.ok).toBe(1);
  });

  it('picks the voice from FISH_VOICE_ID and sends optional speed/latency', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const mod = await load({
      TTS_ENABLED: 'true',
      TTS_PROVIDER: 'fishaudio',
      FISH_API_KEY: 'Bearer test-key',
      FISH_VOICE_ID: 'new-voice',
      FISH_REFERENCE_ID: 'old-voice',
      FISH_TTS_SPEED: '5',
      FISH_TTS_LATENCY: 'Balanced',
    });
    await mod.synthesize('Hi.', new AbortController().signal);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      reference_id: 'new-voice',
      prosody: { speed: 2 },
      latency: 'balanced',
    });
  });

  it('reports a rejected key on the health status instead of failing silently', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('no', { status: 401 })),
    );
    const mod = await load({ TTS_ENABLED: 'true', TTS_PROVIDER: 'fishaudio', FISH_API_KEY: 'bad' });
    await expect(mod.synthesize('Hi.', new AbortController().signal)).rejects.toMatchObject({
      status: 401,
    });
    expect(mod.ttsStatus().upstreamError).toMatch(/401.*FISH_API_KEY/);
  });

  it('surfaces upstream errors with their HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('slow down', { status: 429 })),
    );
    const mod = await load({ TTS_ENABLED: 'true', TTS_PROVIDER: 'fishaudio', FISH_API_KEY: 'k' });
    await expect(mod.synthesize('Hi.', new AbortController().signal)).rejects.toMatchObject({
      name: 'FishAudioError',
      status: 429,
    });
    expect(mod.ttsStatus().counters.failures).toBe(1);
  });
});
