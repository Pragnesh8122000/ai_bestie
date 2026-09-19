import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import passport from 'passport';
import path from 'path';
import { config } from './config';
import { globalErrorHandler } from './utils/errors';
import authRoutes from './routes/auth';
import avatarRoutes from './routes/avatars';
import personaRoutes from './routes/personas';
import conversationRoutes from './routes/conversations';
import ttsRoutes from './routes/tts';
import { apiRateLimiter } from './middleware/auth';

// Initialize Passport strategies
import './config/passport';

const app = express();

// Behind any reverse proxy (Vercel/Render/Heroku/Nginx) req.ip must reflect the
// real client, otherwise every client collapses into one rate-limit bucket.
app.set('trust proxy', 1);

// Security middleware. Custom CSP (matches docs/deployment.md): the browser
// only connects to its own origin (LLM calls are server-side), and voice
// replies play audio fetched from /api/tts via blob: URLs, so media-src needs
// 'self' + blob:. crossOriginEmbedderPolicy is off so blob audio plays.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        frameSrc: ["'self'", 'https://accounts.google.com/gsi/'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'", 'https://accounts.google.com/gsi/client'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com/gsi/style'],
      },
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(cors({
  origin: config.client.url,
  credentials: true,
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(passport.initialize());

// Serve static assets (avatar images) - resolve relative to this file so it
// works regardless of the process's cwd (differs between `npm run dev -w
// server`, the root workspace script, and the built dist/ output).
const publicDir = path.resolve(__dirname, '../public/avatars');
app.use('/avatars', express.static(publicDir));

// Health check (before the global /api limiter so it's not rate-limited)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TTS endpoint is mounted before the global /api rate limiter: a voice reply
// is several sentences in quick succession and would blow the 10/10s global
// ceiling. Only ttsRateLimiter (mounted inside the router) applies.
app.use('/api/tts', ttsRoutes);

// Generic limiter for /api routes. Generation is explicitly skipped and has
// one authoritative per-user limiter inside the conversation router.
app.use('/api', apiRateLimiter);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/avatars', avatarRoutes);
app.use('/api/personas', personaRoutes);
app.use('/api/conversations', conversationRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler
app.use(globalErrorHandler);

export default app;
