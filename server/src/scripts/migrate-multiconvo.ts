/**
 * One-off, idempotent migration for multi-conversation support.
 *
 *   npx tsx src/scripts/migrate-multiconvo.ts
 *
 * Two operations:
 *   1. Drop the `expiresAt_1` TTL index. Until this runs, MongoDB deletes every
 *      conversation 48 hours after its last message — Mongoose creates indexes
 *      but never drops them, so this cannot happen as a side effect of deploy.
 *   2. Backfill `messageCount`, `lastMessagePreview`, `isArchived`, `deletedAt`
 *      and `titleIsCustom` on existing documents.
 *
 * Safe to re-run: the index drop tolerates IndexNotFound and the backfill sets
 * fields to computed values rather than incrementing them.
 */
import mongoose from 'mongoose';
import { config } from '../config/index';
import { PREVIEW_MAX_LENGTH } from '../models/Conversation';

const TTL_INDEX_NAME = 'expiresAt_1';
const LEGACY_SORT_INDEX = 'userId_1_lastMessageAt_-1';

async function dropIndexIfExists(
  collection: mongoose.mongo.Collection,
  name: string,
): Promise<void> {
  try {
    await collection.dropIndex(name);
    console.log(`  dropped index ${name}`);
  } catch (error: any) {
    // 27 = IndexNotFound, 26 = NamespaceNotFound — both mean "already gone".
    if (error?.code === 27 || error?.code === 26) {
      console.log(`  index ${name} already absent`);
      return;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  await mongoose.connect(config.mongodb.uri);
  console.log(`connected: ${mongoose.connection.host}/${mongoose.connection.name}`);

  const collection = mongoose.connection.collection('conversations');

  console.log('\n1. indexes');
  await dropIndexIfExists(collection, TTL_INDEX_NAME);
  await dropIndexIfExists(collection, LEGACY_SORT_INDEX);
  await collection.createIndex(
    { userId: 1, isArchived: 1, lastMessageAt: -1 },
    { name: 'userId_1_isArchived_1_lastMessageAt_-1', background: true },
  );
  console.log('  ensured userId_1_isArchived_1_lastMessageAt_-1');

  console.log('\n2. backfill');
  const result = await collection.updateMany({}, [
    {
      $set: {
        messageCount: { $size: { $ifNull: ['$messages', []] } },
        lastMessagePreview: {
          $substrCP: [
            { $ifNull: [{ $last: '$messages.content' }, ''] },
            0,
            PREVIEW_MAX_LENGTH,
          ],
        },
        isArchived: { $ifNull: ['$isArchived', false] },
        deletedAt: { $ifNull: ['$deletedAt', null] },
        // A title that isn't the schema default was set deliberately (older
        // code seeded the persona name), so treat it as user-owned and don't
        // let auto-titling clobber it.
        titleIsCustom: {
          $ifNull: [
            '$titleIsCustom',
            { $ne: [{ $ifNull: ['$title', 'New Conversation'] }, 'New Conversation'] },
          ],
        },
      },
    },
    // The TTL field is dead weight once the index is gone.
    { $unset: 'expiresAt' },
  ]);
  console.log(`  matched ${result.matchedCount}, modified ${result.modifiedCount}`);

  await mongoose.disconnect();
  console.log('\ndone');
}

main().catch(async (error) => {
  console.error('migration failed:', error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
