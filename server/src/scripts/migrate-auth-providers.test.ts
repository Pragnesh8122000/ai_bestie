import { describe, expect, it, vi } from 'vitest';
import { runAuthProviderMigration } from './migrate-auth-providers';

function collection(invalid = 0) {
  return {
    countDocuments: vi.fn().mockResolvedValue(invalid),
    updateMany: vi.fn().mockResolvedValue({ acknowledged: true }),
    createIndex: vi.fn().mockResolvedValue('googleSubject_1'),
  };
}

describe('auth provider migration', () => {
  it('backfills all credential combinations and creates the partial unique index', async () => {
    const fake = collection();

    await runAuthProviderMigration(fake as any);

    expect(fake.updateMany.mock.calls).toEqual([
      [
        { password: { $type: 'string' }, googleSubject: { $type: 'string' } },
        { $set: { authProviders: ['password', 'google'] } },
      ],
      [
        { password: { $type: 'string' }, googleSubject: { $not: { $type: 'string' } } },
        { $set: { authProviders: ['password'] } },
      ],
      [
        { password: { $not: { $type: 'string' } }, googleSubject: { $type: 'string' } },
        { $set: { authProviders: ['google'] } },
      ],
      [{}, { $unset: { authProvider: '' } }],
    ]);
    expect(fake.createIndex).toHaveBeenCalledWith(
      { googleSubject: 1 },
      expect.objectContaining({
        name: 'googleSubject_1',
        unique: true,
        partialFilterExpression: { googleSubject: { $type: 'string' } },
      }),
    );
  });

  it('is idempotent because every pass applies the same credential-derived state', async () => {
    const fake = collection();

    await runAuthProviderMigration(fake as any);
    const firstPass = fake.updateMany.mock.calls.slice();
    fake.updateMany.mockClear();
    await runAuthProviderMigration(fake as any);

    expect(fake.updateMany.mock.calls).toEqual(firstPass);
    expect(fake.createIndex).toHaveBeenCalledTimes(2);
  });

  it('refuses to leave a user with no usable authentication method', async () => {
    const fake = collection(2);

    await expect(runAuthProviderMigration(fake as any)).rejects.toThrow(
      '2 user(s) have neither a password nor a Google subject',
    );
    expect(fake.updateMany).not.toHaveBeenCalled();
    expect(fake.createIndex).not.toHaveBeenCalled();
  });
});
