import { transcribeVoiceClip } from '../api/transcription';
import { isSTTSupported, listenOnce, type ListenSession } from './speech';

// A turn cap, not a single recognition session's length — `listenOnce` now
// restarts transparently across pauses, so this only bounds one whole turn.
const DEFAULT_MAX_MS = 20_000;

export interface VoiceTurnResult {
  transcript: string;
  usedServerFallback: boolean;
}

export interface VoiceTurnSession {
  promise: Promise<VoiceTurnResult>;
  stop: () => void;
}

interface Capture {
  stop: () => Promise<{ blob: Blob; durationMs: number }>;
}

function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

async function startCapture(onLevel?: (level: number) => void): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported in this browser.');
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const chunks: BlobPart[] = [];
  const mimeType = recorderMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const startedAt = performance.now();
  let stopped: Promise<{ blob: Blob; durationMs: number }> | null = null;
  let frame = 0;
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start(250);

  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioContextCtor) {
      context = new AudioContextCtor();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const read = () => {
        analyser?.getByteFrequencyData(values);
        const average = values.reduce((sum, value) => sum + value, 0) / values.length;
        onLevel?.(Math.min(1, average / 90));
        frame = requestAnimationFrame(read);
      };
      frame = requestAnimationFrame(read);
    }
  } catch {
    // Recording remains functional when an analyser cannot be created. The orb
    // keeps its deterministic listening animation in that case.
  }

  const stop = () => {
    if (stopped) return stopped;
    stopped = new Promise<{ blob: Blob; durationMs: number }>((resolve) => {
      const finish = () => {
        if (frame) cancelAnimationFrame(frame);
        onLevel?.(0);
        source?.disconnect();
        analyser?.disconnect();
        void context?.close().catch(() => {});
        stream.getTracks().forEach((track) => track.stop());
        resolve({
          blob: new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }),
          durationMs: Math.max(1, performance.now() - startedAt),
        });
      };

      if (recorder.state === 'inactive') {
        finish();
        return;
      }
      recorder.addEventListener('stop', finish, { once: true });
      recorder.stop();
    });
    return stopped;
  };

  return { stop };
}

/**
 * Capture one voice turn. Browser recognition remains the fast/free path. If
 * the constructor is missing or Brave reports its characteristic `network`
 * failure, the same bounded recording is sent to the authenticated server
 * transcription endpoint.
 */
export function startVoiceTurn(
  onLevel?: (level: number) => void,
  maxMs = DEFAULT_MAX_MS,
  onInterim?: (text: string) => void,
  allowServerFallback = true,
): VoiceTurnSession {
  let cancelled = false;
  let recognition: ListenSession | null = null;
  let capture: Capture | null = null;
  const upload = new AbortController();
  let wakeWait: (() => void) | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      wakeWait = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const promise = (async (): Promise<VoiceTurnResult> => {
    const startedAt = performance.now();
    capture = await startCapture(onLevel);
    if (cancelled) {
      await capture.stop();
      return { transcript: '', usedServerFallback: false };
    }

    let shouldFallback = !isSTTSupported();
    if (!shouldFallback) {
      recognition = listenOnce('en-US', onInterim, maxMs);
      try {
        const transcript = (await recognition.promise).trim();
        if (cancelled) return { transcript: '', usedServerFallback: false };
        if (transcript) {
          await capture.stop();
          return { transcript, usedServerFallback: false };
        }
        await capture.stop();
        return { transcript: '', usedServerFallback: false };
      } catch (error) {
        if (cancelled) return { transcript: '', usedServerFallback: false };
        const code = error instanceof Error ? error.message : '';
        if (code !== 'network') {
          await capture.stop();
          throw error;
        }
        shouldFallback = true;
      }
    }

    if (!shouldFallback) return { transcript: '', usedServerFallback: false };
    if (!allowServerFallback) {
      await capture.stop();
      return { transcript: '', usedServerFallback: false };
    }
    await wait(maxMs - (performance.now() - startedAt));
    const recording = await capture.stop();
    if (cancelled || recording.blob.size === 0) {
      return { transcript: '', usedServerFallback: true };
    }
    const result = await transcribeVoiceClip(recording.blob, recording.durationMs, upload.signal);
    return { transcript: result.text.trim(), usedServerFallback: true };
  })().finally(() => {
    recognition = null;
    capture = null;
    wakeWait = null;
    onLevel?.(0);
  });

  return {
    promise,
    stop: () => {
      if (cancelled) return;
      cancelled = true;
      recognition?.stop();
      wakeWait?.();
      upload.abort();
      void capture?.stop();
      onLevel?.(0);
    },
  };
}
