import type { Clock } from '../domain/clock';
import { compareHlc, ZERO_HLC, type Hlc } from '../domain/hlc';
import { SYNC_SCHEMA, type SyncedRecordType } from '../domain/sync-schema';
import type { ChangeJournal } from '../persistence/change-journal';
import type { SqlDriver, SqlExecutor, SqlValue } from '../persistence/sql-driver';

/**
 * The local side of sync (docs/PARTNER_SYNC.md §5): turns rows into payloads made of
 * shared columns only, applies records received from the space, and manages the outbox.
 *
 * Conflict rule (v1): last writer wins per record, by HLC version. A delete is a record
 * whose tombstone flag is set; trashing and restoring are ordinary versioned writes.
 */

/** Record types synced so far; memories and photos follow in phase 5. */
export const PHASE2_TYPES: readonly SyncedRecordType[] = [
  'profile',
  'person',
  'milestone',
  'device',
  'recovery',
];

/** A device of the space and its public keys (base64), from the end-to-end device list. */
export interface SpaceDevice {
  id: string;
  personId: string | null;
  signPublicKey: string;
  boxPublicKey: string;
  platform: string;
  revokedAt: string | null;
}

/** The profile is one row per space; on the server it needs a UUID. */
export const PROFILE_RECORD_ID = '00000000-0000-4000-8000-000000000001';

export interface LocalRecord {
  type: SyncedRecordType;
  id: string;
  version: Hlc;
  deleted: boolean;
  /** Shared columns plus the author and deletion time — never local-only columns. */
  payload: Record<string, SqlValue>;
}

export interface SyncState {
  spaceId: string;
  epoch: number;
  cursor: number;
  /** What this device could accept when it last restarted pulling (see `SYNC_CAPABILITY`). */
  capability: number;
}

/** A received record that must not be applied to this device. */
export class RefusedRecordError extends Error {
  constructor(reason: string) {
    super(`Refused remote record: ${reason}`);
    this.name = 'RefusedRecordError';
  }
}

export interface StartOfRelationship {
  startDate: string;
  startTime: string | null;
  startTimeZoneId: string | null;
}

export interface OutboxEntry {
  type: SyncedRecordType;
  id: string;
  version: Hlc;
}

/** Local defaults for columns that never sync, used when a record first arrives. */
export interface LocalDefaults {
  calendarTimeZoneId: string;
}

const localId = (type: SyncedRecordType, id: string) => (type === 'profile' ? '1' : id);
const remoteId = (type: SyncedRecordType, id: string) =>
  type === 'profile' ? PROFILE_RECORD_ID : id;

function payloadColumns(type: SyncedRecordType): string[] {
  const schema = SYNC_SCHEMA[type];
  const extra = schema.meta.filter((c) => c === 'author_person_id' || c === 'deleted_at');
  return [...schema.shared.filter((c) => c !== 'id'), ...extra];
}

export class SyncStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly journal: ChangeJournal,
  ) {}

  /**
   * Makes this device a member of a space and queues everything it already has for upload
   * (the joiner's data is merged in, §6.2), in one transaction so a crash cannot leave
   * existing records out of the outbox. From now on local writes enter the outbox.
   */
  async joinSpace(
    spaceId: string,
    epoch: number,
    options: { queueProfile?: boolean } = {},
  ): Promise<void> {
    const queueProfile = options.queueProfile ?? true;
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO sync_state (id, space_id, epoch, cursor, created_at) VALUES (1, ?, ?, 0, ?)
         ON CONFLICT (id) DO UPDATE SET space_id = excluded.space_id, epoch = excluded.epoch`,
        [spaceId, epoch, this.clock.now().toString()],
      );
      for (const type of PHASE2_TYPES) {
        // A joiner adopts the space's profile first (§6.2), so its own is not queued.
        if (type === 'profile' && !queueProfile) continue;
        const table = SYNC_SCHEMA[type].table;
        const rows = await tx.query<{ id: string | number; version: string }>(
          `SELECT id, version FROM ${table}`,
        );
        for (const row of rows) await this.journal.changed(tx, type, String(row.id), row.version);
      }
    });
  }

  /** This device's clock, for checks on received versions. */
  nowMs(): number {
    return this.clock.now().epochMilliseconds;
  }

  async state(): Promise<SyncState | null> {
    const rows = await this.db.query<{
      space_id: string;
      epoch: number;
      cursor: number;
      capability: number;
    }>('SELECT space_id, epoch, cursor, capability FROM sync_state WHERE id = 1');
    const row = rows[0];
    return row
      ? { spaceId: row.space_id, epoch: row.epoch, cursor: row.cursor, capability: row.capability }
      : null;
  }

  /** Moves to a newer epoch after a rotation (never back). */
  async setEpoch(epoch: number): Promise<void> {
    await this.db.run('UPDATE sync_state SET epoch = ? WHERE id = 1 AND epoch < ?', [epoch, epoch]);
  }

  /** Marks a device removed in the device list (§7.4), queued for the space. */
  async markDeviceRemoved(deviceId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      const now = this.clock.now().toString();
      const open = await tx.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM space_devices WHERE id = ? AND revoked_at IS NULL',
        [deviceId],
      );
      if ((open[0]?.n ?? 0) === 0) return; // already removed (or unknown): nothing to send
      await tx.run(
        'UPDATE space_devices SET revoked_at = ?, version = ?, updated_at = ? WHERE id = ?',
        [now, version, now, deviceId],
      );
      await this.journal.changed(tx, 'device', deviceId, version);
    });
  }

  /** Moves the cursor forward (never back). */
  async setCursor(cursor: number): Promise<void> {
    await this.db.run('UPDATE sync_state SET cursor = ? WHERE id = 1 AND cursor < ?', [
      cursor,
      cursor,
    ]);
  }

  /** After an update that accepts more: pull everything again once (unchanged records are no-ops). */
  async restartPull(capability: number): Promise<void> {
    await this.db.run('UPDATE sync_state SET cursor = 0, capability = ? WHERE id = 1', [
      capability,
    ]);
  }

  async outbox(): Promise<OutboxEntry[]> {
    const placeholders = PHASE2_TYPES.map(() => '?').join(', ');
    const rows = await this.db.query<{
      record_type: SyncedRecordType;
      record_id: string;
      version: string;
    }>(
      `SELECT record_type, record_id, version FROM outbox WHERE record_type IN (${placeholders}) ORDER BY seq`,
      [...PHASE2_TYPES],
    );
    return rows.map((r) => ({ type: r.record_type, id: r.record_id, version: r.version }));
  }

  /** Removes an entry only if the record did not change again while it was being pushed. */
  async acknowledge(entry: OutboxEntry): Promise<void> {
    await this.db.run(
      'DELETE FROM outbox WHERE record_type = ? AND record_id = ? AND version = ?',
      [entry.type, entry.id, entry.version],
    );
  }

  /**
   * The record as it would be sent: shared columns only. Null if there is nothing to share:
   * it no longer exists, or it is a placeholder partner typed on this device, which the
   * partner's own person replaces when they join (§16).
   */
  async read(type: SyncedRecordType, id: string): Promise<LocalRecord | null> {
    const columns = payloadColumns(type);
    const table = SYNC_SCHEMA[type].table;
    const extra = type === 'person' ? ', is_placeholder' : '';
    const rows = await this.db.query<Record<string, SqlValue>>(
      `SELECT version${extra}, ${columns.join(', ')} FROM ${table} WHERE id = ?`,
      [localId(type, id)],
    );
    const row = rows[0];
    if (!row || row['is_placeholder'] === 1) return null;
    const payload: Record<string, SqlValue> = {};
    for (const column of columns) payload[column] = row[column] ?? null;
    return {
      type,
      id: remoteId(type, id),
      version: String(row['version']),
      deleted: 'deleted_at' in payload ? payload['deleted_at'] !== null : false,
      payload,
    };
  }

  /**
   * The partner's own person has arrived: a name typed for them on this device was only a
   * stand-in (§6.2: each person's own name wins). Placeholders were never uploaded.
   */
  private async dropPlaceholders(tx: SqlExecutor): Promise<void> {
    await tx.run(
      `DELETE FROM outbox WHERE record_type = 'person'
         AND record_id IN (SELECT id FROM persons WHERE is_placeholder = 1)`,
    );
    await tx.run('DELETE FROM persons WHERE is_placeholder = 1');
  }

  /**
   * Writes this device's own record into the device list (§7.2), only if it is missing or
   * out of date. Never over a removal: a device marked removed does not restore itself.
   * Returns whether a new version was queued.
   */
  async writeOwnDevice(device: Omit<SpaceDevice, 'revokedAt'>): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query<{
        person_id: string | null;
        sign_public_key: string;
        box_public_key: string;
        platform: string;
        revoked_at: string | null;
      }>(
        'SELECT person_id, sign_public_key, box_public_key, platform, revoked_at FROM space_devices WHERE id = ?',
        [device.id],
      );
      const current = rows[0];
      if (current?.revoked_at) return false;
      if (
        current &&
        current.person_id === device.personId &&
        current.sign_public_key === device.signPublicKey &&
        current.box_public_key === device.boxPublicKey &&
        current.platform === device.platform
      ) {
        return false;
      }
      const version = await this.journal.stamp(tx);
      const author = await this.journal.selfPersonId(tx);
      const now = this.clock.now().toString();
      await tx.run(
        `INSERT INTO space_devices
           (id, person_id, sign_public_key, box_public_key, platform, revoked_at, version, author_person_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           person_id = excluded.person_id,
           sign_public_key = excluded.sign_public_key,
           box_public_key = excluded.box_public_key,
           platform = excluded.platform,
           version = excluded.version,
           author_person_id = excluded.author_person_id,
           updated_at = excluded.updated_at`,
        [
          device.id,
          device.personId,
          device.signPublicKey,
          device.boxPublicKey,
          device.platform,
          version,
          author,
          now,
          now,
        ],
      );
      await this.journal.changed(tx, 'device', device.id, version);
      return true;
    });
  }

  /**
   * A device added as one of an existing person's devices becomes that person (§7.6): its
   * own onboarding person is replaced by a local row for the space's person, kept as this
   * device's owner, and everything it authored is re-attributed. The space's version of
   * the person (name) arrives with the next pull and wins, because this row starts at the
   * oldest version. Returns false when this device already is that person.
   */
  async becomePerson(personId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const self = (
        await tx.query<{ id: string; display_name: string | null }>(
          'SELECT id, display_name FROM persons WHERE is_self = 1',
        )
      )[0];
      if (self?.id === personId) return false;
      const now = this.clock.now().toString();
      if (self) await tx.run('UPDATE persons SET is_self = 0 WHERE id = ?', [self.id]);
      await tx.run(
        `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
         VALUES (?, ?, 1, 0, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET is_self = 1, is_placeholder = 0`,
        [personId, self?.display_name ?? null, ZERO_HLC, now, now],
      );
      if (self) {
        for (const table of ['relationship_profile', 'milestones', 'memories']) {
          await tx.run(`UPDATE ${table} SET author_person_id = ? WHERE author_person_id = ?`, [
            personId,
            self.id,
          ]);
        }
        await tx.run(`DELETE FROM outbox WHERE record_type = 'person' AND record_id = ?`, [
          self.id,
        ]);
        await tx.run('DELETE FROM persons WHERE id = ?', [self.id]);
      }
      return true;
    });
  }

  /** Writes a person's recovery public key (base64) when it is set up or replaced (§8). */
  async writeRecovery(personId: string, publicKey: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      const author = await this.journal.selfPersonId(tx);
      const now = this.clock.now().toString();
      await tx.run(
        `INSERT INTO space_recovery (id, public_key, version, author_person_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET public_key = excluded.public_key, version = excluded.version,
           author_person_id = excluded.author_person_id, updated_at = excluded.updated_at`,
        [personId, publicKey, version, author, now, now],
      );
      await this.journal.changed(tx, 'recovery', personId, version);
    });
  }

  /** Every person's recovery public key (base64), by person. */
  async recoveryKeys(): Promise<Map<string, string>> {
    const rows = await this.db.query<{ id: string; public_key: string }>(
      'SELECT id, public_key FROM space_recovery',
    );
    return new Map(rows.map((r) => [r.id, r.public_key]));
  }

  /** The device list of the space, as received end to end. */
  async devices(): Promise<SpaceDevice[]> {
    const rows = await this.db.query<{
      id: string;
      person_id: string | null;
      sign_public_key: string;
      box_public_key: string;
      platform: string;
      revoked_at: string | null;
    }>(
      'SELECT id, person_id, sign_public_key, box_public_key, platform, revoked_at FROM space_devices ORDER BY created_at, id',
    );
    return rows.map((r) => ({
      id: r.id,
      personId: r.person_id,
      signPublicKey: r.sign_public_key,
      boxPublicKey: r.box_public_key,
      platform: r.platform,
      revokedAt: r.revoked_at,
    }));
  }

  /** The shared start of the relationship as stored here. */
  async startOfRelationship(): Promise<StartOfRelationship | null> {
    const rows = await this.db.query<{
      start_date: string;
      start_time: string | null;
      start_time_zone_id: string | null;
    }>('SELECT start_date, start_time, start_time_zone_id FROM relationship_profile WHERE id = 1');
    const row = rows[0];
    return row
      ? {
          startDate: row.start_date,
          startTime: row.start_time,
          startTimeZoneId: row.start_time_zone_id,
        }
      : null;
  }

  /**
   * The joiner keeps their own start (§6.2): written with a fresh version so it wins on
   * every device, and queued for upload. The label and other fields stay the space's.
   */
  async restampStart(start: StartOfRelationship): Promise<void> {
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      const author = await this.journal.selfPersonId(tx);
      await tx.run(
        `UPDATE relationship_profile
           SET start_date = ?, start_time = ?, start_time_zone_id = ?, version = ?, author_person_id = ?, updated_at = ?
         WHERE id = 1`,
        [
          start.startDate,
          start.startTime,
          start.startTimeZoneId,
          version,
          author,
          this.clock.now().toString(),
        ],
      );
      await this.journal.changed(tx, 'profile', '1', version);
    });
  }

  /**
   * Turns this device back into a solo device: sharing state and the outbox go, every
   * record stays (§6.5). Also the way out when the space key is gone.
   *
   * The other people become placeholders: they still show here ("You and Sam"), but as
   * names typed on this device, so sharing later with someone else never uploads them and
   * the next partner's own name replaces them.
   */
  async leaveLocally(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM outbox');
      await tx.run('DELETE FROM sync_state');
      await tx.run('DELETE FROM space_devices');
      await tx.run('DELETE FROM space_recovery');
      await tx.run('UPDATE persons SET is_placeholder = 1 WHERE is_self = 0');
    });
  }

  /**
   * Applies a record received from the space if it is newer than the local copy. It does
   * not enter the outbox (no echo) and advances the local clock past it.
   * Returns whether anything changed.
   */
  async apply(
    record: LocalRecord,
    defaults: LocalDefaults,
    options: { force?: boolean } = {},
  ): Promise<boolean> {
    if (!PHASE2_TYPES.includes(record.type)) return false;
    return this.db.transaction(async (tx) => {
      const changed = await this.applyIn(tx, record, defaults, options.force ?? false);
      // Unchanged means the local copy is at least as new: the clock is already past it.
      if (changed) await this.journal.observe(tx, record.version);
      return changed;
    });
  }

  private async applyIn(
    tx: SqlExecutor,
    record: LocalRecord,
    defaults: LocalDefaults,
    force: boolean,
  ): Promise<boolean> {
    const schema = SYNC_SCHEMA[record.type];
    const id = localId(record.type, record.id);
    const current = await tx.query<{ version: string }>(
      `SELECT version FROM ${schema.table} WHERE id = ?`,
      [id],
    );
    if (current[0] && !force && compareHlc(current[0].version, record.version) >= 0) return false;
    if (current[0] && force && current[0].version === record.version) return false;
    if (record.type === 'person' && record.payload['deleted_at'] !== null) {
      // Nobody can delete this device's owner; doing so would also break saving the profile.
      const self = await tx.query<{ n: number }>(
        'SELECT COUNT(*) AS n FROM persons WHERE id = ? AND is_self = 1',
        [id],
      );
      if ((self[0]?.n ?? 0) > 0) throw new RefusedRecordError('tombstone for this device owner');
    }
    if (record.type === 'device' && current[0]) {
      // A device's keys never change, and a removal is permanent, whatever the version.
      const known = (
        await tx.query<{
          sign_public_key: string;
          box_public_key: string;
          person_id: string | null;
          revoked_at: string | null;
        }>(
          'SELECT sign_public_key, box_public_key, person_id, revoked_at FROM space_devices WHERE id = ?',
          [id],
        )
      )[0];
      if (
        known &&
        (known.sign_public_key !== record.payload['sign_public_key'] ||
          known.box_public_key !== record.payload['box_public_key'])
      ) {
        throw new RefusedRecordError('changed keys for a known device');
      }
      if (known?.person_id && known.person_id !== record.payload['person_id']) {
        throw new RefusedRecordError('moved a known device to another person');
      }
      if (known?.revoked_at && record.payload['revoked_at'] === null) {
        throw new RefusedRecordError('undoing a device removal');
      }
    }

    const columns = payloadColumns(record.type);
    const values = columns.map((c) => record.payload[c] ?? null);
    const now = this.clock.now().toString();
    if (current[0]) {
      const sets = columns.map((c) => `${c} = ?`).join(', ');
      await tx.run(`UPDATE ${schema.table} SET ${sets}, version = ?, updated_at = ? WHERE id = ?`, [
        ...values,
        record.version,
        now,
        id,
      ]);
    } else {
      const extra = this.insertDefaults(record.type, defaults, now);
      const allColumns = ['id', ...columns, 'version', ...Object.keys(extra)];
      await tx.run(
        `INSERT INTO ${schema.table} (${allColumns.join(', ')}) VALUES (${allColumns.map(() => '?').join(', ')})`,
        [id, ...values, record.version, ...Object.values(extra)],
      );
      if (record.type === 'person') await this.dropPlaceholders(tx);
    }
    // A pending local change to the same record lost to a newer remote one (or was replaced).
    await tx.run(
      `DELETE FROM outbox WHERE record_type = ? AND record_id = ? AND ${force ? '1 = 1' : 'version < ?'}`,
      force ? [record.type, id] : [record.type, id, record.version],
    );
    return true;
  }

  /** Values for local-only NOT NULL columns when a record is created from the space. */
  private insertDefaults(
    type: SyncedRecordType,
    defaults: LocalDefaults,
    now: string,
  ): Record<string, SqlValue> {
    switch (type) {
      case 'profile':
        return {
          calendar_time_zone_id: defaults.calendarTimeZoneId,
          created_at: now,
          updated_at: now,
        };
      case 'person':
        return { is_self: 0, is_placeholder: 0, created_at: now, updated_at: now };
      default:
        return { created_at: now, updated_at: now };
    }
  }
}
