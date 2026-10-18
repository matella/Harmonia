import type { Clock } from '../domain/clock';
import type { Memory, MemoryMedia } from '../domain/models';
import type { ValidMemory } from '../domain/validation';
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
  ) {}

  async list(): Promise<Memory[]> {
    const [memories, media] = await Promise.all([
      this.db.query<MemoryRow>('SELECT * FROM memories ORDER BY memory_date DESC, created_at DESC, id'),
      this.db.query<MediaRow>('SELECT * FROM memory_media ORDER BY memory_id, sort_order, created_at'),
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
    const rows = await this.db.query<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
    if (!rows[0]) return null;
    const media = await this.db.query<MediaRow>('SELECT * FROM memory_media WHERE memory_id = ? ORDER BY sort_order', [id]);
    return this.toMemory(rows[0], media.map(toMedia));
  }

  async create(input: ValidMemory, files: readonly StoredMediaFile[]): Promise<Memory> {
    const id = this.newId();
    const now = this.clock.now().toString();
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO memories (id, milestone_id, title, body, memory_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, input.milestoneId, input.title, input.body, input.memoryDate, now, now],
      );
      await this.appendMedia(tx, id, files, 0, now);
    });
    return (await this.get(id))!;
  }

  /** Returns app-private files that are no longer referenced after the update. */
  async update(id: string, input: ValidMemory, changes: MediaChanges): Promise<{ memory: Memory; orphanedFiles: string[] }> {
    const now = this.clock.now().toString();
    const orphanedFiles = await this.db.transaction(async (tx) => {
      const found = await tx.query<{ id: string }>('SELECT id FROM memories WHERE id = ?', [id]);
      if (found.length === 0) throw new Error('Memory not found');
      await tx.run(
        'UPDATE memories SET milestone_id = ?, title = ?, body = ?, memory_date = ?, updated_at = ? WHERE id = ?',
        [input.milestoneId, input.title, input.body, input.memoryDate, now, id],
      );
      const removed: string[] = [];
      for (const mediaId of changes.removeIds) {
        const rows = await tx.query<MediaRow>('SELECT * FROM memory_media WHERE id = ? AND memory_id = ?', [mediaId, id]);
        for (const row of rows) {
          removed.push(row.file_path);
          if (row.thumbnail_path) removed.push(row.thumbnail_path);
        }
        await tx.run('DELETE FROM memory_media WHERE id = ? AND memory_id = ?', [mediaId, id]);
      }
      const max = await tx.query<{ n: number | null }>('SELECT MAX(sort_order) AS n FROM memory_media WHERE memory_id = ?', [id]);
      await this.appendMedia(tx, id, changes.add, (max[0]?.n ?? -1) + 1, now);
      return removed;
    });
    return { memory: (await this.get(id))!, orphanedFiles };
  }

  async delete(id: string): Promise<{ orphanedFiles: string[] }> {
    return this.db.transaction(async (tx) => {
      const media = await tx.query<MediaRow>('SELECT * FROM memory_media WHERE memory_id = ?', [id]);
      await tx.run('DELETE FROM memories WHERE id = ?', [id]); // media rows cascade
      return { orphanedFiles: media.flatMap((m) => (m.thumbnail_path ? [m.file_path, m.thumbnail_path] : [m.file_path])) };
    });
  }

  /** Every media path referenced by the database (for safe orphan cleanup). */
  async referencedFiles(): Promise<Set<string>> {
    const rows = await this.db.query<{ path: string | null }>(
      `SELECT file_path AS path FROM memory_media
       UNION SELECT thumbnail_path FROM memory_media
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
      await tx.run(
        `INSERT INTO memory_media (id, memory_id, file_path, thumbnail_path, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [this.newId(), memoryId, file.filePath, file.thumbnailPath, order++, now],
      );
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
