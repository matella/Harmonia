/**
 * Which local columns are shared with a partner space and which never leave this device
 * (docs/PARTNER_SYNC.md §5). Phase 2's sync code serialises only `shared` columns; a test
 * checks that every column of every synced table is classified here, so a new column
 * cannot slip into sync by accident.
 */
export type SyncedRecordType = 'profile' | 'person' | 'milestone' | 'memory' | 'memory_media';

export interface TableSyncSchema {
  table: string;
  /** Sent (encrypted) to the space. */
  shared: readonly string[];
  /** Kept on this device: zones, file paths, local bookkeeping. */
  local: readonly string[];
  /** Sync metadata stored beside the record rather than inside its ciphertext. */
  meta: readonly string[];
}

export const SYNC_SCHEMA: Readonly<Record<SyncedRecordType, TableSyncSchema>> = {
  profile: {
    table: 'relationship_profile',
    shared: ['relationship_label', 'start_date', 'start_time', 'start_time_zone_id'],
    // calendar_time_zone_id: long-distance couples have different "todays".
    // display_name: superseded by persons (always NULL since schema v2).
    local: ['id', 'display_name', 'calendar_time_zone_id', 'photo_path', 'created_at', 'updated_at'],
    meta: ['version', 'author_person_id'],
  },
  person: {
    table: 'persons',
    shared: ['id', 'display_name'],
    local: ['is_self', 'is_placeholder', 'created_at', 'updated_at'],
    meta: ['version', 'deleted_at'],
  },
  milestone: {
    table: 'milestones',
    shared: ['id', 'title', 'category', 'event_date', 'event_time', 'event_time_zone_id', 'recurrence_rule', 'leap_day_policy', 'note', 'is_pinned'],
    // photo_path is a local file; the photo itself syncs as an encrypted blob.
    local: ['photo_path', 'created_at', 'updated_at'],
    meta: ['version', 'author_person_id', 'deleted_at'],
  },
  memory: {
    table: 'memories',
    shared: ['id', 'milestone_id', 'title', 'body', 'memory_date', 'trashed_with'],
    local: ['created_at', 'updated_at'],
    meta: ['version', 'author_person_id', 'deleted_at'],
  },
  memory_media: {
    table: 'memory_media',
    shared: ['id', 'memory_id', 'sort_order'],
    local: ['file_path', 'thumbnail_path', 'created_at'],
    meta: ['version', 'deleted_at'],
  },
};

/** Never synced at all: reminder rules (notification IDs are device-local), settings, clock and sync state. */
export const LOCAL_ONLY_TABLES = ['reminder_rules', 'app_settings', 'id_sequences', 'hlc_state', 'sync_state', 'outbox', 'schema_migrations'] as const;
