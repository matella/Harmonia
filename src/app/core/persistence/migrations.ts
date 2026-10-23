import type { SqlDriver } from './sql-driver';

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

/**
 * Append-only list. Never edit a released migration; add a new one with defaults for
 * existing rows. Each migration runs in its own transaction.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    statements: [
      `CREATE TABLE relationship_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        display_name TEXT,
        relationship_label TEXT,
        start_date TEXT NOT NULL,
        start_time TEXT,
        start_time_zone_id TEXT,
        calendar_time_zone_id TEXT NOT NULL,
        photo_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE milestones (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL CHECK (length(trim(title)) > 0),
        category TEXT NOT NULL,
        event_date TEXT NOT NULL,
        event_time TEXT,
        event_time_zone_id TEXT,
        recurrence_rule TEXT NOT NULL DEFAULT 'none' CHECK (recurrence_rule IN ('none', 'yearly')),
        leap_day_policy TEXT CHECK (leap_day_policy IS NULL OR leap_day_policy IN ('feb28', 'mar1')),
        note TEXT,
        photo_path TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_milestones_event_date ON milestones (event_date)`,
      `CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        milestone_id TEXT REFERENCES milestones (id) ON DELETE SET NULL,
        title TEXT,
        body TEXT,
        memory_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_memories_date ON memories (memory_date)`,
      `CREATE INDEX idx_memories_milestone ON memories (milestone_id)`,
      `CREATE TABLE memory_media (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        thumbnail_path TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX idx_memory_media_memory ON memory_media (memory_id)`,
      `CREATE TABLE reminder_rules (
        id TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL REFERENCES milestones (id) ON DELETE CASCADE,
        offset_days INTEGER NOT NULL CHECK (offset_days BETWEEN 0 AND 365),
        local_time TEXT NOT NULL DEFAULT '09:00',
        is_enabled INTEGER NOT NULL DEFAULT 1,
        include_event_title INTEGER NOT NULL DEFAULT 0,
        notification_id INTEGER NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (milestone_id, offset_days)
      )`,
      `CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE id_sequences (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'persons, versions, tombstones and trash (partner sharing phase 1)',
    statements: [
      // People. The device owner has is_self = 1. A partner name typed on this device is a
      // placeholder (is_placeholder = 1) that phase 2 replaces with the partner's own entry.
      `CREATE TABLE persons (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        is_self INTEGER NOT NULL DEFAULT 0 CHECK (is_self IN (0, 1)),
        is_placeholder INTEGER NOT NULL DEFAULT 0 CHECK (is_placeholder IN (0, 1)),
        version TEXT NOT NULL,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX idx_persons_self ON persons (is_self) WHERE is_self = 1`,
      // Versions (hybrid logical clock), authors and tombstones on every shared table.
      `ALTER TABLE relationship_profile ADD COLUMN version TEXT NOT NULL DEFAULT '0000000000000-000000-00000000'`,
      `ALTER TABLE relationship_profile ADD COLUMN author_person_id TEXT`,
      `ALTER TABLE milestones ADD COLUMN version TEXT NOT NULL DEFAULT '0000000000000-000000-00000000'`,
      `ALTER TABLE milestones ADD COLUMN author_person_id TEXT`,
      `ALTER TABLE milestones ADD COLUMN deleted_at TEXT`,
      `ALTER TABLE memories ADD COLUMN version TEXT NOT NULL DEFAULT '0000000000000-000000-00000000'`,
      `ALTER TABLE memories ADD COLUMN author_person_id TEXT`,
      `ALTER TABLE memories ADD COLUMN deleted_at TEXT`,
      // Set when a memory went to the trash together with its date, so restoring the date restores it.
      `ALTER TABLE memories ADD COLUMN trashed_with TEXT`,
      `ALTER TABLE memory_media ADD COLUMN version TEXT NOT NULL DEFAULT '0000000000000-000000-00000000'`,
      `ALTER TABLE memory_media ADD COLUMN deleted_at TEXT`,
      `CREATE INDEX idx_milestones_deleted ON milestones (deleted_at)`,
      `CREATE INDEX idx_memories_deleted ON memories (deleted_at)`,
      // Local clock state, sync membership (empty until sharing is turned on) and the outbox.
      `CREATE TABLE hlc_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        node TEXT NOT NULL,
        last TEXT NOT NULL
      )`,
      `CREATE TABLE sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        space_id TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 1,
        cursor INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_type TEXT NOT NULL CHECK (record_type IN ('profile', 'person', 'milestone', 'memory', 'memory_media')),
        record_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (record_type, record_id)
      )`,
      // Existing data: the owner becomes a person; a typed partner name becomes a placeholder.
      `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
       SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), NULL, 1, 0, '0000000000000-000000-00000000', created_at, updated_at FROM relationship_profile`,
      `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
       SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), display_name, 0, 1, '0000000000000-000000-00000000', created_at, updated_at
       FROM relationship_profile WHERE display_name IS NOT NULL`,
      `UPDATE relationship_profile SET display_name = NULL`,
      `UPDATE relationship_profile SET author_person_id = (SELECT id FROM persons WHERE is_self = 1)`,
      `UPDATE milestones SET author_person_id = (SELECT id FROM persons WHERE is_self = 1)`,
      `UPDATE memories SET author_person_id = (SELECT id FROM persons WHERE is_self = 1)`,
    ],
  },
  {
    version: 3,
    name: 'sync capability (partner sharing phase 2)',
    statements: [
      // Which record types, payload format and rules this device could accept when it last
      // pulled. When an update raises it, the device pulls everything once more, so records
      // an older version had to refuse are not lost.
      `ALTER TABLE sync_state ADD COLUMN capability INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    version: 4,
    name: 'verified device list (partner sharing phase 3)',
    statements: [
      // The devices of the shared space and their public keys, as written by each device
      // itself inside the end-to-end encrypted space (docs/PARTNER_SYNC.md §7.2). Key
      // rotation seals new keys only to devices listed here, never to keys from the server.
      `CREATE TABLE space_devices (
        id TEXT PRIMARY KEY,
        person_id TEXT,
        sign_public_key TEXT NOT NULL,
        box_public_key TEXT NOT NULL,
        platform TEXT NOT NULL,
        revoked_at TEXT,
        version TEXT NOT NULL,
        author_person_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // SQLite cannot change a CHECK constraint: rebuild the outbox to accept 'device'.
      `CREATE TABLE outbox_v4 (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_type TEXT NOT NULL CHECK (record_type IN ('profile', 'person', 'milestone', 'memory', 'memory_media', 'device')),
        record_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (record_type, record_id)
      )`,
      `INSERT INTO outbox_v4 (seq, record_type, record_id, version, created_at)
       SELECT seq, record_type, record_id, version, created_at FROM outbox`,
      `DROP TABLE outbox`,
      `ALTER TABLE outbox_v4 RENAME TO outbox`,
    ],
  },
  {
    version: 5,
    name: 'recovery keys (partner sharing phase 4)',
    statements: [
      // Each person's recovery public key, from their own end-to-end encrypted record
      // (docs/PARTNER_SYNC.md §8). Rotations seal every new key to it.
      `CREATE TABLE space_recovery (
        id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        version TEXT NOT NULL,
        author_person_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The outbox no longer checks record types: the sync schema decides what syncs, and
      // each new type would otherwise need another table rebuild.
      `CREATE TABLE outbox_v5 (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (record_type, record_id)
      )`,
      `INSERT INTO outbox_v5 (seq, record_type, record_id, version, created_at)
       SELECT seq, record_type, record_id, version, created_at FROM outbox`,
      `DROP TABLE outbox`,
      `ALTER TABLE outbox_v5 RENAME TO outbox`,
    ],
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class MigrationError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    readonly causeMessage: string,
  ) {
    super(`Migration ${version} (${migrationName}) failed: ${causeMessage}`);
    this.name = 'MigrationError';
  }
}

export class DatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`Database schema ${found} is newer than supported schema ${supported}`);
    this.name = 'DatabaseTooNewError';
  }
}

export interface MigrationResult {
  from: number;
  to: number;
}

export async function currentSchemaVersion(driver: SqlDriver): Promise<number> {
  const rows = await driver.query<{ version: number | null }>(
    'SELECT MAX(version) AS version FROM schema_migrations',
  );
  return rows[0]?.version ?? 0;
}

/**
 * Brings the database to the latest schema. A failing migration is rolled back in full
 * and reported; data is never wiped as a recovery strategy.
 */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): Promise<MigrationResult> {
  await driver.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`,
  );
  const from = await currentSchemaVersion(driver);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (from > latest) throw new DatabaseTooNewError(from, latest);

  for (const migration of migrations) {
    if (migration.version <= from) continue;
    try {
      await driver.transaction(async (tx) => {
        for (const statement of migration.statements) await tx.run(statement);
        await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
          migration.version,
          migration.name,
          now(),
        ]);
      });
    } catch (error) {
      throw new MigrationError(
        migration.version,
        migration.name,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return { from, to: Math.max(from, latest) };
}
