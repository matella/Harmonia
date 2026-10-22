import type { Clock } from '../domain/clock';
import { newHlcNode, observeHlc, tickHlc, type Hlc } from '../domain/hlc';
import type { SyncedRecordType } from '../domain/sync-schema';
import type { SqlExecutor } from './sql-driver';

/**
 * Every write to a shared table goes through here (docs/PARTNER_SYNC.md §5):
 *  - `stamp` issues the next hybrid-logical-clock version, persisted in `hlc_state`, so
 *    versions keep increasing across restarts and when the device clock goes backwards;
 *  - `changed` queues the record in the outbox — only once sharing is on (a `sync_state`
 *    row exists), so solo users never accumulate anything;
 *  - `selfPersonId` is the author of local changes.
 */
export class ChangeJournal {
  constructor(
    private readonly clock: Clock,
    private readonly newNode: () => string = newHlcNode,
  ) {}

  async stamp(tx: SqlExecutor): Promise<Hlc> {
    const rows = await tx.query<{ node: string; last: string }>(
      'SELECT node, last FROM hlc_state WHERE id = 1',
    );
    const node = rows[0]?.node ?? this.newNode();
    const next = tickHlc(rows[0]?.last ?? null, this.clock.now().epochMilliseconds, node);
    await tx.run(
      `INSERT INTO hlc_state (id, node, last) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last = excluded.last`,
      [node, next],
    );
    return next;
  }

  /**
   * Folds a version received from another device into the local clock, so the next
   * local change is ordered after it. Used when applying remote records (no outbox).
   */
  async observe(tx: SqlExecutor, remote: Hlc): Promise<void> {
    const rows = await tx.query<{ node: string; last: string }>(
      'SELECT node, last FROM hlc_state WHERE id = 1',
    );
    const node = rows[0]?.node ?? this.newNode();
    const next = observeHlc(
      rows[0]?.last ?? null,
      remote,
      this.clock.now().epochMilliseconds,
      node,
    );
    await tx.run(
      `INSERT INTO hlc_state (id, node, last) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET last = excluded.last`,
      [node, next],
    );
  }

  async changed(tx: SqlExecutor, type: SyncedRecordType, id: string, version: Hlc): Promise<void> {
    const sharing = await tx.query<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state');
    if ((sharing[0]?.n ?? 0) === 0) return;
    await tx.run(
      `INSERT INTO outbox (record_type, record_id, version, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (record_type, record_id) DO UPDATE SET version = excluded.version, created_at = excluded.created_at`,
      [type, id, version, this.clock.now().toString()],
    );
  }

  async selfPersonId(tx: SqlExecutor): Promise<string | null> {
    const rows = await tx.query<{ id: string }>('SELECT id FROM persons WHERE is_self = 1');
    return rows[0]?.id ?? null;
  }
}
