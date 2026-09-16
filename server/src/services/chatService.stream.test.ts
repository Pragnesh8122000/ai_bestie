import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../models/Conversation', () => ({
  Conversation: { findOne: vi.fn(), updateOne: vi.fn(), create: vi.fn() },
  toPreview: (text: string) => text.slice(0, 120),
}));
vi.mock('../models/Persona', () => ({ Persona: { findById: vi.fn(), findOne: vi.fn() } }));
vi.mock('./personaService', () => ({
  assembleSystemPrompt: () => 'test',
  ensureDefaultPersona: vi.fn(),
}));
vi.mock('./llmService', () => ({ streamChat: vi.fn() }));
vi.mock('../config/index', () => ({ config: { nodeEnv: 'test' } }));

import { handleChatStream, createConversation, listConversations } from './chatService';
import { Conversation } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { streamChat } from './llmService';
import type { Response } from 'express';

class FakeResponse extends EventEmitter {
  chunks: string[] = [];
  destroyed = false;
  writableEnded = false;
  statusCode = 200;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  json() {
    this.writableEnded = true;
    return this;
  }
  setHeader() {}
  write(chunk: string) {
    this.chunks.push(chunk);
  }
  end() {
    this.writableEnded = true;
  }
  response() {
    return this as unknown as Response;
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Conversation.findOne).mockResolvedValue({
    _id: 'conversation',
    personaId: 'persona',
    getRecentMessages: () => [{ role: 'user', content: 'hello' }],
  } as any);
  vi.mocked(Persona.findById).mockResolvedValue({} as any);
  vi.mocked(Persona.findOne).mockResolvedValue({} as any);
  vi.mocked(Conversation.updateOne).mockResolvedValue({ matchedCount: 1 } as any);
  vi.mocked(streamChat).mockImplementation(async ({ onToken, onEnd }) => {
    onToken?.('Hello.');
    onEnd?.('Hello.');
    return 'Hello.';
  });
});

describe('chat persistence and concurrency', () => {
  it('sends done only after saving and uses the saved message ID', async () => {
    const res = new FakeResponse();
    await handleChatStream('user', 'conversation', 'hello', res.response());
    const writes = vi.mocked(Conversation.updateOne).mock.calls;
    const saved = (writes[writes.length - 1][1] as any).$push.messages;
    const done = res.chunks
      .map((chunk) => JSON.parse(chunk.slice(6)))
      .find((frame) => frame.type === 'done');
    expect(done.messageId).toBe(saved._id.toHexString());
    expect(saved.content).toBe('Hello.');
    expect(res.writableEnded).toBe(true);
  });

  it('rejects concurrent work before adding a duplicate user message', async () => {
    let finish!: (value: any) => void;
    vi.mocked(Conversation.findOne).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }) as any,
    );
    const first = handleChatStream('user', 'conversation', 'hello', new FakeResponse().response());
    await expect(
      handleChatStream('user', 'conversation', 'duplicate', new FakeResponse().response()),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(Conversation.updateOne).not.toHaveBeenCalled();
    finish(null);
    await first;
    // A failed/finished request must release its slot.
    await handleChatStream('user', 'conversation', 'retry', new FakeResponse().response());
  });

  it('does not report completion when the conversation was archived during the reply', async () => {
    vi.mocked(Conversation.updateOne)
      .mockResolvedValueOnce({ matchedCount: 1 } as any)
      .mockResolvedValueOnce({ matchedCount: 1 } as any)
      .mockResolvedValueOnce({ matchedCount: 0 } as any);
    const res = new FakeResponse();
    await handleChatStream('user', 'conversation', 'hello', res.response());
    expect(res.chunks.join('')).toContain('"type":"error"');
    expect(res.chunks.join('')).not.toContain('"type":"done"');
  });

  it('rejects a persona not owned by the user before creating a conversation', async () => {
    vi.mocked(Persona.findOne).mockResolvedValue(null);
    await expect(
      createConversation('user', '507f1f77bcf86cd799439011', 'avatar'),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(Conversation.create).not.toHaveBeenCalled();
  });

  it('uses an ID tie-breaker in a timestamp pagination boundary', async () => {
    const query = {
      select: vi.fn().mockReturnThis(),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue([]),
    };
    (Conversation as any).find = vi.fn().mockReturnValue(query);
    const before = new Date('2026-01-01');
    await listConversations('user', { before, beforeId: '507f1f77bcf86cd799439011' });
    expect(query.sort).toHaveBeenCalledWith({ lastMessageAt: -1, _id: -1 });
    expect((Conversation as any).find.mock.calls[0][0].$or).toHaveLength(2);
  });
});
