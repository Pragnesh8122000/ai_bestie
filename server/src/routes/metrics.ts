import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, metricsRateLimiter } from '../middleware/auth';
import { catchAsync } from '../utils/errors';
import { logMetric, voiceTurnId } from '../utils/metricsLog';
import { formatIst } from '../utils/time';

const router = Router();
router.use(requireAuth);

// Stage/field names are short identifiers and every value is a bounded number,
// so a client can report timings but can never write free text into the log.
const key = z.string().regex(/^[a-z0-9_.]{1,40}$/);
const ms = z.number().finite().min(0).max(3_600_000);
const num = z.number().finite().min(0).max(1e9);

const chunkSchema = z.object({
  seq: num,
  chars: num,
  status: z.enum(['ok', 'error', 'skipped', 'aborted', 'local']),
  engine: z.enum(['remote', 'local']).optional(),
  attempts: num.optional(),
  bytes: num.optional(),
  audioMs: num.optional(),
  // Offsets (ms since turn start). Absent when the chunk never reached that stage.
  queued: ms.optional(),
  fetchStart: ms.optional(),
  headers: ms.optional(),
  body: ms.optional(),
  decoded: ms.optional(),
  scheduled: ms.optional(),
  // Silence (ms) the listener heard before this chunk started; 0 if gapless.
  gapMs: num.optional(),
});

const schema = z.object({
  turnId: z.string().refine((v) => voiceTurnId(v) === v),
  path: z.enum(['browser', 'server-fallback']),
  outcome: z.enum(['ok', 'no_audio', 'aborted', 'error']),
  startedAt: z.number().finite().min(0).max(1e14), // epoch ms
  stages: z.record(key, ms).refine((o) => Object.keys(o).length <= 48),
  meta: z
    .record(key, z.union([num, z.boolean(), z.string().regex(/^[a-z0-9_.-]{1,24}$/)]))
    .refine((o) => Object.keys(o).length <= 16),
  chunks: z.array(chunkSchema).max(48),
});

// POST /api/metrics/voice — the browser half of a voice turn's timeline.
router.post(
  '/voice',
  metricsRateLimiter,
  catchAsync(async (req, res) => {
    const input = schema.parse(req.body);
    logMetric('voice.turn.client', {
      ...input,
      startedAt: formatIst(input.startedAt),
      userId: req.userId,
    });
    res.status(204).end();
  }),
);

export default router;
