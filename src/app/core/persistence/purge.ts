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
  if (type === 'memory_media' || type === 'milestone') await queueBlobRelease(tx, id, now, type);
  const version = await journal.stamp(tx);
  await tx.run(
    `INSERT INTO purges (id, record_type, version, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET record_type = excluded.record_type, version = excluded.version`,
    [id, type, version, now],
  );
  await journal.changed(tx, 'purge', id, version);
}

/** Where each kind of record keeps its photo's blob. */
export const PHOTO_TABLES = {
  memory_media: 'memory_media',
  milestone: 'milestones',
  profile: 'relationship_profile',
} as const;
export type PhotoOwner = keyof typeof PHOTO_TABLES;

/**
 * The record's photo blob, if it has one, is to be freed on the server once `waitsFor`
 * (its purge, or its own new version) is there.
 */
export async function queueBlobRelease(
  tx: SqlExecutor,
  id: string,
  now: string,
  owner: PhotoOwner = 'memory_media',
  waitsFor: 'purge' | PhotoOwner = 'purge',
): Promise<void> {
  const blob = (
    await tx.query<{ blob_id: string | null }>(
      `SELECT blob_id FROM ${PHOTO_TABLES[owner]} WHERE id = ?`,
      [id],
    )
  )[0]?.blob_id;
  if (!blob) return;
  await tx.run(
    `INSERT INTO blob_releases (blob_id, media_id, created_at, waits_for) VALUES (?, ?, ?, ?)
     ON CONFLICT (blob_id) DO NOTHING`,
    [blob, id, now, waitsFor],
  );
}

/**
 * The record's photo changed here: its old blob is freed once the new version is up, and
 * the new photo (if any) is still to be uploaded.
 */
export async function photoReplaced(
  tx: SqlExecutor,
  owner: 'milestone' | 'profile',
  id: string,
  now: string,
): Promise<void> {
  await queueBlobRelease(tx, id, now, owner, owner);
  await tx.run(
    `UPDATE ${PHOTO_TABLES[owner]} SET blob_id = NULL, blob_key = NULL, blob_header = NULL,
       blob_size = NULL, blob_state = 'local', download_attempts = 0 WHERE id = ?`,
    [id],
  );
}
