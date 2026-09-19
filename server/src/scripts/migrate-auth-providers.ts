/**
 * Idempotent user-auth migration.
 *
 *   npm run migrate:auth -w server
 *
 * Backfills the provider array from durable credentials, removes the legacy
 * single-provider label, and creates the partial-unique Google subject index.
 * Re-running computes and sets the same values.
 */
import mongoose from 'mongoose';
import { config } from '../config';

type UserCollection = Pick<
  mongoose.mongo.Collection,
  'updateMany' | 'countDocuments' | 'createIndex'
>;

export async function runAuthProviderMigration(collection: UserCollection): Promise<void> {
  const invalid = await collection.countDocuments({
    password: { $not: { $type: 'string' } },
    googleSubject: { $not: { $type: 'string' } },
  });
  if (invalid > 0) {
    throw new Error(
      `Refusing auth migration: ${invalid} user(s) have neither a password nor a Google subject`,
    );
  }

  await collection.updateMany(
    { password: { $type: 'string' }, googleSubject: { $type: 'string' } },
    { $set: { authProviders: ['password', 'google'] } },
  );
  await collection.updateMany(
    { password: { $type: 'string' }, googleSubject: { $not: { $type: 'string' } } },
    { $set: { authProviders: ['password'] } },
  );
  await collection.updateMany(
    { password: { $not: { $type: 'string' } }, googleSubject: { $type: 'string' } },
    { $set: { authProviders: ['google'] } },
  );
  await collection.updateMany({}, { $unset: { authProvider: '' } });

  await collection.createIndex(
    { googleSubject: 1 },
    {
      name: 'googleSubject_1',
      unique: true,
      partialFilterExpression: { googleSubject: { $type: 'string' } },
      background: true,
    },
  );
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongodb.uri);
  console.log(`connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  await runAuthProviderMigration(mongoose.connection.collection('users'));

  await mongoose.disconnect();
  console.log('auth provider migration complete');
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('auth provider migration failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
