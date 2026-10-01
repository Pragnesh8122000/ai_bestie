import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { catchAsync, AppError } from '../utils/errors';
import { requireAuth, ttsRateLimiter } from '../middleware/auth';
import { synthesize, ttsStatus } from '../services/ttsService';
import { config } from '../config';

const router = Router();

// GET /api/tts/health — model/queue state for operators and uptime checks.
// Public and content-free: no text, no user data, only counters and timings.
router.get('/health', (_req, res) => {
  const s = ttsStatus();
  res.status(s.available ? 200 : 503).json({
    available: s.available,
    warm: s.warm,
    error: s.available ? null : s.error,
    modelVersion: s.modelVersion,
    numThreads: s.numThreads,
    loadMs: s.loadMs,
    queue: s.queue,
    counters: s.counters,
    lastInferMs: s.lastInferMs,
    lastRtf: s.lastRtf,
  });
});

// TTS is stateless text→audio and not tied to a conversation record, so it
// doesn't need the objectId + ownership dance the conversation routes do. It
// still requires auth (so anonymous callers can't burn CPU synthesizing
// arbitrary text) and a dedicated rate limiter.
router.use(requireAuth);

// Client correlation ids (see client/src/utils/tts.ts). Digits only, so a
// header can never smuggle content into the logs.
const correlationId = (value: unknown): string | undefined =>
  typeof value === 'string' && /^\d{1,12}$/.test(value) ? value : undefined;

// POST /api/tts — synthesize a chunk of text to a WAV audio stream.
// Mounted BEFORE the global /api rate limiter in app.ts (a voice reply is
// several sentences in quick succession; the global 10/10s limiter would
// throttle it). Only ttsRateLimiter applies.
router.post(
  '/',
  ttsRateLimiter,
  catchAsync(async (req, res) => {
    const schema = z.object({
      text: z.string().trim().min(1).max(config.tts.maxChars),
      lang: z.string().max(16).optional(),
    });
    const input = schema.parse(req.body);

    // Cancel if the client disconnects (new message, Stop, tab closed): a
    // request still waiting in the queue is dropped before it reaches the
    // model. Native inference already running can't be interrupted.
    const ac = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      ac.abort();
    });

    try {
      const { wav } = await synthesize(input.text, ac.signal, {
        reqId: randomUUID(),
        userId: req.userId,
        generation: correlationId(req.get('X-TTS-Generation')),
        chunk: correlationId(req.get('X-TTS-Chunk')),
        lang: input.lang,
      });
      if (clientClosed || res.destroyed || res.writableEnded) return;
      res.set('Content-Type', 'audio/wav');
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no'); // don't let nginx buffer audio
      res.send(wav);
    } catch (err) {
      if (clientClosed || res.destroyed || res.writableEnded) return;
      const name = (err as Error).name;
      if (name === 'TtsBusyError') {
        // Queue full: a short Retry-After tells the client this is transient
        // (it retries once, then skips the chunk rather than switch voices).
        res.set('Retry-After', '1');
        res.status(503).json({ success: false, code: 'TTS_BUSY', message: 'Voice is busy' });
        return;
      }
      if (name === 'TtsTimeoutError' || name === 'TtsQueueTimeoutError') {
        res.status(503).json({ success: false, code: 'TTS_TIMEOUT', message: 'Voice timed out' });
        return;
      }
      if (err instanceof AppError && err.statusCode === 503) {
        // Model unavailable — client falls back to browser speechSynthesis.
        res.status(503).json({ success: false, code: 'TTS_UNAVAILABLE', message: err.message });
        return;
      }
      // Unexpected failure: treat as 503 so the client falls back rather than
      // surfacing a hard error mid-conversation. Logged by the service.
      res.status(503).json({
        success: false,
        code: 'TTS_FAILED',
        message: 'TTS failed, falling back to browser voice',
      });
    }
  }),
);

export default router;
