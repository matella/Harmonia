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
  const rows = await driver.query<{ version: number | null }>('SELECT MAX(version) AS version FROM schema_migrations');
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
      throw new MigrationError(migration.version, migration.name, error instanceof Error ? error.message : String(error));
    }
  }
  return { from, to: Math.max(from, latest) };
}
