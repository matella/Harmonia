import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';

import { SerialQueue, type SqlDriver, type SqlExecutor, type SqlRow, type SqlValue } from './sql-driver';

/**
 * Native SQLite on iOS/Android via @capacitor-community/sqlite. The database file lives
 * in the app sandbox (Library/CapacitorDatabase on iOS, app databases dir on Android).
 */
export class CapacitorSqliteDriver implements SqlDriver {
  private readonly queue = new SerialQueue();

  private constructor(
    private readonly sqlite: SQLiteConnection,
    private readonly db: SQLiteDBConnection,
    private readonly name: string,
  ) {}

  static async open(name: string): Promise<CapacitorSqliteDriver> {
    const sqlite = new SQLiteConnection(CapacitorSQLite);
    const consistent = (await sqlite.checkConnectionsConsistency()).result;
    const exists = (await sqlite.isConnection(name, false)).result;
    const db =
      consistent && exists
        ? await sqlite.retrieveConnection(name, false)
        : await sqlite.createConnection(name, false, 'no-encryption', 1, false);
    await db.open();
    await db.execute('PRAGMA foreign_keys = ON;', false);
    return new CapacitorSqliteDriver(sqlite, db, name);
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    return this.queue.run(() => this.runRaw(sql, params));
  }

  query<T extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.queue.run(() => this.queryRaw<T>(sql, params));
  }

  transaction<T>(work: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const tx: SqlExecutor = {
        run: (sql, params = []) => this.runRaw(sql, params),
        query: <R extends SqlRow = SqlRow>(sql: string, params: readonly SqlValue[] = []) =>
          this.queryRaw<R>(sql, params),
      };
      await this.db.beginTransaction();
      try {
        const result = await work(tx);
        await this.db.commitTransaction();
        return result;
      } catch (error) {
        await this.db.rollbackTransaction();
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    await this.queue.run(async () => {
      await this.db.close();
      await this.sqlite.closeConnection(this.name, false);
    });
  }

  private async runRaw(sql: string, params: readonly SqlValue[]): Promise<void> {
    // transaction=false: transactions are managed explicitly by transaction().
    await this.db.run(sql, [...params], false);
  }

  private async queryRaw<T>(sql: string, params: readonly SqlValue[]): Promise<T[]> {
    const result = await this.db.query(sql, [...params]);
    // The iOS implementation may prepend a column-description row.
    return ((result.values ?? []) as Record<string, unknown>[]).filter((row) => !('ios_columns' in row)) as T[];
  }
}
