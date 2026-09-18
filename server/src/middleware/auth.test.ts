import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApiRateLimiter, createChatRateLimiter } from './auth';

describe('conversation rate-limit policy', () => {
  it('does not let history loads consume a generation allowance', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.userId = 'user-history';
      next();
    });
    app.use('/api', createApiRateLimiter());
    app.get('/api/conversations/:id', (_req, res) => res.sendStatus(200));
    app.post('/api/conversations/:id/messages/stream', (_req, res) => res.sendStatus(200));

    for (let i = 0; i < 10; i += 1) {
      await request(app).get('/api/conversations/abc').expect(200);
    }
    await request(app).post('/api/conversations/abc/messages/stream').expect(200);
    await request(app).get('/api/conversations/abc').expect(429);
  });

  it('enforces the existing twenty-message generation policy exactly once', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.userId = 'user-generation';
      next();
    });
    app.get('/api/conversations/:id', (_req, res) => res.sendStatus(200));
    app.post(
      '/api/conversations/:id/messages/stream',
      createChatRateLimiter(),
      (_req, res) => res.sendStatus(200),
    );

    for (let i = 0; i < 10; i += 1) {
      await request(app).get('/api/conversations/abc').expect(200);
    }
    for (let i = 0; i < 20; i += 1) {
      await request(app).post('/api/conversations/abc/messages/stream').expect(200);
    }
    const limited = await request(app)
      .post('/api/conversations/abc/messages/stream')
      .expect(429);

    expect(limited.body.message).toBe('Too many messages. Please slow down.');
  });
});
