import { randomUUID } from 'node:crypto';
import express, { Router } from 'express';
import { config } from '../config';
import { requireAuth, transcriptionRateLimiter } from '../middleware/auth';
import { supportedTranscriptionMimeTypes, transcribeAudio } from '../services/transcriptionService';
import { AppError, catchAsync } from '../utils/errors';
import { logMetric } from '../utils/metricsLog';

const router = Router();

router.use(requireAuth);

router.post(
  '/',
  transcriptionRateLimiter,
  express.raw({
    type: [...supportedTranscriptionMimeTypes],
    limit: config.transcription.maxBytes,
  }),
  catchAsync(async (req, res) => {
    const mimeType = String(req.headers['content-type'] || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!supportedTranscriptionMimeTypes.has(mimeType)) {
      throw new AppError('Unsupported audio format.', 415, true, 'UNSUPPORTED_AUDIO');
    }

    const durationMs = Number(req.headers['x-audio-duration-ms']);
    if (
      !Number.isFinite(durationMs) ||
      durationMs <= 0 ||
      durationMs > config.transcription.maxDurationMs
    ) {
      throw new AppError(
        `Voice clips must be ${config.transcription.maxDurationMs / 1000} seconds or shorter.`,
        413,
        true,
        'AUDIO_TOO_LONG',
      );
    }

    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw new AppError('The voice clip was empty. Please try again.', 400, true, 'EMPTY_AUDIO');
    }

    const ac = new AbortController();
    req.on('aborted', () => ac.abort());

    // Timings and sizes only: never the audio or the transcript.
    const startedAtMs = Date.now();
    const base = {
      reqId: randomUUID(),
      userId: req.userId,
      model: config.transcription.model,
      mimeType,
      bytes: req.body.length,
      audioMs: Math.round(durationMs),
    };
    try {
      const text = await transcribeAudio(req.body, mimeType, ac.signal);
      logMetric('stt.transcribe', {
        ...base,
        startedAt: new Date(startedAtMs).toISOString(),
        outcome: 'ok',
        latencyMs: Date.now() - startedAtMs,
        textChars: text.length,
      });
      res.json({ success: true, data: { text } });
    } catch (error) {
      logMetric('stt.transcribe', {
        ...base,
        startedAt: new Date(startedAtMs).toISOString(),
        outcome: ac.signal.aborted ? 'client_closed' : 'error',
        latencyMs: Date.now() - startedAtMs,
        errorCode: error instanceof AppError ? (error.code ?? error.statusCode) : 'UNEXPECTED',
      });
      throw error;
    }
  }),
);

export default router;
