import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyToken } from '../utils/jwt';
import { AppError } from '../utils/errors';

// Extend Express Request type to include user
declare global {
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const token = req.cookies?.token;

  if (!token) {
    return next(new AppError('Authentication required', 401));
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return next(new AppError('Invalid or expired token', 401));
  }

  req.userId = decoded.id;
  next();
};

export const optionalAuth = (req: Request, _res: Response, next: NextFunction): void => {
  const token = req.cookies?.token;

  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      req.userId = decoded.id;
    }
  }

  next();
};

export const authRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5, // 5 attempts per window for auth routes
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiRateLimiter = rateLimit({
  windowMs: 10 * 1000, // 10 seconds
  max: 10, // 10 requests per 10 seconds per user
  keyGenerator: (req: Request) => req.userId || req.ip || 'unknown',
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for the LLM streaming chat endpoint. Each request fans out
// to (potentially several) upstream LLM calls against free-tier quotas, so a
// single user hammering it can exhaust the shared Gemini/OpenRouter budget.
// Keyed on the authenticated userId so one logged-in user can't burn it.
export const chatRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 messages per minute per user
  keyGenerator: (req: Request) => req.userId || req.ip || 'unknown',
  message: {
    success: false,
    message: 'Too many messages. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Limiter for the TTS endpoint. A single voice reply is 3–8 sentences, each
// its own request, so this is intentionally generous; the in-service synthesis
// mutex (ttsService) is what actually bounds CPU. The endpoint is mounted
// before the global /api limiter in app.ts, so only this applies.
export const ttsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 TTS chunks per minute per user
  keyGenerator: (req: Request) => req.userId || req.ip || 'unknown',
  message: {
    success: false,
    message: 'Too many voice requests. Please slow down.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});