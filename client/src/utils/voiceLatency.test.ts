// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createVoiceTurnLatencyTrace } from './voiceLatency';

describe('voice turn latency trace', () => {
  it('reports every user-visible stage without including spoken text', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const events: unknown[] = [];
    window.addEventListener(
      'voice-turn-latency',
      (event) => {
        events.push((event as CustomEvent).detail);
      },
      { once: true },
    );

    const trace = createVoiceTurnLatencyTrace({
      captureStartedAt: 100,
      speechEndedAt: 1_000,
      transcriptReadyAt: 1_650,
      usedServerFallback: false,
    });
    trace.markFirstLlmToken(2_350);
    const metrics = trace.markFirstTtsAudio(3_100);

    expect(metrics).toMatchObject({
      path: 'browser',
      speechToTranscriptMs: 650,
      transcriptToFirstTokenMs: 700,
      firstTokenToFirstAudioMs: 750,
      speechToFirstAudioMs: 2_100,
    });
    expect(events).toEqual([metrics]);
    expect(info.mock.calls.flat().join(' ')).not.toContain('full fallback transcript');
    info.mockRestore();
  });

  it('does not publish an aborted turn or publish twice', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const timing = {
      captureStartedAt: 0,
      speechEndedAt: 100,
      transcriptReadyAt: 200,
      usedServerFallback: true,
    };
    const cancelled = createVoiceTurnLatencyTrace(timing);
    cancelled.markFirstLlmToken(300);
    cancelled.cancel();
    expect(cancelled.markFirstTtsAudio(400)).toBeNull();

    const completed = createVoiceTurnLatencyTrace(timing);
    completed.markFirstLlmToken(300);
    expect(completed.markFirstTtsAudio(400)?.path).toBe('server-fallback');
    expect(completed.markFirstTtsAudio(500)).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    info.mockRestore();
  });

  it('publishes no console line, event, or performance measure in production builds', () => {
    vi.stubEnv('DEV', false);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const measure = vi.spyOn(performance, 'measure');
    const listener = vi.fn();
    window.addEventListener('voice-turn-latency', listener);
    try {
      const trace = createVoiceTurnLatencyTrace({
        captureStartedAt: 0,
        speechEndedAt: 100,
        transcriptReadyAt: 200,
        usedServerFallback: false,
      });
      trace.markFirstLlmToken(300);
      expect(trace.markFirstTtsAudio(400)?.speechToFirstAudioMs).toBe(300);

      expect(info).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('voice-turn-latency', listener);
      info.mockRestore();
      measure.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
