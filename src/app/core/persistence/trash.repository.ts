import type { Clock } from '../domain/clock';
import type { TrashItem } from '../domain/models';
import { TRASH_RETENTION_DAYS } from '../domain/trash';
import { ChangeJournal } from './change-journal';
import { recordPurge } from './purge';
import type { SqlDriver, SqlExecutor, SqlRow } from './sql-driver';

interface TrashRow extends SqlRow {
  kind: 'milestone' | 'memory';
  id: string;
  title: string | null;
  date: string;
  deleted_at: string;
  memory_count: number;
  photo_count: number;
}

/**
 * "Recently deleted" (docs/PARTNER_SYNC.md §6.6). Deleting moves items here; either
 * person can restore them for 30 days, after which they are purged with their photos.
 *
 * Deleting from here, or the 30-day purge, is final: in a shared space a content-free
 * purge record takes the item off every device and the server (PARTNER_SYNC §18).
 */
export class TrashRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly journal: ChangeJournal = new ChangeJournal(clock),
  ) {}

  /** Trashed dates (with the memories that went with them) and memories trashed on their own, newest first. */
  async list(): Promise<TrashItem[]> {
    const rows = await this.db.query<TrashRow>(
      `SELECT 'milestone' AS kind, m.id, m.title, m.event_date AS date, m.deleted_at,
              (SELECT COUNT(*) FROM memories x WHERE x.trashed_with = m.id AND x.deleted_at IS NOT NULL) AS memory_count,
              (SELECT COUNT(*) FROM memory_media mm JOIN memories x ON x.id = mm.memory_id
                 WHERE x.trashed_with = m.id AND x.deleted_at IS NOT NULL AND mm.deleted_at IS NULL) AS photo_count
         FROM milestones m WHERE m.deleted_at IS NOT NULL
       UNION ALL
       SELECT 'memory' AS kind, x.id, x.title, x.memory_date AS date, x.deleted_at, 0 AS memory_count,
              (SELECT COUNT(*) FROM memory_media mm WHERE mm.memory_id = x.id AND mm.deleted_at IS NULL) AS photo_count
         FROM memories x WHERE x.deleted_at IS NOT NULL AND x.trashed_with IS NULL
       ORDER BY deleted_at DESC, id`,
    );
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      title: r.title,
      date: r.date,
      deletedAt: r.deleted_at,
      memoryCount: r.memory_count,
      photoCount: r.photo_count,
    }));
  }

  /** Restores a date and every memory that went to the trash with it. Its reminders return unchanged. */
  async restoreMilestone(id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now().toString();
      const memories = await tx.query<{ id: string }>(
        'SELECT id FROM memories WHERE trashed_with = ? AND deleted_at IS NOT NULL',
        [id],
      );
      for (const memory of memories) await this.restoreRow(tx, 'memories', 'memory', memory.id, now);
      await this.restoreRow(tx, 'milestones', 'milestone', id, now);
    });
  }

  async restoreMemory(id: string): Promise<void> {
    await this.db.transaction((tx) => this.restoreRow(tx, 'memories', 'memory', id, this.clock.now().toString()));
  }

  /** Removes a trashed item for good. Returns app-private files that can now be deleted. */
  async deleteForever(kind: TrashItem['kind'], id: string): Promise<string[]> {
    return this.db.transaction((tx) => this.removeForever(tx, kind, id));
  }

  /** Purges items deleted more than 30 days ago, and old photo tombstones. Returns files to delete. */
  async purgeExpired(): Promise<string[]> {
    const now = this.clock.now().toString();
    const cutoff = this.clock.now().subtract({ hours: 24 * TRASH_RETENTION_DAYS }).toString();
    return this.db.transaction(async (tx) => {
      const files: string[] = [];
      const expired = await tx.query<{ kind: TrashItem['kind']; id: string }>(
        `SELECT 'milestone' AS kind, id FROM milestones WHERE deleted_at IS NOT NULL AND deleted_at < ?
         UNION ALL
         SELECT 'memory' AS kind, id FROM memories WHERE deleted_at IS NOT NULL AND trashed_with IS NULL AND deleted_at < ?`,
        [cutoff, cutoff],
      );
      for (const item of expired) files.push(...(await this.removeForever(tx, item.kind, item.id)));
      // Photos removed while editing were deleted from disk already; drop their old tombstones.
      const old = await tx.query<{ id: string }>('SELECT id FROM memory_media WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
      for (const m of old) await recordPurge(tx, this.journal, now, 'memory_media', m.id);
      await tx.run('DELETE FROM memory_media WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff]);
      return files;
    });
  }

  private async restoreRow(tx: SqlExecutor, table: 'milestones' | 'memories', type: 'milestone' | 'memory', id: string, now: string) {
    const version = await this.journal.stamp(tx);
    const extra = table === 'memories' ? ', trashed_with = NULL' : '';
    await tx.run(
      `UPDATE ${table} SET deleted_at = NULL${extra}, version = ?, updated_at = ?, author_person_id = ? WHERE id = ? AND deleted_at IS NOT NULL`,
      [version, now, await this.journal.selfPersonId(tx), id],
    );
    await this.journal.changed(tx, type, id, version);
  }

  private async removeForever(tx: SqlExecutor, kind: TrashItem['kind'], id: string): Promise<string[]> {
    const files: string[] = [];
    const memoryIds =
      kind === 'milestone'
        ? (await tx.query<{ id: string }>('SELECT id FROM memories WHERE trashed_with = ? AND deleted_at IS NOT NULL', [id])).map((r) => r.id)
        : [id];
    for (const memoryId of memoryIds) {
      const media = await tx.query<{ file_path: string | null; thumbnail_path: string | null; deleted_at: string | null }>(
        'SELECT file_path, thumbnail_path, deleted_at FROM memory_media WHERE memory_id = ?',
        [memoryId],
      );
      for (const m of media) {
        if (m.deleted_at) continue; // tombstone: file already removed
        if (m.file_path) files.push(m.file_path); // a photo from the space may not be downloaded yet
        if (m.thumbnail_path) files.push(m.thumbnail_path);
      }
      const gone = await tx.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM memories WHERE id = ? AND deleted_at IS NOT NULL',
        [memoryId],
      );
      if ((gone[0]?.n ?? 0) === 0) continue;
      const now = this.clock.now().toString();
      await recordPurge(tx, this.journal, now, 'memory', memoryId);
      for (const m of await tx.query<{ id: string }>('SELECT id FROM memory_media WHERE memory_id = ?', [memoryId])) {
        await recordPurge(tx, this.journal, now, 'memory_media', m.id);
      }
      // Not a foreign key any more (records arrive in any order): the photos go explicitly.
      await tx.run('DELETE FROM memory_media WHERE memory_id = ?', [memoryId]);
      await tx.run('DELETE FROM memories WHERE id = ?', [memoryId]);
    }
    if (kind === 'milestone') {
      const own = await tx.query<{ photo_path: string | null }>(
        'SELECT photo_path FROM milestones WHERE id = ? AND deleted_at IS NOT NULL',
        [id],
      );
      if (own[0]?.photo_path) files.push(own[0].photo_path);
      // Kept memories still pointing at this date become unlinked for good.
      await tx.run('UPDATE memories SET milestone_id = NULL WHERE milestone_id = ?', [id]);
      const trashed = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM milestones WHERE id = ? AND deleted_at IS NOT NULL', [id]);
      if ((trashed[0]?.n ?? 0) > 0) await recordPurge(tx, this.journal, this.clock.now().toString(), 'milestone', id);
      await tx.run('DELETE FROM milestones WHERE id = ? AND deleted_at IS NOT NULL', [id]); // rules cascade
    }
    return files;
  }
}
