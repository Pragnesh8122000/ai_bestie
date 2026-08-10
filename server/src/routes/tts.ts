import { Router } from 'express';
import { z } from 'zod';
import { catchAsync, AppError } from '../utils/errors';
import { requireAuth, ttsRateLimiter } from '../middleware/auth';
import { synthesize } from '../services/ttsService';
import { config } from '../config';

const router = Router();

// TTS is stateless text→audio and not tied to a conversation record, so it
// doesn't need the objectId + ownership dance the conversation routes do. It
// still requires auth (so anonymous callers can't burn CPU synthesizing
// arbitrary text) and a dedicated rate limiter.
router.use(requireAuth);

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
      lang: z.string().optional(),
    });
    const input = schema.parse(req.body);

    // Cancel synthesis if the client disconnects (new message, tab closed,
    // toggle-off). The signal flows into generateAsync's onProgress, which
    // returns 0 to stop the inference and free the CPU.
    const ac = new AbortController();
    let clientClosed = false;
    res.on('close', () => {
      clientClosed = true;
      ac.abort();
    });

    try {
      const wav = await synthesize(input.text, ac.signal);
      if (clientClosed || res.destroyed || res.writableEnded) return;
      res.set('Content-Type', 'audio/wav');
      res.set('Cache-Control', 'no-store');
      res.set('X-Accel-Buffering', 'no'); // don't let nginx buffer audio
      res.send(wav);
    } catch (err) {
      if (clientClosed || res.destroyed || res.writableEnded) return;
      if (err instanceof AppError && err.statusCode === 503) {
        // Model unavailable — client falls back to browser speechSynthesis.
        res.status(503).json({ success: false, message: err.message });
        return;
      }
      // 499 (cancelled) or unexpected failure: treat as 503 so the client
      // falls back rather than surfacing a hard error mid-conversation.
      res
        .status(503)
        .json({ success: false, message: 'TTS failed, falling back to browser voice' });
    }
  }),
);

export default router;