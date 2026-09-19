import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenPayload } from 'google-auth-library';
import {
  authenticateGoogleCredential,
  GoogleIdentityVerifier,
  GoogleUserRepository,
  isGoogleAuthoritative,
} from './googleAuthService';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'person@gmail.com',
    name: 'Person',
    authProviders: ['password'],
    preferences: { theme: 'system', notifications: true },
    createdAt: new Date(),
    lastLoginAt: new Date(),
    comparePassword: vi.fn(),
    ...overrides,
  } as any;
}

function payload(overrides: Partial<TokenPayload> = {}): TokenPayload {
  return {
    sub: 'google-subject',
    email: 'person@gmail.com',
    email_verified: true,
    name: 'Google Person',
    ...overrides,
  } as TokenPayload;
}

describe('Google authentication', () => {
  let verifier: GoogleIdentityVerifier;
  let repository: GoogleUserRepository;

  beforeEach(() => {
    verifier = { verify: vi.fn().mockResolvedValue(payload()) };
    repository = {
      findBySubject: vi.fn().mockResolvedValue(null),
      findByEmail: vi.fn().mockResolvedValue(null),
      link: vi.fn().mockResolvedValue(user({ authProviders: ['password', 'google'] })),
      create: vi.fn().mockImplementation(async (input) => user(input)),
      touch: vi.fn().mockImplementation(async () => user({ googleSubject: 'google-subject' })),
    };
  });

  it('verifies the ID token against the configured client ID and creates a Google-only user', async () => {
    const result = await authenticateGoogleCredential('signed-id-token', {
      clientId: 'web-client.apps.googleusercontent.com',
      verifier,
      repository,
    });

    expect(verifier.verify).toHaveBeenCalledWith(
      'signed-id-token',
      'web-client.apps.googleusercontent.com',
    );
    expect(repository.create).toHaveBeenCalledWith({
      email: 'person@gmail.com',
      name: 'Google Person',
      googleSubject: 'google-subject',
      authProviders: ['google'],
    });
    expect(result.authProviders).toEqual(['google']);
  });

  it('uses the stable subject for a returning user', async () => {
    const existing = user({ googleSubject: 'google-subject', authProviders: ['google'] });
    vi.mocked(repository.findBySubject).mockResolvedValue(existing);
    vi.mocked(repository.touch).mockResolvedValue(existing);

    const result = await authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    });

    expect(result).toBe(existing);
    expect(repository.findByEmail).not.toHaveBeenCalled();
    expect(repository.touch).toHaveBeenCalledWith('user-1');
  });

  it.each([
    ['Gmail', payload()],
    ['Workspace', payload({ email: 'person@company.example', hd: 'company.example' })],
  ])('links an authoritative %s address to the existing password account', async (_kind, token) => {
    vi.mocked(verifier.verify).mockResolvedValue(token);
    vi.mocked(repository.findByEmail).mockResolvedValue(user({ email: token.email }));

    await authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    });

    expect(repository.link).toHaveBeenCalledWith(
      'user-1',
      'google-subject',
      ['password', 'google'],
    );
  });

  it('does not auto-link a third-party email collision', async () => {
    vi.mocked(verifier.verify).mockResolvedValue(payload({ email: 'person@example.com' }));
    vi.mocked(repository.findByEmail).mockResolvedValue(user({ email: 'person@example.com' }));

    await expect(authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    })).rejects.toMatchObject({ statusCode: 409, code: 'ACCOUNT_LINK_REQUIRED' });
    expect(repository.link).not.toHaveBeenCalled();
  });

  it('rejects an unverified email and invalid credentials', async () => {
    vi.mocked(verifier.verify).mockResolvedValueOnce(payload({ email_verified: false }));
    await expect(authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    })).rejects.toMatchObject({ statusCode: 401, code: 'UNVERIFIED_GOOGLE_EMAIL' });

    vi.mocked(verifier.verify).mockRejectedValueOnce(new Error('bad signature'));
    await expect(authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    })).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_GOOGLE_CREDENTIAL' });
  });

  it('rejects an identity conflict instead of moving a linked email', async () => {
    vi.mocked(repository.findByEmail).mockResolvedValue(user({ googleSubject: 'other-subject' }));

    await expect(authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    })).rejects.toMatchObject({ statusCode: 409, code: 'GOOGLE_IDENTITY_CONFLICT' });
  });

  it('is safely disabled when the server client ID is absent', async () => {
    await expect(authenticateGoogleCredential('credential', {
      clientId: '', verifier, repository,
    })).rejects.toMatchObject({ statusCode: 503, code: 'GOOGLE_AUTH_UNAVAILABLE' });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('resolves a concurrent create only by the same stable subject', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    vi.mocked(repository.create).mockRejectedValue(duplicate);
    vi.mocked(repository.findBySubject)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(user({ googleSubject: 'google-subject', authProviders: ['google'] }));

    const result = await authenticateGoogleCredential('credential', {
      clientId: 'client-id', verifier, repository,
    });

    expect(result.googleSubject).toBe('google-subject');
  });
});

describe('isGoogleAuthoritative', () => {
  it('accepts Gmail and verified Workspace, but not third-party verified mail', () => {
    expect(isGoogleAuthoritative(payload())).toBe(true);
    expect(isGoogleAuthoritative(payload({ email: 'a@work.example', hd: 'work.example' }))).toBe(true);
    expect(isGoogleAuthoritative(payload({ email: 'a@example.com' }))).toBe(false);
  });
});
