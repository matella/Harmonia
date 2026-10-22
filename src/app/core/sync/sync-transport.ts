import { HLC_PATTERN, type Hlc } from '../domain/hlc';
import type { SyncedRecordType } from '../domain/sync-schema';

/** One encrypted record as the server stores it (supabase `records`, docs/PARTNER_SYNC.md §4). */
export interface WireRecord {
  recordType: SyncedRecordType;
  recordId: string;
  epoch: number;
  version: Hlc;
  deleted: boolean;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

export interface PulledRecord extends WireRecord {
  /** Server-assigned change cursor; increases on every accepted write. */
  seq: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const recordKey = (type: string, id: string) => `${type}:${id}`;

/**
 * What the sync engine needs from the server. The Supabase implementation comes with
 * registration (phase 2, slice 2); tests use the in-memory one below.
 */
export interface SyncTransport {
  /**
   * Upserts records. Like the server's `records_keep_newest` trigger, a write whose
   * version is not newer than the stored one is skipped without an error.
   */
  push(spaceId: string, records: readonly WireRecord[]): Promise<void>;
  /** Stored versions for these records, keyed by `recordKey`; absent records are missing. */
  versions(
    spaceId: string,
    keys: readonly { recordType: string; recordId: string }[],
  ): Promise<Map<string, Hlc>>;
  /** Records with `seq > after`, in seq order, at most `limit`. */
  pull(spaceId: string, after: number, limit: number): Promise<PulledRecord[]>;
}

/** Mimics the server's records table and triggers, for tests and the browser preview. */
export class InMemoryTransport implements SyncTransport {
  private readonly rows = new Map<string, PulledRecord>();
  private seq = 0;
  /** Records written but not yet visible, to simulate transactions committing out of order. */
  private readonly hidden = new Set<number>();

  async push(spaceId: string, records: readonly WireRecord[]): Promise<void> {
    // Like PostgREST, one row the table refuses fails the whole request.
    if (records.some((r) => !UUID.test(r.recordId) || !HLC_PATTERN.test(r.version))) {
      throw new Error('push refused: invalid record');
    }
    for (const record of records) this.write(spaceId, record);
  }

  /** Writes a record that stays invisible to pulls until `commit(seq)`; returns its seq. */
  writeUncommitted(spaceId: string, record: WireRecord): number {
    const seq = this.write(spaceId, record);
    if (seq !== null) this.hidden.add(seq);
    return seq ?? -1;
  }

  commit(seq: number): void {
    this.hidden.delete(seq);
  }

  async versions(
    spaceId: string,
    keys: readonly { recordType: string; recordId: string }[],
  ): Promise<Map<string, Hlc>> {
    const result = new Map<string, Hlc>();
    for (const key of keys) {
      const row = this.rows.get(this.key(spaceId, key.recordType, key.recordId));
      if (row && !this.hidden.has(row.seq))
        result.set(recordKey(key.recordType, key.recordId), row.version);
    }
    return result;
  }

  async pull(spaceId: string, after: number, limit: number): Promise<PulledRecord[]> {
    return [...this.rows.entries()]
      .filter(
        ([key, row]) =>
          key.startsWith(`${spaceId}/`) && row.seq > after && !this.hidden.has(row.seq),
      )
      .map(([, row]) => ({ ...row }))
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  /** Every stored record, for assertions (the server only ever sees ciphertext). */
  all(): PulledRecord[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  private write(spaceId: string, record: WireRecord): number | null {
    const key = this.key(spaceId, record.recordType, record.recordId);
    const existing = this.rows.get(key);
    if (existing && record.version <= existing.version) return null;
    const seq = ++this.seq;
    this.rows.set(key, { ...record, seq });
    return seq;
  }

  private key(spaceId: string, type: string, id: string) {
    return `${spaceId}/${type}:${id}`;
  }
}
