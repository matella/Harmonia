import type { SqlDriver } from './sql-driver';

/** Whole-database operations: complete local erasure. */
export class DataRepository {
  constructor(private readonly db: SqlDriver) {}

  /**
   * Deletes every user record and setting in one transaction. The schema and the
   * notification ID sequence are kept so IDs are never reissued to stale OS requests.
   */
  async deleteAll(): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM memory_media');
      await tx.run('DELETE FROM memories');
      await tx.run('DELETE FROM reminder_rules');
      await tx.run('DELETE FROM milestones');
      await tx.run('DELETE FROM relationship_profile');
      await tx.run('DELETE FROM app_settings');
    });
  }
}
