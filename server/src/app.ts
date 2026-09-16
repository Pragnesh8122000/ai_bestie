import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import passport from 'passport';
import path from 'path';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import { globalErrorHandler } from './utils/errors';
import authRoutes from './routes/auth';
import avatarRoutes from './routes/avatars';
import personaRoutes from './routes/personas';
import conversationRoutes from './routes/conversations';
import ttsRoutes from './routes/tts';
import { apiRateLimiter, optionalAuth } from './middleware/auth';
import { ttsStatus } from './services/ttsService';

// Initialize Passport strategies
import './config/passport';

const app = express();

// Log route templates and timings, never message bodies or credentials.
app.use((req, res, next) => {
  const started = performance.now();
  const requestId = randomUUID();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    if (config.nodeEnv === 'test') return;
    console.info(
      JSON.stringify({
        event: 'http',
        requestId,
        method: req.method,
        route: req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched',
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      }),
    );
  });
  next();
});

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
        connectSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
app.use(
  cors({
    origin: config.client.url,
    credentials: true,
  }),
);
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(passport.initialize());

// Serve static assets (avatar images) - resolve relative to project root
const publicDir = path.resolve(__dirname, '../public/avatars');
app.use('/avatars', express.static(publicDir));

// Health check (before the global /api limiter so it's not rate-limited)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/ready', (_req, res) => {
  const database = mongoose.connection.readyState === 1;
  const chat = Boolean(config.llm.geminiApiKey || config.llm.openrouterApiKey);
  const voice = ttsStatus().available;
  res.status(database && chat ? 200 : 503).json({
    status: database && chat ? 'ready' : 'unavailable',
    database,
    chat,
    voice: voice ? 'neural' : 'browser-fallback',
  });
});

// TTS endpoint is mounted before the global /api rate limiter: a voice reply
// is several sentences in quick succession and would blow the 10/10s global
// ceiling. Only ttsRateLimiter (mounted inside the router) applies.
app.use('/api/tts', ttsRoutes);

// Global rate limiter for all /api routes. Keyed on userId when authenticated
// (falls back to IP). Protects the LLM streaming endpoint and every other
// non-auth route from quota abuse.
app.use('/api', optionalAuth, apiRateLimiter);

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
