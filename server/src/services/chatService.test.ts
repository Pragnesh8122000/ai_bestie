import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  deriveTitle,
  ensureDefaultConversation,
  handleChatStream,
  openPersonaConversation,
} from './chatService';
import { toPreview, PREVIEW_MAX_LENGTH } from '../models/Conversation';
import { Conversation } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { ensureDefaultPersona } from './personaService';
import { streamChat } from './llmService';
import { setMetricSink } from '../utils/metricsLog';

vi.mock('../models/Conversation', async () => {
  const actual =
    await vi.importActual<typeof import('../models/Conversation')>('../models/Conversation');
  return {
    ...actual,
    Conversation: {
      findOne: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      updateOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
  };
});

vi.mock('./llmService', async () => {
  const actual = await vi.importActual<typeof import('./llmService')>('./llmService');
  return { ...actual, streamChat: vi.fn() };
});

vi.mock('../models/Persona', () => ({
  Persona: {
    findById: vi.fn(),
    findOne: vi.fn(),
  },
}));

vi.mock('./personaService', () => ({
  ensureDefaultPersona: vi.fn(),
  assembleSystemPrompt: vi.fn(),
}));

describe('deriveTitle', () => {
  it('keeps a short message verbatim', () => {
    expect(deriveTitle('Hi')).toBe('Hi');
  });

  it('collapses whitespace and newlines', () => {
    expect(deriveTitle('  hello   there\n\nfriend  ')).toBe('hello there friend');
  });

  it('strips a wrapping quote pair', () => {
    expect(deriveTitle('"what should I do tonight"')).toBe('what should I do tonight');
    expect(deriveTitle('“smart quotes too”')).toBe('smart quotes too');
  });

  it('leaves an unbalanced quote alone', () => {
    expect(deriveTitle('"unclosed')).toBe('"unclosed');
  });

  it('clips a long message on a word boundary', () => {
    const title = deriveTitle(
      'I need help planning a trip to Lisbon next month with my whole family',
    );
    expect(title.length).toBeLessThanOrEqual(51); // 50 + ellipsis
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/); // no dangling space before the ellipsis
    expect(title).toBe('I need help planning a trip to Lisbon next month…');
  });

  it('hard-clips when there is no usable word boundary', () => {
    const title = deriveTitle('x'.repeat(80));
    expect(title).toBe(`${'x'.repeat(50)}…`);
  });

  it('does not gut a title when the only space is very early', () => {
    const title = deriveTitle(`a ${'b'.repeat(80)}`);
    expect(title.length).toBe(51);
  });

  it('falls back to the default for empty or whitespace input', () => {
    expect(deriveTitle('')).toBe('New Conversation');
    expect(deriveTitle('   ')).toBe('New Conversation');
    expect(deriveTitle('""')).toBe('New Conversation');
  });

  it('handles emoji-only messages', () => {
    expect(deriveTitle('\u{1F44B}')).toBe('\u{1F44B}');
  });
});

describe('toPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(toPreview('  a\n\n b  ')).toBe('a b');
  });

  it('clips to the preview maximum', () => {
    expect(toPreview('y'.repeat(300))).toHaveLength(PREVIEW_MAX_LENGTH);
  });

  it('returns an empty string for empty input', () => {
    expect(toPreview('')).toBe('');
  });
});

describe('ensureDefaultConversation', () => {
  const fakeId = (hex: string) => ({
    toHexString: () => hex,
    toString: () => hex,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resumes the most recently active conversation under its own persona, not the default one', async () => {
    const defaultPersona = {
      _id: fakeId('default-persona-id'),
      name: 'Sam',
      archetype: 'friend',
      avatarId: 'friend-male-01',
    };
    const mentorPersona = {
      _id: fakeId('mentor-persona-id'),
      name: 'Mentor Alex',
      archetype: 'mentor',
      avatarId: 'mentor-male-01',
    };
    const mentorConversation = {
      _id: fakeId('mentor-conversation-id'),
      userId: 'user-1',
      personaId: fakeId('mentor-persona-id'),
      isArchived: false,
    };

    vi.mocked(ensureDefaultPersona).mockResolvedValue(defaultPersona as any);
    vi.mocked(Conversation.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(mentorConversation) }),
    } as any);
    vi.mocked(Persona.findById).mockResolvedValue(mentorPersona as any);

    const result = await ensureDefaultConversation('user-1');

    expect(Persona.findById).toHaveBeenCalledWith(mentorConversation.personaId);
    expect(result.persona).toBe(mentorPersona);
    expect(result.conversation.personaId).toBe('mentor-persona-id');
  });

  it('uses the default persona when the resumed conversation already belongs to it', async () => {
    const defaultPersona = {
      _id: fakeId('default-persona-id'),
      name: 'Sam',
      archetype: 'friend',
      avatarId: 'friend-male-01',
    };
    const defaultConversation = {
      _id: fakeId('default-conversation-id'),
      userId: 'user-1',
      personaId: fakeId('default-persona-id'),
      isArchived: false,
    };

    vi.mocked(ensureDefaultPersona).mockResolvedValue(defaultPersona as any);
    vi.mocked(Conversation.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(defaultConversation) }),
    } as any);

    const result = await ensureDefaultConversation('user-1');

    expect(Persona.findById).not.toHaveBeenCalled();
    expect(result.persona).toBe(defaultPersona);
  });
});

describe('openPersonaConversation', () => {
  const fakeId = (hex: string) => ({
    toHexString: () => hex,
    toString: () => hex,
  });
  const persona = {
    _id: fakeId('507f1f77bcf86cd799439011'),
    userId: fakeId('507f1f77bcf86cd799439012'),
    name: 'Riley',
    archetype: 'mentor',
    avatarId: 'mentor-female-01',
    traits: {},
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Persona.findOne).mockReturnValue({
      lean: () => Promise.resolve(persona),
    } as any);
  });

  it('opens the latest existing chat without creating a duplicate', async () => {
    const existing = {
      _id: fakeId('507f1f77bcf86cd799439013'),
      userId: persona.userId,
      personaId: persona._id,
      avatarId: persona.avatarId,
      messages: [],
    };
    vi.mocked(Conversation.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(existing) }),
    } as any);

    const result = await openPersonaConversation(
      '507f1f77bcf86cd799439012',
      persona._id.toString(),
    );

    expect(result?.conversation.id).toBe('507f1f77bcf86cd799439013');
    expect(result?.persona).toBe(persona);
    expect(Conversation.create).not.toHaveBeenCalled();
  });

  it('creates exactly one first chat when the persona has no conversation', async () => {
    const created = {
      _id: fakeId('507f1f77bcf86cd799439014'),
      userId: persona.userId,
      personaId: persona._id,
      avatarId: persona.avatarId,
      messages: [],
    };
    vi.mocked(Conversation.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(null) }),
    } as any);
    vi.mocked(Conversation.create).mockResolvedValue(created as any);
    vi.mocked(Conversation.findById).mockReturnValue({
      lean: () => Promise.resolve(created),
    } as any);

    const result = await openPersonaConversation(
      '507f1f77bcf86cd799439012',
      persona._id.toString(),
    );

    expect(result?.conversation.id).toBe('507f1f77bcf86cd799439014');
    expect(Conversation.create).toHaveBeenCalledTimes(1);
    expect(Conversation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: persona._id.toString(),
        avatarId: persona.avatarId,
      }),
    );
  });

  it('does not open or create a chat for a persona the user does not own', async () => {
    vi.mocked(Persona.findOne).mockReturnValue({
      lean: () => Promise.resolve(null),
    } as any);

    await expect(
      openPersonaConversation('507f1f77bcf86cd799439012', persona._id.toString()),
    ).resolves.toBeNull();
    expect(Conversation.findOne).not.toHaveBeenCalled();
    expect(Conversation.create).not.toHaveBeenCalled();
  });
});

describe('handleChatStream metrics', () => {
  const lines: string[] = [];

  const fakeRes = () =>
    ({
      destroyed: false,
      writableEnded: false,
      setHeader: vi.fn(),
      write: vi.fn(),
      on: vi.fn(),
      end: vi.fn(function (this: any) {
        this.writableEnded = true;
      }),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
    lines.length = 0;
    setMetricSink((l) => lines.push(l));
    vi.mocked(Conversation.findOne).mockResolvedValue({ _id: 'c1', personaId: 'p1' } as any);
    vi.mocked(Persona.findById).mockResolvedValue({ _id: 'p1' } as any);
    vi.mocked(Conversation.updateOne).mockResolvedValue({} as any);
    vi.mocked(Conversation.findOneAndUpdate).mockResolvedValue({
      getRecentMessages: () => [{ role: 'user', content: 'hello there' }],
    } as any);
  });

  afterEach(() => setMetricSink(null));

  it('logs one chat.turn line with timings and sizes but no text', async () => {
    vi.mocked(streamChat).mockImplementation(async (opts: any) => {
      opts.onProvider({ provider: 'gemini', model: 'flash-x', failedAttempts: 1 });
      opts.onToken('Hi ');
      opts.onToken('friend');
      opts.onEnd('Hi friend');
      return 'Hi friend';
    });

    await handleChatStream('u1', 'c1', 'my secret message', fakeRes(), true);

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      evt: 'chat.turn',
      userId: 'u1',
      conversationId: 'c1',
      voiceMode: true,
      outcome: 'ok',
      provider: 'gemini',
      model: 'flash-x',
      failedAttempts: 1,
      inputChars: 'my secret message'.length,
      contextMessages: 1,
      replyChars: 'Hi friend'.length,
      tokenChunks: 2,
    });
    for (const key of ['prepMs', 'llmConnectMs', 'ttfbMs', 'llmTtftMs', 'streamMs', 'totalMs']) {
      expect(typeof entry[key]).toBe('number');
    }
    expect(entry.totalMs).toBeGreaterThanOrEqual(entry.ttfbMs);
    expect(lines[0]).not.toContain('my secret message');
    expect(lines[0]).not.toContain('Hi friend');
  });

  it('logs an error outcome with a null ttfb when the LLM fails before any token', async () => {
    const { LlmProviderError } = await import('./llmService');
    vi.mocked(streamChat).mockRejectedValue(
      new LlmProviderError('LLM_BUSY', 'busy', 'gemini/flash-x=429:rate-limit'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleChatStream('u1', 'c1', 'hello', fakeRes(), false);

    expect(JSON.parse(lines[0])).toMatchObject({
      evt: 'chat.turn',
      voiceMode: false,
      outcome: 'error',
      errorCode: 'LLM_BUSY',
      failureSummary: 'gemini/flash-x=429:rate-limit',
      ttfbMs: null,
      provider: null,
      replyChars: 0,
    });
  });
});
