import type { ChangeJournal } from './change-journal';
import type { SqlExecutor } from './sql-driver';

/** What can be deleted for good (and so purged in a shared space). */
export type PurgeableType = 'milestone' | 'memory' | 'memory_media';
export const PURGEABLE_TYPES: readonly PurgeableType[] = ['milestone', 'memory', 'memory_media'];

/**
 * Records that `id` is deleted for good (docs/PARTNER_SYNC.md §18): a content-free purge
 * record, queued for the space so every device deletes it too, and kept here so a pull
 * never brings it back. A photo's space on the server is queued for release (it is freed
 * once the purge is on the server). Call before deleting the rows.
 */
export async function recordPurge(
  tx: SqlExecutor,
  journal: ChangeJournal,
  now: string,
  type: PurgeableType,
  id: string,
): Promise<void> {
  if (type === 'memory_media') await queueBlobRelease(tx, id, now);
  const version = await journal.stamp(tx);
  await tx.run(
    `INSERT INTO purges (id, record_type, version, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET record_type = excluded.record_type, version = excluded.version`,
    [id, type, version, now],
  );
  await journal.changed(tx, 'purge', id, version);
}

/** The photo's blob, if it has one, is to be freed on the server. */
export async function queueBlobRelease(
  tx: SqlExecutor,
  mediaId: string,
  now: string,
): Promise<void> {
  const blob = (
    await tx.query<{ blob_id: string | null }>('SELECT blob_id FROM memory_media WHERE id = ?', [
      mediaId,
    ])
  )[0]?.blob_id;
  if (!blob) return;
  await tx.run(
    `INSERT INTO blob_releases (blob_id, media_id, created_at) VALUES (?, ?, ?)
     ON CONFLICT (blob_id) DO NOTHING`,
    [blob, mediaId, now],
  );
}
