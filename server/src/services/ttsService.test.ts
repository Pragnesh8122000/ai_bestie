import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The companion has one voice. These tests pin the speaker-id contract so a
 * stray TTS_SID can never silently change it (or its gender), which is one of
 * the two ways replies ended up sounding like several different people.
 */

const FEMALE_SIDS = [0, 1, 2, 3, 4, 7, 8];
const MALE_SIDS = [5, 6, 9, 10];
const DEFAULT_SID = 2;

async function resolveWith(sid: string | undefined): Promise<number> {
  vi.resetModules();
  if (sid === undefined) delete process.env.TTS_SID;
  else process.env.TTS_SID = sid;
  const mod = await import('./ttsService');
  return mod.resolveSid();
}

const original = process.env.TTS_SID;

beforeEach(() => {
  // The model itself is never loaded here — resolveSid() is pure config.
  process.env.TTS_ENABLED = 'false';
});

afterEach(() => {
  if (original === undefined) delete process.env.TTS_SID;
  else process.env.TTS_SID = original;
});

describe('resolveSid', () => {
  it('honours every female speaker id', async () => {
    for (const sid of FEMALE_SIDS) {
      expect(await resolveWith(String(sid))).toBe(sid);
    }
  });

  it('rejects male speaker ids and uses the default female voice', async () => {
    for (const sid of MALE_SIDS) {
      expect(await resolveWith(String(sid))).toBe(DEFAULT_SID);
    }
  });

  it('rejects out-of-range, fractional, and non-numeric ids', async () => {
    for (const bad of ['99', '-1', '2.5', 'abc', 'NaN']) {
      expect(await resolveWith(bad)).toBe(DEFAULT_SID);
    }
  });

  it('treats blank/whitespace/unset as the default female voice', async () => {
    // `Number('')` is 0, which is a *different* voice — the blank case must not
    // silently drift away from the configured default.
    expect(await resolveWith('')).toBe(DEFAULT_SID);
    expect(await resolveWith('   ')).toBe(DEFAULT_SID);
    expect(await resolveWith(undefined)).toBe(DEFAULT_SID);
  });

  it('is stable across calls (one voice for the whole process)', async () => {
    vi.resetModules();
    process.env.TTS_SID = '7';
    const mod = await import('./ttsService');
    expect(mod.resolveSid()).toBe(7);
    expect(mod.resolveSid()).toBe(7);
    expect(mod.ttsStatus().sid).toBe(7);
  });
});
