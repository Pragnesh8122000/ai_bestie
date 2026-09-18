import { describe, expect, it } from 'vitest';
import { serializeAuthUser } from './authUser';

describe('serializeAuthUser', () => {
  it('returns one canonical shape for dual-provider users without credentials', () => {
    const createdAt = new Date('2026-09-18T00:00:00.000Z');
    const result = serializeAuthUser({
      _id: { toString: () => 'user-1' },
      email: 'person@gmail.com',
      name: 'Person',
      password: 'never-return-this-hash',
      googleSubject: 'never-return-this-subject',
      authProviders: ['password', 'google'],
      activePersonaId: { toString: () => 'persona-1' },
      preferences: { theme: 'system', notifications: true },
      createdAt,
    });

    expect(result).toEqual({
      id: 'user-1',
      email: 'person@gmail.com',
      name: 'Person',
      authProviders: ['password', 'google'],
      activePersonaId: 'persona-1',
      preferences: { theme: 'system', notifications: true },
      createdAt,
    });
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('googleSubject');
  });

  it('reports legacy password users honestly before migration runs', () => {
    expect(serializeAuthUser({ id: 'legacy', email: 'old@example.com', name: 'Old' }))
      .toMatchObject({ id: 'legacy', authProviders: ['password'] });
  });
});
