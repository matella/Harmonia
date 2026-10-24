/**
 * Which local columns are shared with a partner space and which never leave this device
 * (docs/PARTNER_SYNC.md §5). Phase 2's sync code serialises only `shared` columns; a test
 * checks that every column of every synced table is classified here, so a new column
 * cannot slip into sync by accident.
 */
export type SyncedRecordType =
  'profile' | 'person' | 'milestone' | 'memory' | 'memory_media' | 'device' | 'recovery' | 'purge';

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
    shared: [
      'relationship_label',
      'start_date',
      'start_time',
      'start_time_zone_id',
      'blob_id',
      'blob_key',
      'blob_header',
      'blob_size',
    ],
    // calendar_time_zone_id: long-distance couples have different "todays".
    // display_name: superseded by persons (always NULL since schema v2).
    local: [
      'id',
      'display_name',
      'calendar_time_zone_id',
      'photo_path',
      'blob_state',
      'download_attempts',
      'created_at',
      'updated_at',
    ],
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
    shared: [
      'id',
      'title',
      'category',
      'event_date',
      'event_time',
      'event_time_zone_id',
      'recurrence_rule',
      'leap_day_policy',
      'note',
      'is_pinned',
      'blob_id',
      'blob_key',
      'blob_header',
      'blob_size',
    ],
    // photo_path is this device's copy; the photo itself travels as an encrypted blob (§18).
    local: ['photo_path', 'blob_state', 'download_attempts', 'created_at', 'updated_at'],
    meta: ['version', 'author_person_id', 'deleted_at'],
  },
  memory: {
    table: 'memories',
    shared: ['id', 'milestone_id', 'title', 'body', 'memory_date', 'trashed_with'],
    local: ['created_at', 'updated_at'],
    meta: ['version', 'author_person_id', 'deleted_at'],
  },
  // A photo of a memory. The photo itself is an encrypted blob on the server (§3); its
  // ID, file key, stream header and plaintext size travel inside this encrypted record.
  // `blob_state`: 'local' (only on this device), 'uploaded', 'remote' (still to download).
  memory_media: {
    table: 'memory_media',
    shared: ['id', 'memory_id', 'sort_order', 'blob_id', 'blob_key', 'blob_header', 'blob_size'],
    local: ['file_path', 'thumbnail_path', 'blob_state', 'download_attempts', 'created_at'],
    meta: ['version', 'deleted_at'],
  },
  // Each device's own record of its public keys (PARTNER_SYNC §7.2). Removal is the
  // shared `revoked_at`, not a tombstone: a removed device stays known as removed.
  // A person's recovery public key (§8), keyed by the person. Written only when the key is
  // set up or replaced, never by name edits.
  recovery: {
    table: 'space_recovery',
    shared: ['id', 'public_key'],
    local: ['created_at', 'updated_at'],
    meta: ['version', 'author_person_id'],
  },
  // Deleted for good (PARTNER_SYNC §18): content-free, keyed by the item's ID.
  purge: {
    table: 'purges',
    shared: ['id', 'record_type'],
    local: ['created_at'],
    meta: ['version'],
  },
  device: {
    table: 'space_devices',
    shared: ['id', 'person_id', 'sign_public_key', 'box_public_key', 'platform', 'revoked_at'],
    local: ['created_at', 'updated_at'],
    meta: ['version', 'author_person_id'],
  },
};

/** Never synced at all: reminder rules (notification IDs are device-local), settings, clock and sync state. */
export const LOCAL_ONLY_TABLES = [
  'reminder_rules',
  'app_settings',
  'id_sequences',
  'hlc_state',
  'sync_state',
  'outbox',
  'schema_migrations',
  'blob_releases',
] as const;
