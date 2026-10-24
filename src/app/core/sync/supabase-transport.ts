import type { SupabaseClient } from '@supabase/supabase-js';

import type { Hlc } from '../domain/hlc';
import type { SyncedRecordType } from '../domain/sync-schema';
import { fromBytea, toBytea } from './encoding';
import {
  recordKey,
  type PulledRecord,
  type SyncTransport,
  type WireRecord,
} from './sync-transport';

/** A failed request. Carries only the operation and the server's code, never record data. */
export class SyncTransportError extends Error {
  constructor(
    readonly operation: 'push' | 'versions' | 'pull',
    readonly code: string,
  ) {
    super(`Sync ${operation} failed (${code})`);
    this.name = 'SyncTransportError';
  }
}

interface RecordRow {
  record_type: SyncedRecordType;
  record_id: string;
  epoch: number;
  version: Hlc;
  deleted: boolean;
  nonce: string;
  ciphertext: string;
  seq: number;
}

/** Keeps request URLs short (record IDs go in the query string). */
const VERSIONS_CHUNK = 50;

/**
 * The `records` table through PostgREST, under row-level security. The server keeps the
 * newest version and numbers accepted writes itself (supabase/migrations).
 */
export class SupabaseTransport implements SyncTransport {
  constructor(private readonly client: SupabaseClient) {}

  async push(spaceId: string, records: readonly WireRecord[]): Promise<void> {
    if (records.length === 0) return;
    const rows = records.map((r) => ({
      space_id: spaceId,
      record_type: r.recordType,
      record_id: r.recordId,
      epoch: r.epoch,
      version: r.version,
      deleted: r.deleted,
      nonce: toBytea(r.nonce),
      ciphertext: toBytea(r.ciphertext),
    }));
    const { error } = await this.client
      .from('records')
      .upsert(rows, { onConflict: 'space_id,record_type,record_id' });
    if (error) throw new SyncTransportError('push', serverCode(error));
  }

  async versions(
    spaceId: string,
    keys: readonly { recordType: string; recordId: string }[],
  ): Promise<Map<string, Hlc>> {
    const wanted = new Set(keys.map((k) => recordKey(k.recordType, k.recordId)));
    const ids = [...new Set(keys.map((k) => k.recordId))];
    const result = new Map<string, Hlc>();
    for (let i = 0; i < ids.length; i += VERSIONS_CHUNK) {
      const { data, error } = await this.client
        .from('records')
        .select('record_type,record_id,version')
        .eq('space_id', spaceId)
        .in('record_id', ids.slice(i, i + VERSIONS_CHUNK));
      if (error) throw new SyncTransportError('versions', serverCode(error));
      for (const row of (data ?? []) as Pick<
        RecordRow,
        'record_type' | 'record_id' | 'version'
      >[]) {
        const key = recordKey(row.record_type, row.record_id);
        if (wanted.has(key)) result.set(key, row.version);
      }
    }
    return result;
  }

  async pull(spaceId: string, after: number, limit: number): Promise<PulledRecord[]> {
    const { data, error } = await this.client
      .from('records')
      .select('record_type,record_id,epoch,version,deleted,nonce,ciphertext,seq')
      .eq('space_id', spaceId)
      .gt('seq', after)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw new SyncTransportError('pull', serverCode(error));
    return ((data ?? []) as RecordRow[]).map((row) => ({
      recordType: row.record_type,
      recordId: row.record_id,
      epoch: row.epoch,
      version: row.version,
      deleted: row.deleted,
      // A malformed value fails decryption, so the engine rejects that record alone.
      nonce: bytesOrEmpty(row.nonce),
      ciphertext: bytesOrEmpty(row.ciphertext),
      seq: Number(row.seq),
    }));
  }
}

function bytesOrEmpty(value: unknown): Uint8Array {
  try {
    return fromBytea(value);
  } catch {
    return new Uint8Array(0);
  }
}

/** The server's limits (§19) by name; otherwise its error code. Never the message itself. */
function serverCode(error: { code?: string; message?: string }): string {
  const message = error.message ?? '';
  if (/rate limited/.test(message)) return 'rateLimited';
  if (/space full|record too large/.test(message)) return 'spaceFull';
  return error.code ?? 'unknown';
}
