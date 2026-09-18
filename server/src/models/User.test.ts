import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { User } from './User';

describe('User authentication providers', () => {
  it('allows a Google-only user without a password', async () => {
    const user = new User({
      email: 'google@example.com',
      name: 'Google User',
      authProviders: ['google'],
      googleSubject: 'google-subject-1',
    });

    await expect(user.validate()).resolves.toBeUndefined();
    await expect(user.comparePassword('not-a-password')).resolves.toBe(false);
  });

  it('requires the durable credential for each declared provider', async () => {
    const passwordUser = new User({
      email: 'password@example.com',
      name: 'Password User',
      authProviders: ['password'],
    });
    const googleUser = new User({
      email: 'missing-subject@example.com',
      name: 'Google User',
      authProviders: ['google'],
    });

    await expect(passwordUser.validate()).rejects.toMatchObject({
      errors: { password: expect.anything() },
    });
    await expect(googleUser.validate()).rejects.toMatchObject({
      errors: { googleSubject: expect.anything() },
    });
  });

  it('keeps password comparison working for a dual-provider account', async () => {
    const password = await bcrypt.hash('correct horse battery staple', 4);
    const user = new User({
      email: 'dual@example.com',
      name: 'Dual User',
      password,
      authProviders: ['password', 'google'],
      googleSubject: 'google-subject-2',
    });

    await expect(user.comparePassword('correct horse battery staple')).resolves.toBe(true);
    await expect(user.comparePassword('wrong password')).resolves.toBe(false);
  });

  it('declares a partial unique index for Google subjects', () => {
    const index = User.schema.indexes().find(([keys]) => keys.googleSubject === 1);

    expect(index).toBeDefined();
    expect(index?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { googleSubject: { $type: 'string' } },
    });
  });
});
