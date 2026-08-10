import { Router } from 'express';
import { ZodError } from 'zod';
import passport from 'passport';
import { User } from '../models/User';
import { generateToken, setTokenCookie, clearTokenCookie } from '../utils/jwt';
import { catchAsync, AppError } from '../utils/errors';
import { authRateLimiter, requireAuth } from '../middleware/auth';
import { registerSchema, loginSchema } from '../validations/auth';

const router = Router();

// Helper to format Zod errors
const formatZodError = (error: ZodError) => {
  const fields = error.errors.map((e) => ({
    field: e.path.join('.'),
    message: e.message,
  }));
  return fields;
};

// Register
router.post(
  '/register',
  authRateLimiter,
  catchAsync(async (req, res, next) => {
    let input;
    try {
      input = registerSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: formatZodError(error),
        });
        return;
      }
      return next(error);
    }

    const existingUser = await User.findOne({ email: input.email.toLowerCase() });
    if (existingUser) {
      throw new AppError('Email already registered', 409);
    }

    const user = await User.create({
      email: input.email.toLowerCase(),
      password: input.password,
      name: input.name,
      authProvider: 'email',
    });

    const token = generateToken(user.id);
    setTokenCookie(res, token);

    res.status(201).json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
    });
  }),
);

// Login
router.post(
  '/login',
  authRateLimiter,
  catchAsync(async (req, res, next) => {
    let input;
    try {
      input = loginSchema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({
          success: false,
          message: 'Validation error',
          errors: formatZodError(error),
        });
        return;
      }
      return next(error);
    }

    passport.authenticate('local', { session: false }, (err: any, user: any, info: any) => {
      if (err) return next(err);
      if (!user) {
        return next(new AppError(info?.message || 'Authentication failed', 401));
      }

      const token = generateToken(user.id);
      setTokenCookie(res, token);

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            name: user.name,
          },
        },
      });
    })(req, res, next);
  }),
);

// Logout
router.post(
  '/logout',
  authRateLimiter,
  catchAsync(async (_req, res) => {
    clearTokenCookie(res);
    res.json({ success: true, message: 'Logged out successfully' });
  }),
);

// Get current user
router.get(
  '/me',
  requireAuth,
  catchAsync(async (req, res) => {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          activePersonaId: user.activePersonaId,
          preferences: user.preferences,
          createdAt: user.createdAt,
        },
      },
    });
  }),
);

export default router;