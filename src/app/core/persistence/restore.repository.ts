import type { Clock } from '../domain/clock';
import type { RestorePlan } from '../domain/restore-plan';
import { ChangeJournal } from './change-journal';
import type { StoredMediaFile } from './memory.repository';
import { nextNotificationId } from './milestone.repository';
import { isValidSetting } from './settings.repository';
import type { IdFactory } from './ids';
import type { SqlDriver, SqlExecutor } from './sql-driver';

/** The app already holds data, or shares a space: a restore never mixes with it. */
export class RestoreNotEmptyError extends Error {
  constructor() {
    super('Restore needs an empty app');
  }
}

/**
 * Writes a restore plan into an empty database in one transaction (all or nothing).
 * Records keep their IDs, so memories stay linked to their dates. Names become this
 * device's own person and a placeholder partner, as after onboarding.
 */
export class RestoreRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly newId: IdFactory,
    private readonly journal: ChangeJournal = new ChangeJournal(clock),
  ) {}

  /** True when nothing is saved yet and sharing is off (trashed items count as data). */
  async isEmpty(executor: SqlExecutor = this.db): Promise<boolean> {
    const rows = await executor.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM relationship_profile) + (SELECT COUNT(*) FROM milestones)
            + (SELECT COUNT(*) FROM memories) + (SELECT COUNT(*) FROM sync_state) AS n`,
    );
    return (rows[0]?.n ?? 0) === 0;
  }

  /** `photos` maps archive paths to the files stored for them; a missing one is left out. */
  async restore(plan: RestorePlan, photos: ReadonlyMap<string, StoredMediaFile>): Promise<void> {
    const now = this.clock.now().toString();
    const fileOf = (path: string | null) => (path ? (photos.get(path)?.filePath ?? null) : null);
    await this.db.transaction(async (tx) => {
      if (!(await this.isEmpty(tx))) throw new RestoreNotEmptyError();
      const { profile } = plan;

      const selfId = this.newId();
      await this.insertPerson(tx, selfId, profile.selfName, true, now);
      if (profile.displayName !== null)
        await this.insertPerson(tx, this.newId(), profile.displayName, false, now);

      let version = await this.journal.stamp(tx);
      await tx.run(
        `INSERT INTO relationship_profile
          (id, display_name, relationship_label, start_date, start_time, start_time_zone_id,
           calendar_time_zone_id, photo_path, created_at, updated_at, version, author_person_id)
         VALUES (1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          profile.relationshipLabel,
          profile.startDate,
          profile.startTime,
          profile.startTimeZoneId,
          profile.calendarTimeZoneId,
          fileOf(plan.profilePhoto),
          plan.profileCreatedAt,
          now,
          version,
          selfId,
        ],
      );
      await this.journal.changed(tx, 'profile', '1', version);

      for (const m of plan.milestones) {
        const v = m.value;
        version = await this.journal.stamp(tx);
        await tx.run(
          `INSERT INTO milestones
            (id, title, category, event_date, event_time, event_time_zone_id, recurrence_rule,
             leap_day_policy, note, photo_path, is_pinned, created_at, updated_at, version, author_person_id)
           VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            v.title,
            v.category,
            v.eventDate,
            v.eventTime,
            v.recurrence,
            v.leapDayPolicy,
            v.note,
            fileOf(m.photo),
            v.isPinned ? 1 : 0,
            m.createdAt,
            m.updatedAt,
            version,
            selfId,
          ],
        );
        for (const reminder of v.reminders) {
          // New notification IDs: this phone has its own pending requests.
          await tx.run(
            `INSERT INTO reminder_rules
              (id, milestone_id, offset_days, local_time, is_enabled, include_event_title, notification_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
            [
              this.newId(),
              m.id,
              reminder.offsetDays,
              reminder.localTime,
              reminder.includeEventTitle ? 1 : 0,
              await nextNotificationId(tx),
              now,
              now,
            ],
          );
        }
        await this.journal.changed(tx, 'milestone', m.id, version);
      }

      for (const m of plan.memories) {
        const v = m.value;
        version = await this.journal.stamp(tx);
        await tx.run(
          `INSERT INTO memories (id, milestone_id, title, body, memory_date, created_at, updated_at, version, author_person_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.id,
            v.milestoneId,
            v.title,
            v.body,
            v.memoryDate,
            m.createdAt,
            m.updatedAt,
            version,
            selfId,
          ],
        );
        await this.journal.changed(tx, 'memory', m.id, version);
        let order = 0;
        for (const path of m.photos) {
          const file = photos.get(path);
          if (!file) continue;
          const id = this.newId();
          const mediaVersion = await this.journal.stamp(tx);
          await tx.run(
            `INSERT INTO memory_media (id, memory_id, file_path, thumbnail_path, sort_order, created_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, m.id, file.filePath, file.thumbnailPath, order++, now, mediaVersion],
          );
          await this.journal.changed(tx, 'memory_media', id, mediaVersion);
        }
      }

      for (const [key, value] of Object.entries({ ...plan.settings, lastBackupAt: now })) {
        if (!isValidSetting(key, value)) continue; // unknown or damaged: the default stays
        await tx.run(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, JSON.stringify(value), now],
        );
      }
    });
  }

  private async insertPerson(
    tx: SqlExecutor,
    id: string,
    name: string | null,
    isSelf: boolean,
    now: string,
  ): Promise<void> {
    const version = await this.journal.stamp(tx);
    await tx.run(
      `INSERT INTO persons (id, display_name, is_self, is_placeholder, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, name, isSelf ? 1 : 0, isSelf ? 0 : 1, version, now, now],
    );
    await this.journal.changed(tx, 'person', id, version);
  }
}
