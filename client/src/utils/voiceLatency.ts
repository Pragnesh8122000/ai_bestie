import type { VoiceTurnTiming } from './voiceCapture';

export interface VoiceTurnLatencyMetrics {
  turnId: number;
  path: 'browser' | 'server-fallback';
  speechToTranscriptMs: number;
  transcriptToFirstTokenMs: number;
  firstTokenToFirstAudioMs: number;
  speechToFirstAudioMs: number;
}

export interface VoiceTurnLatencyTrace {
  markFirstLlmToken: (at?: number) => void;
  markFirstTtsAudio: (at?: number) => VoiceTurnLatencyMetrics | null;
  cancel: () => void;
}

let nextTurnId = 0;

function elapsed(from: number, to: number): number {
  return Math.max(0, Math.round(to - from));
}

function publish(metrics: VoiceTurnLatencyMetrics, timing: VoiceTurnTiming, firstAudioAt: number) {
  try {
    performance.measure(`voice-turn:${metrics.turnId}:speech-to-first-audio`, {
      start: timing.speechEndedAt,
      end: firstAudioAt,
      detail: metrics,
    });
  } catch {
    // PerformanceMeasure options are unavailable in older WebKit. The event
    // and structured console metric below still provide the same timing.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('voice-turn-latency', { detail: metrics }));
  }
  // Timings only: never include transcript or reply text in diagnostics.
  console.info(JSON.stringify({ evt: 'voice.turn.latency', ...metrics }));
}

/**
 * Trace one immersive voice turn across browser/server boundaries. All inputs
 * share the browser Performance time origin, so no clock synchronization is
 * needed and Safari can be measured from the same DevTools event as Brave.
 */
export function createVoiceTurnLatencyTrace(timing: VoiceTurnTiming): VoiceTurnLatencyTrace {
  const turnId = ++nextTurnId;
  let firstTokenAt: number | null = null;
  let cancelled = false;
  let completed = false;

  return {
    markFirstLlmToken(at = performance.now()) {
      if (!cancelled && firstTokenAt === null) firstTokenAt = at;
    },
    markFirstTtsAudio(at = performance.now()) {
      if (cancelled || completed || firstTokenAt === null) return null;
      completed = true;
      const metrics: VoiceTurnLatencyMetrics = {
        turnId,
        path: timing.usedServerFallback ? 'server-fallback' : 'browser',
        speechToTranscriptMs: elapsed(timing.speechEndedAt, timing.transcriptReadyAt),
        transcriptToFirstTokenMs: elapsed(timing.transcriptReadyAt, firstTokenAt),
        firstTokenToFirstAudioMs: elapsed(firstTokenAt, at),
        speechToFirstAudioMs: elapsed(timing.speechEndedAt, at),
      };
      publish(metrics, timing, at);
      return metrics;
    },
    cancel() {
      cancelled = true;
    },
  };
}
