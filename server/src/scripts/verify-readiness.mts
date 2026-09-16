/** Isolated LOCAL integration check. Creates and cleans up its own test user. */
import mongoose, { Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { config } from '../config/index.ts';
import jwt from 'jsonwebtoken';

const base = process.env.READINESS_BASE_URL || 'http://localhost:3001';
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) ||
  !/^mongodb:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/i.test(config.mongodb.uri)
) {
  throw new Error(
    'This check only supports a local server and local MongoDB. It creates and removes disposable test data.',
  );
}

let cookie = '';
let userId: Types.ObjectId | undefined;
const results: Record<string, unknown> = {};
async function request(path: string, init: RequestInit = {}) {
  return fetch(base + path, {
    ...init,
    signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...init.headers },
  });
}
async function json(path: string, init: RequestInit = {}) {
  const res = await request(path, init);
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${path}: HTTP ${res.status}`);
  return res.json();
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

try {
  await mongoose.connect(config.mongodb.uri);
  const ready = await json('/api/ready');
  check(ready.database && ready.chat, 'Server dependencies not ready');
  results.readiness = ready;
  const collection = mongoose.connection.collection('conversations');
  const indexes = await collection.indexes();
  results.expiryIndexAbsent = !indexes.some((index) => index.expireAfterSeconds !== undefined);

  const account = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: `readiness-${randomUUID()}@example.invalid`,
      password: randomUUID(),
      name: 'Readiness Test',
    }),
  });
  check(account.ok, `Test registration failed: HTTP ${account.status}`);
  cookie = account.headers.get('set-cookie')?.split(';')[0] || '';
  check(cookie, 'No test auth cookie');
  userId = new Types.ObjectId((await account.json()).data.user.id);
  const initial = (await json('/api/conversations/default')).data;
  const conversationId = initial.conversation.id;
  const personaId = initial.persona.id;
  const avatarId = initial.persona.avatarId;

  // Tied timestamps across pages must not drop the boundary rows.
  const tiedTime = new Date('2026-01-01T00:00:00Z');
  await collection.insertMany(
    Array.from({ length: 5 }, () => ({
      _id: new Types.ObjectId(),
      userId,
      personaId: new Types.ObjectId(personaId),
      avatarId,
      title: 'Pagination Test',
      messages: [],
      messageCount: 0,
      lastMessagePreview: '',
      lastMessageAt: tiedTime,
      createdAt: tiedTime,
      isArchived: false,
      titleIsCustom: false,
    })),
  );
  const page1 = (await json('/api/conversations?limit=2&before=2026-02-01T00:00:00Z')).data
    .conversations;
  const last = page1[page1.length - 1];
  const page2 = (
    await json(
      `/api/conversations?limit=2&before=${encodeURIComponent(last.lastMessageAt)}&beforeId=${last.id}`,
    )
  ).data.conversations;
  check(
    page1.length === 2 &&
      page2.length === 2 &&
      new Set([...page1, ...page2].map((c: any) => c.id)).size === 4,
    'Tied pagination lost or repeated rows',
  );
  results.tiedPagination = 'pass';

  const start = performance.now();
  const stream = await request(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ message: 'Greet a test user in exactly two short sentences.' }),
  });
  check(stream.ok && stream.body, `Chat request failed: HTTP ${stream.status}`);
  const overlap = await request(`/api/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    body: JSON.stringify({ message: 'This duplicate concurrent request should be rejected.' }),
  });
  check(overlap.status === 409, 'Concurrent reply was not rejected');
  results.overlappingReply = 'rejected';
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let messageId = '';
  let firstTokenMs: number | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === 'error')
        throw new Error('Live provider reply failed; inspect server timings');
      if (event.type === 'token') {
        firstTokenMs ??= Math.round(performance.now() - start);
        text += event.content;
      }
      if (event.type === 'done') messageId = event.messageId;
    }
  }
  check(text.trim() && messageId, 'No complete live reply');
  const detail = (await json(`/api/conversations/${conversationId}`)).data.conversation;
  check(
    detail.messages.length === 2 &&
      detail.messages[1].content === text &&
      detail.messages[1]._id === messageId,
    'Saved transcript or message ID differs from stream',
  );
  results.liveChat = {
    firstTokenMs,
    durationMs: Math.round(performance.now() - start),
    persistedMessages: detail.messages.length,
    messageIdMatches: true,
    samples: 1,
  };

  // Synthesis timings and WAV bytes are real; these are not audible playback metrics.
  const timings: number[] = [];
  for (let i = 0; i < 3; i++) {
    const began = performance.now();
    const pendingAudio = request('/api/tts', {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello there. This is a voice readiness test.' }),
    });
    const healthStart = performance.now();
    await json('/api/health');
    results.healthDuringSynthesisMs = Math.round(performance.now() - healthStart);
    const audio = await pendingAudio;
    check(audio.ok, `Neural synthesis failed: HTTP ${audio.status}`);
    const bytes = Buffer.from(await audio.arrayBuffer());
    check(
      bytes.length > 44 &&
        bytes.toString('ascii', 0, 4) === 'RIFF' &&
        bytes.toString('ascii', 8, 12) === 'WAVE',
      'Invalid voice WAV',
    );
    timings.push(Math.round(performance.now() - began));
  }
  results.neuralSynthesis = { samples: timings.length, durationMs: timings, validWav: true };
  const healthStart = performance.now();
  await json('/api/health');
  results.healthLatencyMs = Math.round(performance.now() - healthStart);
  // 99 authenticated identities exercise indexed DB reads and rate-limit
  // separation. This does NOT simulate 99 LLM completions or voice calls.
  const readTimings = await Promise.all(
    Array.from({ length: 99 }, async () => {
      const token = jwt.sign({ id: new Types.ObjectId().toHexString() }, config.jwt.secret, {
        expiresIn: '1m',
      });
      const began = performance.now();
      const res = await request('/api/conversations', { headers: { cookie: `token=${token}` } });
      check(res.ok, `Concurrent indexed read failed: HTTP ${res.status}`);
      await res.json();
      return performance.now() - began;
    }),
  );
  readTimings.sort((a, b) => a - b);
  results.concurrentIndexedReads = {
    concurrency: 99,
    passed: 99,
    p95Ms: Math.round(readTimings[Math.ceil(readTimings.length * 0.95) - 1]),
    scope: 'Authenticated indexed reads only; excludes LLM and TTS capacity',
  };
  check(
    results.expiryIndexAbsent,
    'Local database still has a destructive TTL index; prepare and review migration before release',
  );
  console.log(JSON.stringify({ status: 'pass', ...results }, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unknown failure',
        ...results,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (userId) {
    await mongoose.connection.collection('conversations').deleteMany({ userId });
    await mongoose.connection.collection('personas').deleteMany({ userId });
    await mongoose.connection.collection('users').deleteOne({ _id: userId });
  }
  await mongoose.disconnect();
}
