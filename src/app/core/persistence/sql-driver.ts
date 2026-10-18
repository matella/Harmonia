export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlExecutor {
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  query<T extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
}

/**
 * Minimal storage boundary used by repositories and migrations. Implementations:
 * Capacitor SQLite on iOS/Android, sql.js for the browser preview and Node tests.
 * Swapping the persistence library only requires a new implementation of this.
 */
export interface SqlDriver extends SqlExecutor {
  /** Runs all statements in `work` atomically; rolls back if it throws. */
  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Serializes asynchronous operations so a transaction never interleaves with other
 * statements on the same connection.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
