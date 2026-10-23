import { compareHlc, HLC_PATTERN, isTooFarAhead } from '../domain/hlc';
import { SYNC_SCHEMA, type SyncedRecordType } from '../domain/sync-schema';
import type { SqlValue } from '../persistence/sql-driver';
import type { SyncCrypto } from './sync-crypto-port';
import { isAcceptablePayload } from './sync-payload-rules';
import {
  PHASE2_TYPES,
  PROFILE_RECORD_ID,
  type LocalDefaults,
  type LocalRecord,
  type SyncStore,
} from './sync-store';
import {
  recordKey,
  type PulledRecord,
  type SyncTransport,
  type WireRecord,
} from './sync-transport';

/** Space keys by epoch. Revoking a device starts a new epoch (docs/PARTNER_SYNC.md §6). */
export interface SpaceKeyring {
  currentEpoch(): number;
  key(epoch: number): Uint8Array | null;
}

export interface SyncReport {
  /** Remote records applied locally. */
  applied: number;
  /** Local changes the server accepted. */
  pushed: number;
  /** Local changes the server skipped because a newer version was already there. */
  superseded: number;
  /** Remote records that failed to decrypt or validate; never applied. */
  rejected: number;
  /** Local records the server cannot store (an ID that is not a UUID); kept on this device. */
  unsendable: number;
  /**
   * True when pulling stopped at a record more than a day ahead of this device's clock.
   * It and everything after it wait until the clocks agree; nothing is skipped.
   */
  deferred: boolean;
  /** Record types that changed locally, so the app can reload and reconcile side effects. */
  changedTypes: SyncedRecordType[];
}

export interface SyncEngineOptions {
  pageSize?: number;
  /**
   * How many already-seen change numbers to read again on each pull. The server numbers
   * a write when it happens but it becomes visible when its transaction commits, so a
   * slow transaction can appear behind the cursor. Re-reading costs only no-op applies.
   */
  cursorOverlap?: number;
  /** Record types this build applies. Overridable so tests can play an older build. */
  acceptedTypes?: readonly SyncedRecordType[];
  /** Overridable for the same reason; see `SYNC_CAPABILITY`. */
  capability?: number;
}

const PAYLOAD_FORMAT = 1;

/** The server's `records.record_id` is a uuid. */
const SERVER_RECORD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Raise this whenever a build starts accepting records an older one refused: a new record
 * type, a new payload format, a new category or a longer limit. Devices whose stored
 * capability is lower pull everything once more, so refused records arrive after the
 * update instead of staying behind the cursor for good.
 */
export const SYNC_CAPABILITY = 2; // 2: device records (phase 3)

/**
 * Pull, push, pull (docs/PARTNER_SYNC.md §5). Framework-free: the app wires it to the
 * Supabase transport and runs it on start, on resume and after local changes.
 *
 * Conflicts (v1): last writer wins per record, by HLC version — the server keeps the
 * newest and the losing device drops its pending change when the winner arrives.
 */
export class SyncEngine {
  private readonly pageSize: number;
  private readonly overlap: number;
  private readonly acceptedTypes: readonly SyncedRecordType[];
  private readonly capability: number;

  constructor(
    private readonly store: SyncStore,
    private readonly transport: SyncTransport,
    private readonly crypto: SyncCrypto,
    private readonly keyring: SpaceKeyring,
    private readonly defaults: () => LocalDefaults,
    options: SyncEngineOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 200;
    this.overlap = options.cursorOverlap ?? 50;
    this.acceptedTypes = options.acceptedTypes ?? PHASE2_TYPES;
    this.capability = options.capability ?? SYNC_CAPABILITY;
  }

  /**
   * `pullOnly` with `adoptProfile` is the joiner's first step (§6.2): take the space's
   * profile whatever its version, before anything of this device is uploaded.
   */
  async sync(options: { pullOnly?: boolean; adoptProfile?: boolean } = {}): Promise<SyncReport> {
    const state = await this.store.state();
    if (!state) throw new Error('Sharing is not set up on this device.');
    if (state.capability < this.capability) await this.store.restartPull(this.capability);
    const report: SyncReport = {
      applied: 0,
      pushed: 0,
      superseded: 0,
      rejected: 0,
      unsendable: 0,
      deferred: false,
      changedTypes: [],
    };
    const changed = new Set<SyncedRecordType>();

    await this.pull(state.spaceId, report, changed, options.adoptProfile ?? false);
    if (!options.pullOnly) {
      await this.push(state.spaceId, report);
      await this.pull(state.spaceId, report, changed, false);
    }

    report.changedTypes = PHASE2_TYPES.filter((t) => changed.has(t));
    return report;
  }

  private async pull(
    spaceId: string,
    report: SyncReport,
    changed: Set<SyncedRecordType>,
    adoptProfile: boolean,
  ): Promise<void> {
    const state = await this.store.state();
    const seen = state?.cursor ?? 0;
    let cursor = seen;
    let after = Math.max(0, cursor - this.overlap);
    for (;;) {
      const page = await this.transport.pull(spaceId, after, this.pageSize);
      for (const wire of page) {
        if (HLC_PATTERN.test(wire.version) && isTooFarAhead(wire.version, this.store.nowMs())) {
          // Stop before it so nothing is skipped; it is applied once the clocks agree.
          report.deferred = true;
          await this.store.setCursor(cursor);
          return;
        }
        // Re-read records (the overlap) were already counted when first seen.
        const reject = () => {
          if (wire.seq > seen) report.rejected++;
        };
        const record = this.open(spaceId, wire);
        if (!record) {
          reject();
        } else {
          try {
            const force = adoptProfile && record.type === 'profile';
            if (await this.store.apply(record, this.defaults(), { force })) {
              report.applied++;
              changed.add(record.type);
            }
          } catch {
            // A record the local schema refuses (e.g. a constraint) must not stall sync.
            reject();
          }
        }
        after = wire.seq;
        cursor = Math.max(cursor, wire.seq);
      }
      await this.store.setCursor(cursor);
      if (page.length < this.pageSize) return;
    }
  }

  private async push(spaceId: string, report: SyncReport): Promise<void> {
    const epoch = this.keyring.currentEpoch();
    const key = this.keyring.key(epoch);
    if (!key) throw new Error('No space key for the current epoch.');

    const entries = await this.store.outbox();
    for (let i = 0; i < entries.length; i += this.pageSize) {
      const batch: { record: LocalRecord; wire: WireRecord }[] = [];
      for (const entry of entries.slice(i, i + this.pageSize)) {
        const record = await this.store.read(entry.type, entry.id);
        if (!record) {
          // Purged for good before it was sent; nothing left to share.
          await this.store.acknowledge(entry);
          continue;
        }
        if (!SERVER_RECORD_ID.test(record.id) || !HLC_PATTERN.test(record.version)) {
          // The server would refuse the whole batch for one such record; keep it local.
          await this.store.acknowledge(entry);
          report.unsendable++;
          continue;
        }
        batch.push({ record, wire: this.seal(spaceId, epoch, key, record) });
      }
      if (batch.length === 0) continue;

      await this.transport.push(
        spaceId,
        batch.map((b) => b.wire),
      );
      // The server skips stale writes silently, so confirm what it now holds.
      const stored = await this.transport.versions(
        spaceId,
        batch.map((b) => ({ recordType: b.wire.recordType, recordId: b.wire.recordId })),
      );
      for (const { record, wire } of batch) {
        const server = stored.get(recordKey(wire.recordType, wire.recordId));
        const local = { type: record.type, id: localOutboxId(record), version: record.version };
        if (server === record.version) {
          await this.store.acknowledge(local);
          report.pushed++;
        } else if (server !== undefined && compareHlc(server, record.version) > 0) {
          // Lost to a newer change; the next pull applies it and clears this entry.
          report.superseded++;
        }
        // Otherwise the write did not land: the entry stays for the next sync.
      }
    }
  }

  private seal(spaceId: string, epoch: number, key: Uint8Array, record: LocalRecord): WireRecord {
    const address = {
      spaceId,
      recordType: record.type,
      recordId: record.id,
      epoch,
      version: record.version,
      deleted: record.deleted,
    };
    const plaintext = JSON.stringify({ format: PAYLOAD_FORMAT, data: record.payload });
    const sealed = this.crypto.encryptRecord(key, address, plaintext);
    return {
      recordType: record.type,
      recordId: record.id,
      epoch,
      version: record.version,
      deleted: record.deleted,
      ...sealed,
    };
  }

  /** Decrypts and validates a pulled record; null if anything about it is wrong. */
  private open(spaceId: string, wire: PulledRecord): LocalRecord | null {
    if (!this.acceptedTypes.includes(wire.recordType)) return null;
    if (!HLC_PATTERN.test(wire.version)) return null;
    if (wire.recordType === 'profile' && wire.recordId !== PROFILE_RECORD_ID) return null;
    const key = this.keyring.key(wire.epoch);
    if (!key) return null;

    let parsed: unknown;
    try {
      const address = {
        spaceId,
        recordType: wire.recordType,
        recordId: wire.recordId,
        epoch: wire.epoch,
        version: wire.version,
        deleted: wire.deleted,
      };
      parsed = JSON.parse(this.crypto.decryptRecord(key, address, wire));
    } catch {
      return null;
    }
    const payload = validPayload(wire.recordType, parsed);
    if (!payload || !isAcceptablePayload(wire.recordType, payload)) return null;
    const hasTombstone = SYNC_SCHEMA[wire.recordType].meta.includes('deleted_at');
    if (hasTombstone && (payload['deleted_at'] !== null) !== wire.deleted) return null;
    if (!hasTombstone && wire.deleted) return null;
    return {
      type: wire.recordType,
      id: wire.recordId,
      version: wire.version,
      deleted: wire.deleted,
      payload,
    };
  }
}

/** The outbox stores the profile under its local id. */
function localOutboxId(record: LocalRecord): string {
  return record.type === 'profile' ? '1' : record.id;
}

/** Exactly the shared columns for the type, each a plain SQL value. */
function validPayload(type: SyncedRecordType, parsed: unknown): Record<string, SqlValue> | null {
  if (!isObject(parsed) || parsed['format'] !== PAYLOAD_FORMAT || !isObject(parsed['data']))
    return null;
  const data = parsed['data'];
  const schema = SYNC_SCHEMA[type];
  const allowed = new Set([
    ...schema.shared.filter((c) => c !== 'id'),
    ...schema.meta.filter((c) => c === 'author_person_id' || c === 'deleted_at'),
  ]);
  const keys = Object.keys(data);
  if (keys.length !== allowed.size || keys.some((k) => !allowed.has(k))) return null;
  const payload: Record<string, SqlValue> = {};
  for (const k of keys) {
    const value = data[k];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') return null;
    payload[k] = value;
  }
  return payload;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
