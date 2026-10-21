import type { Clock } from '../domain/clock';
import type { Memory, MemoryMedia } from '../domain/models';
import type { ValidMemory } from '../domain/validation';
import { ChangeJournal } from './change-journal';
import type { IdFactory } from './ids';
import type { SqlDriver, SqlExecutor, SqlRow } from './sql-driver';

interface MemoryRow extends SqlRow {
  id: string;
  milestone_id: string | null;
  title: string | null;
  body: string | null;
  memory_date: string;
  created_at: string;
  updated_at: string;
}

interface MediaRow extends SqlRow {
  id: string;
  memory_id: string;
  file_path: string;
  thumbnail_path: string | null;
  sort_order: number;
  created_at: string;
}

/** A stored image ready to be attached to a memory. */
export interface StoredMediaFile {
  filePath: string;
  thumbnailPath: string | null;
}

export interface MediaChanges {
  /** Newly stored files to append, in order. */
  add: readonly StoredMediaFile[];
  /** IDs of existing media to detach. */
  removeIds: readonly string[];
}

function toMedia(row: MediaRow): MemoryMedia {
  return {
    id: row.id,
    memoryId: row.memory_id,
    filePath: row.file_path,
    thumbnailPath: row.thumbnail_path,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export class MemoryRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly newId: IdFactory,
    private readonly journal: ChangeJournal = new ChangeJournal(clock),
  ) {}

  /** Active memories (not in the trash) with their current photos. */
  async list(): Promise<Memory[]> {
    const [memories, media] = await Promise.all([
      this.db.query<MemoryRow>('SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY memory_date DESC, created_at DESC, id'),
      this.db.query<MediaRow>('SELECT * FROM memory_media WHERE deleted_at IS NULL ORDER BY memory_id, sort_order, created_at'),
    ]);
    const byMemory = new Map<string, MemoryMedia[]>();
    for (const row of media) {
      const list = byMemory.get(row.memory_id) ?? [];
      list.push(toMedia(row));
      byMemory.set(row.memory_id, list);
    }
    return memories.map((row) => this.toMemory(row, byMemory.get(row.id) ?? []));
  }

  async get(id: string): Promise<Memory | null> {
    const rows = await this.db.query<MemoryRow>('SELECT * FROM memories WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!rows[0]) return null;
    const media = await this.db.query<MediaRow>(
      'SELECT * FROM memory_media WHERE memory_id = ? AND deleted_at IS NULL ORDER BY sort_order',
      [id],
    );
    return this.toMemory(rows[0], media.map(toMedia));
  }

  async create(input: ValidMemory, files: readonly StoredMediaFile[]): Promise<Memory> {
    const id = this.newId();
    const now = this.clock.now().toString();
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      await tx.run(
        `INSERT INTO memories (id, milestone_id, title, body, memory_date, created_at, updated_at, version, author_person_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.milestoneId, input.title, input.body, input.memoryDate, now, now, version, await this.journal.selfPersonId(tx)],
      );
      await this.appendMedia(tx, id, files, 0, now);
      await this.journal.changed(tx, 'memory', id, version);
    });
    return (await this.get(id))!;
  }

  /**
   * Returns app-private files that are no longer referenced after the update. Removed
   * photos leave a tombstone row (for sync); their files can be deleted right away.
   */
  async update(id: string, input: ValidMemory, changes: MediaChanges): Promise<{ memory: Memory; orphanedFiles: string[] }> {
    const now = this.clock.now().toString();
    const orphanedFiles = await this.db.transaction(async (tx) => {
      const found = await tx.query<{ id: string }>('SELECT id FROM memories WHERE id = ? AND deleted_at IS NULL', [id]);
      if (found.length === 0) throw new Error('Memory not found');
      const version = await this.journal.stamp(tx);
      await tx.run(
        `UPDATE memories SET milestone_id = ?, title = ?, body = ?, memory_date = ?, updated_at = ?,
           version = ?, author_person_id = ? WHERE id = ?`,
        [input.milestoneId, input.title, input.body, input.memoryDate, now, version, await this.journal.selfPersonId(tx), id],
      );
      const removed: string[] = [];
      for (const mediaId of changes.removeIds) {
        const rows = await tx.query<MediaRow>(
          'SELECT * FROM memory_media WHERE id = ? AND memory_id = ? AND deleted_at IS NULL',
          [mediaId, id],
        );
        for (const row of rows) {
          removed.push(row.file_path);
          if (row.thumbnail_path) removed.push(row.thumbnail_path);
          const mediaVersion = await this.journal.stamp(tx);
          await tx.run('UPDATE memory_media SET deleted_at = ?, version = ? WHERE id = ?', [now, mediaVersion, row.id]);
          await this.journal.changed(tx, 'memory_media', row.id, mediaVersion);
        }
      }
      const max = await tx.query<{ n: number | null }>(
        'SELECT MAX(sort_order) AS n FROM memory_media WHERE memory_id = ? AND deleted_at IS NULL',
        [id],
      );
      await this.appendMedia(tx, id, changes.add, (max[0]?.n ?? -1) + 1, now);
      await this.journal.changed(tx, 'memory', id, version);
      return removed;
    });
    return { memory: (await this.get(id))!, orphanedFiles };
  }

  /** Moves a memory to the trash (30 days). Its photos stay on disk until it is purged. */
  async delete(id: string): Promise<{ orphanedFiles: string[] }> {
    await this.db.transaction(async (tx) => {
      const now = this.clock.now().toString();
      const version = await this.journal.stamp(tx);
      await tx.run(
        'UPDATE memories SET deleted_at = ?, trashed_with = NULL, version = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        [now, version, now, id],
      );
      await this.journal.changed(tx, 'memory', id, version);
    });
    return { orphanedFiles: [] };
  }

  /**
   * Every media path still in use, for safe orphan cleanup at startup. Items in the trash
   * count as in use (they can be restored); only photo tombstones do not.
   */
  async referencedFiles(): Promise<Set<string>> {
    const rows = await this.db.query<{ path: string | null }>(
      `SELECT file_path AS path FROM memory_media WHERE deleted_at IS NULL
       UNION SELECT thumbnail_path FROM memory_media WHERE deleted_at IS NULL
       UNION SELECT photo_path FROM milestones
       UNION SELECT photo_path FROM relationship_profile`,
    );
    return new Set(rows.map((r) => r.path).filter((p): p is string => !!p));
  }

  private async appendMedia(
    tx: SqlExecutor,
    memoryId: string,
    files: readonly StoredMediaFile[],
    startOrder: number,
    now: string,
  ): Promise<void> {
    let order = startOrder;
    for (const file of files) {
      const id = this.newId();
      const version = await this.journal.stamp(tx);
      await tx.run(
        `INSERT INTO memory_media (id, memory_id, file_path, thumbnail_path, sort_order, created_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, memoryId, file.filePath, file.thumbnailPath, order++, now, version],
      );
      await this.journal.changed(tx, 'memory_media', id, version);
    }
  }

  private toMemory(row: MemoryRow, media: MemoryMedia[]): Memory {
    return {
      id: row.id,
      milestoneId: row.milestone_id,
      title: row.title,
      body: row.body,
      memoryDate: row.memory_date,
      media,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
