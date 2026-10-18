import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

import { SerialQueue, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue } from './sql-driver';

export interface SqlJsDriverOptions {
  /** Previously persisted database bytes, if any. */
  initialBytes?: Uint8Array | null;
  /** Resolves the sql.js wasm file (browser only; Node finds it automatically). */
  locateFile?: (file: string) => string;
  /** Called with the full database image after every committed write. */
  persist?: (bytes: Uint8Array) => Promise<void>;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * SQLite compiled to WebAssembly. Used for the browser preview (persisted to IndexedDB)
 * and for Node tests, so repository and migration tests exercise real SQL semantics.
 */
export class SqlJsDriver implements SqlDriver {
  private readonly queue = new SerialQueue();

  private constructor(
    private readonly db: Database,
    private readonly persistFn: ((bytes: Uint8Array) => Promise<void>) | undefined,
  ) {}

  static async open(options: SqlJsDriverOptions = {}): Promise<SqlJsDriver> {
    sqlJsPromise ??= initSqlJs(options.locateFile ? { locateFile: options.locateFile } : undefined);
    const SQL = await sqlJsPromise;
    const db = options.initialBytes ? new SQL.Database(options.initialBytes) : new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    return new SqlJsDriver(db, options.persist);
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    return this.queue.run(async () => {
      this.db.run(sql, params as SqlValue[]);
      await this.persist();
    });
  }

  query<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.queue.run(async () => this.select<T>(sql, params));
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const tx: SqlExecutor = {
        run: async (sql, params = []) => {
          this.db.run(sql, params as SqlValue[]);
        },
        query: async <R extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) =>
          this.select<R>(sql, params),
      };
      this.db.run('BEGIN IMMEDIATE;');
      try {
        const result = await work(tx);
        this.db.run('COMMIT;');
        await this.persist();
        return result;
      } catch (error) {
        this.db.run('ROLLBACK;');
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.queue.run(async () => this.db.close());
  }

  /** The raw database image (used by tests to simulate a cold start). */
  exportBytes(): Uint8Array {
    const bytes = this.db.export();
    // export() reopens the database, which resets connection pragmas.
    this.db.run('PRAGMA foreign_keys = ON;');
    return bytes;
  }

  private select<T>(sql: string, params: readonly SqlValue[]): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params as SqlValue[]);
      const rows: T[] = [];
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  private async persist(): Promise<void> {
    if (!this.persistFn) return;
    await this.persistFn(this.exportBytes());
  }
}
