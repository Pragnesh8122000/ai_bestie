import { transcribeVoiceClip } from '../api/transcription';
import { isSTTSupported, listenOnce, type ListenSession } from './speech';
import { createVoiceTrace, type VoiceTrace } from './voiceTrace';

// A turn cap, not a single recognition session's length — `listenOnce` now
// restarts transparently across pauses, so this only bounds one whole turn.
const DEFAULT_MAX_MS = 30_000;
// Keep a small transport margin under the server's matching 30s limit. This
// used to be 11.5s, which silently clipped longer sentences.
const SERVER_CLIP_MAX_MS = 29_500;
// Preserve the fast 1.2s commit for short fallback answers; longer fallback
// utterances use LONG_SPEECH_SILENCE_MS below.
const END_OF_SPEECH_SILENCE_MS = 1_200;
const LONG_SPEECH_SILENCE_MS = 2_200;
const LONG_UTTERANCE_MS = 1_200;

/**
 * Energy-based end-of-turn detection for the recorded (server fallback) path,
 * fed the analyser level (0..1) the orb already uses. Ends the turn after
 * speech followed by `silenceMs` of quiet, so a short answer is uploaded in
 * ~1s instead of after the whole recording window.
 */
export function createEndOfSpeechDetector({
  speechLevel = 0.12,
  silenceLevel = 0.06,
  silenceMs = END_OF_SPEECH_SILENCE_MS,
  minSpeechMs = 250,
} = {}) {
  let speechStartedAt: number | null = null;
  let lastLoudAt = 0;
  let heardSpeech = false;
  let noiseFloor = 0.015;
  return {
    /** Feed one level sample; returns true once the speaker has finished. */
    update(level: number, now: number): boolean {
      if (level >= speechLevel) {
        speechStartedAt ??= now;
        lastLoudAt = now;
        if (now - speechStartedAt >= minSpeechMs) heardSpeech = true;
      } else {
        if (!heardSpeech) {
          // Learn the room's baseline before speech starts. The activity floor
          // stays capped below the speech threshold, so a noisy room can delay
          // commit but cannot manufacture speech.
          noiseFloor = noiseFloor * 0.92 + level * 0.08;
          if (level < silenceLevel) speechStartedAt = null; // a click, not speech
        }

        const activityLevel = Math.max(0.025, Math.min(silenceLevel, noiseFloor + 0.02));
        // Once speech is established, quieter trailing syllables still count as
        // activity. The old code only refreshed on `speechLevel`, so soft words
        // at the end of a sentence were included in the 1.2s silence window.
        if (heardSpeech && level >= activityLevel) lastLoudAt = now;
      }
      const utteranceMs = speechStartedAt === null ? 0 : lastLoudAt - speechStartedAt;
      const requiredSilence = utteranceMs >= LONG_UTTERANCE_MS ? LONG_SPEECH_SILENCE_MS : silenceMs;
      const activityLevel = Math.max(0.025, Math.min(silenceLevel, noiseFloor + 0.02));
      return heardSpeech && level < activityLevel && now - lastLoudAt >= requiredSilence;
    },
    lastSpeechAt(): number | null {
      return heardSpeech ? lastLoudAt : null;
    },
  };
}

export interface VoiceTurnResult {
  transcript: string;
  usedServerFallback: boolean;
}

export interface VoiceTurnSession {
  promise: Promise<VoiceTurnResult>;
  stop: () => void;
}

export interface VoiceTurnTiming {
  captureStartedAt: number;
  speechEndedAt: number;
  transcriptReadyAt: number;
  usedServerFallback: boolean;
  /** Stage timeline for this turn; handed on to the chat request and TTS. */
  trace?: VoiceTrace;
}

interface BraveNavigator extends Navigator {
  brave?: { isBrave?: () => Promise<boolean> };
}

async function isBraveBrowser(): Promise<boolean> {
  try {
    return Boolean(await (navigator as BraveNavigator).brave?.isBrave?.());
  } catch {
    return false;
  }
}

interface Capture {
  stop: () => Promise<{ blob: Blob; durationMs: number }>;
}

function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type));
}

async function startCapture(
  onLevel?: (level: number) => void,
  trace?: VoiceTrace,
): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('Microphone recording is not supported in this browser.');
  }

  trace?.mark('mic.request');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  trace?.mark('mic.granted');
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
  trace?.mark('recorder.started');

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
 * Capture one voice turn. Browser recognition remains the fast/free path.
 * Brave is detected before its known-slow `network` failure; an unavailable
 * recognizer or runtime network failure uses the same bounded recording and
 * authenticated server transcription endpoint.
 */
export function startVoiceTurn(
  onLevel?: (level: number) => void,
  maxMs = DEFAULT_MAX_MS,
  onInterim?: (text: string) => void,
  allowServerFallback = true,
  onTiming?: (timing: VoiceTurnTiming) => void,
): VoiceTurnSession {
  const trace = createVoiceTrace();
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

  // Tracks the mic level for the fallback path's end-of-speech detection.
  const endOfSpeech = createEndOfSpeechDetector();
  let speakerFinished = false;
  let speechEndedAt: number | null = null;
  const levelSink = (level: number) => {
    onLevel?.(level);
    if (endOfSpeech.update(level, performance.now())) {
      speakerFinished = true;
      speechEndedAt ??= endOfSpeech.lastSpeechAt() ?? performance.now();
      wakeWait?.();
    }
  };

  const promise = (async (): Promise<VoiceTurnResult> => {
    const startedAt = performance.now();

    // Brave exposes the constructor but disables the Google recognition
    // backend. Waiting for its inevitable `network` error cost 4–5 seconds in
    // a real browser before the recording could even be uploaded. Detect the
    // browser first and go directly to the already-configured fallback.
    const brave = await isBraveBrowser();
    trace.mark('brave_check');
    trace.meta('brave', brave);
    if (brave && !allowServerFallback) {
      // Silent barge-in probes must never upload paid audio. Keep this session
      // cancellable until the speaking state ends instead of spinning a rapid
      // create/fail/retry loop in Brave.
      await wait(maxMs);
      return { transcript: '', usedServerFallback: false };
    }

    capture = await startCapture(levelSink, trace);
    if (cancelled) {
      await capture.stop();
      return { transcript: '', usedServerFallback: false };
    }

    let shouldFallback = brave || !isSTTSupported();
    trace.setPath(shouldFallback ? 'server-fallback' : 'browser');
    if (!shouldFallback) {
      recognition = listenOnce(
        'en-US',
        onInterim,
        maxMs,
        (at) => {
          speechEndedAt = at;
          trace.mark('stt.last_result', at);
        },
        trace,
      );
      try {
        const transcript = (await recognition.promise).trim();
        if (cancelled) return { transcript: '', usedServerFallback: false };
        if (transcript) {
          await capture.stop();
          const transcriptReadyAt = performance.now();
          trace.mark('stt.transcript', transcriptReadyAt);
          onTiming?.({
            captureStartedAt: startedAt,
            speechEndedAt: speechEndedAt ?? transcriptReadyAt,
            transcriptReadyAt,
            usedServerFallback: false,
            trace,
          });
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
        trace.setPath('server-fallback');
        trace.mark('stt.network_error');
      }
    }

    if (!shouldFallback) return { transcript: '', usedServerFallback: false };
    if (!allowServerFallback) {
      await capture.stop();
      return { transcript: '', usedServerFallback: false };
    }
    // Record until the speaker pauses, or the clip limit — whichever first.
    const deadline = startedAt + Math.min(maxMs, SERVER_CLIP_MAX_MS);
    while (!cancelled && !speakerFinished && performance.now() < deadline) {
      await wait(Math.min(100, deadline - performance.now()));
    }
    const recording = await capture.stop();
    trace.mark('capture.stopped');
    trace.meta('audio_ms', Math.round(recording.durationMs));
    trace.meta('audio_bytes', recording.blob.size);
    if (cancelled || recording.blob.size === 0) {
      return { transcript: '', usedServerFallback: true };
    }
    trace.mark('stt.upload_start');
    const result = await transcribeVoiceClip(
      recording.blob,
      recording.durationMs,
      upload.signal,
      trace.id,
    );
    const transcriptReadyAt = performance.now();
    trace.mark('stt.upload_end', transcriptReadyAt);
    trace.mark('stt.transcript', transcriptReadyAt);
    trace.mark('stt.last_result', speechEndedAt ?? endOfSpeech.lastSpeechAt() ?? undefined);
    onTiming?.({
      captureStartedAt: startedAt,
      speechEndedAt:
        speechEndedAt ?? endOfSpeech.lastSpeechAt() ?? recording.durationMs + startedAt,
      transcriptReadyAt,
      usedServerFallback: true,
      trace,
    });
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
