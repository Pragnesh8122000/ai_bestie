import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createVoiceTrace,
  finishActiveVoiceTrace,
  getActiveVoiceTrace,
  setActiveVoiceTrace,
} from './voiceTrace';

describe('voice turn trace', () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true });

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockClear();
  });
  afterEach(() => {
    setActiveVoiceTrace(null);
    vi.unstubAllGlobals();
  });

  const sent = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

  it('records first-write-wins stage offsets and posts once on finish', () => {
    const trace = createVoiceTrace();
    trace.mark('mic.request', performance.now() + 10);
    trace.mark('mic.request', performance.now() + 999); // ignored: first write wins
    trace.count('stt_attempts');
    trace.count('stt_attempts');
    trace.finish('ok');
    trace.finish('error'); // ignored: already finished

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/metrics/voice');
    const body = sent();
    expect(body).toMatchObject({ turnId: trace.id, outcome: 'ok', path: 'browser' });
    expect(body.stages['mic.request']).toBeGreaterThanOrEqual(9);
    expect(body.stages['mic.request']).toBeLessThan(500);
    expect(body.meta.stt_attempts).toBe(2);
    expect(body.stages['turn.end']).toBeGreaterThanOrEqual(0);
  });

  it('records per-chunk stage offsets and ignores marks after the turn ended', () => {
    const trace = createVoiceTrace('server-fallback');
    const chunk = trace.chunk(40, performance.now());
    chunk.mark('fetchStart');
    chunk.set({ status: 'ok', engine: 'remote', bytes: 1234 });
    trace.finish('ok');
    chunk.mark('scheduled'); // too late

    const body = sent();
    expect(body.path).toBe('server-fallback');
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]).toMatchObject({ seq: 1, chars: 40, status: 'ok', bytes: 1234 });
    expect(body.chunks[0].scheduled).toBeUndefined();
  });

  it('never carries text: only the documented numeric/enum fields are reported', () => {
    const trace = createVoiceTrace();
    trace.chunk(12).set({ status: 'ok' });
    trace.finish('ok');
    expect(Object.keys(sent()).sort()).toEqual(
      ['chunks', 'meta', 'outcome', 'path', 'stages', 'startedAt', 'turnId'].sort(),
    );
  });

  it('reports a reply that finished without audio as no_audio, and nothing when idle', () => {
    finishActiveVoiceTrace('ok'); // no active trace: no-op
    expect(fetchMock).not.toHaveBeenCalled();

    setActiveVoiceTrace(createVoiceTrace());
    finishActiveVoiceTrace('ok');
    expect(sent().outcome).toBe('no_audio');
    expect(getActiveVoiceTrace()).toBeNull();
  });

  it('keeps a reply with audio as ok', () => {
    const trace = createVoiceTrace();
    trace.mark('tts.first_audio');
    setActiveVoiceTrace(trace);
    finishActiveVoiceTrace('ok');
    expect(sent().outcome).toBe('ok');
  });

  it('never throws when the report cannot be sent', () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    expect(() => createVoiceTrace().finish('ok')).not.toThrow();
  });
});
