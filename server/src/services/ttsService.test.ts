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

async function resolveWith(
  sid: string | undefined,
  version?: string,
): Promise<number> {
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
