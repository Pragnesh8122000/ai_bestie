import path from 'node:path';
import fs from 'node:fs';
import { OfflineTts, GenerationConfig, type GeneratedAudio } from 'sherpa-onnx-node';
import { config } from '../config';
import { AppError } from '../utils/errors';

/**
 * In-process neural TTS via sherpa-onnx (Kokoro English v0_19). Runs inside the
 * Express server — no sidecar, no second always-on service — so the app stays
 * within the Render free process-hour budget.
 *
 * The model is loaded once (lazily on first use / boot) as a process-wide
 * singleton. Synthesis uses `generateAsync` (not the synchronous `generate`),
 * which runs inference on the addon's internal worker thread so the event
 * loop stays free — an in-flight chat SSE stream's heartbeat keeps firing
 * while a sentence is being synthesized. An AbortSignal cancels mid-synthesis
 * (the onProgress callback returns 0), so a client disconnect stops burning
 * CPU instead of finishing a reply nobody will hear.
 *
 * If the model is missing or fails to load, `synthesize` throws AppError(503)
 * and the client falls back to browser speechSynthesis for that chunk.
 */

let tts: OfflineTts | null = null;
let loadAttempted = false;
let loadError: string | null = null;
let loadingPromise: Promise<void> | null = null;

function modelFilesPresent(): boolean {
  const dir = config.tts.modelDir;
  return (
    fs.existsSync(path.join(dir, 'model.onnx')) &&
    fs.existsSync(path.join(dir, 'voices.bin')) &&
    fs.existsSync(path.join(dir, 'tokens.txt')) &&
    fs.existsSync(path.join(dir, 'espeak-ng-data'))
  );
}

/** Load the model once. Idempotent and safe to call repeatedly. */
export async function initTts(): Promise<void> {
  if (loadAttempted || loadingPromise) return loadingPromise ?? Promise.resolve();
  loadingPromise = (async () => {
    try {
      if (!config.tts.enabled) {
        loadError = 'TTS disabled (TTS_ENABLED=false)';
        return;
      }
      if (!modelFilesPresent()) {
        loadError = `Kokoro model not found at ${config.tts.modelDir}`;
        return;
      }
      const dir = config.tts.modelDir;
      tts = await OfflineTts.createAsync({
        model: {
          kokoro: {
            model: path.join(dir, 'model.onnx'),
            voices: path.join(dir, 'voices.bin'),
            tokens: path.join(dir, 'tokens.txt'),
            dataDir: path.join(dir, 'espeak-ng-data'),
          },
          debug: false,
          numThreads: 1,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      });
    } catch (e) {
      loadError = (e as Error).message;
      tts = null;
    } finally {
      loadAttempted = true;
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

export interface TtsStatus {
  available: boolean;
  error: string | null;
  sampleRate: number | null;
}

export function ttsStatus(): TtsStatus {
  return {
    available: tts !== null,
    error: loadError,
    sampleRate: tts ? tts.sampleRate : null,
  };
}

// Serialize synthesis so concurrent requests don't interleave on the CPU. One
// sentence at a time is fine for a single-user free deployment; the limiter
// and this mutex together bound queue depth.
let chain: Promise<unknown> = Promise.resolve();
function enqueue(task: () => Promise<GeneratedAudio>): Promise<GeneratedAudio> {
  // Run the task whether the previous one resolved or rejected, so one bad
  // request can't stall the whole queue.
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Synthesize `text` to a 16-bit mono PCM WAV Buffer. Throws AppError(503) if
 * the model is unavailable. The AbortSignal cancels mid-synthesis.
 */
export async function synthesize(text: string, signal: AbortSignal): Promise<Buffer> {
  await initTts();
  if (!tts) throw new AppError('TTS unavailable', 503);

  const trimmed = text.trim();
  if (!trimmed) throw new AppError('Nothing to synthesize', 400);

  const audio = await enqueue(() =>
    tts!.generateAsync({
      text: trimmed,
      generationConfig: new GenerationConfig({
        sid: config.tts.sid,
        speed: 1.0,
      }),
      onProgress: () => (signal.aborted ? 0 : 1),
    }),
  );

  if (signal.aborted) throw new AppError('TTS cancelled', 499);
  return encodeWav(audio.samples, audio.sampleRate);
}

/** Build a 44-byte-header WAV (mono, 16-bit PCM) from float32 samples. */
function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  // fmt chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // subchunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  // data chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // float32 [-1,1] -> int16 PCM
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), offset);
    offset += 2;
  }
  return buffer;
}