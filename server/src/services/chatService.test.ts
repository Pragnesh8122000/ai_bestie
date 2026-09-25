import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deriveTitle, ensureDefaultConversation, openPersonaConversation } from './chatService';
import { toPreview, PREVIEW_MAX_LENGTH } from '../models/Conversation';
import { Conversation } from '../models/Conversation';
import { Persona } from '../models/Persona';
import { ensureDefaultPersona } from './personaService';

vi.mock('../models/Conversation', async () => {
  const actual =
    await vi.importActual<typeof import('../models/Conversation')>('../models/Conversation');
  return {
    ...actual,
    Conversation: {
      findOne: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
    },
  };
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
    const coachPersona = {
      _id: fakeId('coach-persona-id'),
      name: 'Coach Alex',
      archetype: 'coach',
      avatarId: 'coach-male-01',
    };
    const coachConversation = {
      _id: fakeId('coach-conversation-id'),
      userId: 'user-1',
      personaId: fakeId('coach-persona-id'),
      isArchived: false,
    };

    vi.mocked(ensureDefaultPersona).mockResolvedValue(defaultPersona as any);
    vi.mocked(Conversation.findOne).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve(coachConversation) }),
    } as any);
    vi.mocked(Persona.findById).mockResolvedValue(coachPersona as any);

    const result = await ensureDefaultConversation('user-1');

    expect(Persona.findById).toHaveBeenCalledWith(coachConversation.personaId);
    expect(result.persona).toBe(coachPersona);
    expect(result.conversation.personaId).toBe('coach-persona-id');
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
    archetype: 'coach',
    avatarId: 'coach-female-01',
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
