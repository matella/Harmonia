import type { Clock } from '../domain/clock';
import type { LeapDayPolicy, Milestone, MilestoneCategory, Recurrence, ReminderRule } from '../domain/models';
import { TOGETHER_NOTIFICATION_ID_BASE } from '../domain/reminder-planner';
import type { ReminderDraft, ValidMilestone } from '../domain/validation';
import { ChangeJournal } from './change-journal';
import type { IdFactory } from './ids';
import type { SqlDriver, SqlExecutor, SqlRow } from './sql-driver';
import { photoReplaced } from './purge';

interface MilestoneRow extends SqlRow {
  id: string;
  title: string;
  category: string;
  event_date: string;
  event_time: string | null;
  event_time_zone_id: string | null;
  recurrence_rule: string;
  leap_day_policy: string | null;
  note: string | null;
  photo_path: string | null;
  is_pinned: number;
  created_at: string;
  updated_at: string;
}

interface RuleRow extends SqlRow {
  id: string;
  milestone_id: string;
  offset_days: number;
  local_time: string;
  is_enabled: number;
  include_event_title: number;
  notification_id: number;
  created_at: string;
  updated_at: string;
}

function toMilestone(row: MilestoneRow): Milestone {
  return {
    id: row.id,
    title: row.title,
    category: row.category as MilestoneCategory,
    eventDate: row.event_date,
    eventTime: row.event_time,
    eventTimeZoneId: row.event_time_zone_id,
    recurrence: row.recurrence_rule as Recurrence,
    leapDayPolicy: row.leap_day_policy as LeapDayPolicy | null,
    note: row.note,
    photoPath: row.photo_path,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRule(row: RuleRow): ReminderRule {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    offsetDays: row.offset_days,
    localTime: row.local_time,
    isEnabled: row.is_enabled === 1,
    includeEventTitle: row.include_event_title === 1,
    notificationId: row.notification_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** First notification ID handed out; IDs are never reused. */
const FIRST_NOTIFICATION_ID = 1000;

export interface MilestoneDeletion {
  /**
   * App-private media files that can be removed now. Always empty since the trash: files
   * are kept until the item is restored or purged.
   */
  orphanedFiles: string[];
}

export class MilestoneRepository {
  constructor(
    private readonly db: SqlDriver,
    private readonly clock: Clock,
    private readonly newId: IdFactory,
    private readonly journal: ChangeJournal = new ChangeJournal(clock),
  ) {}

  /** Active milestones (not in the trash). */
  async list(): Promise<Milestone[]> {
    const rows = await this.db.query<MilestoneRow>(
      'SELECT * FROM milestones WHERE deleted_at IS NULL ORDER BY event_date, created_at, id',
    );
    return rows.map(toMilestone);
  }

  async get(id: string): Promise<Milestone | null> {
    const rows = await this.db.query<MilestoneRow>('SELECT * FROM milestones WHERE id = ? AND deleted_at IS NULL', [id]);
    return rows[0] ? toMilestone(rows[0]) : null;
  }

  /**
   * Rules of active milestones. Rules of a trashed milestone are kept (with their
   * notification IDs) so restoring it brings the same reminders back.
   */
  async listRules(): Promise<ReminderRule[]> {
    const rows = await this.db.query<RuleRow>(
      `SELECT r.* FROM reminder_rules r JOIN milestones m ON m.id = r.milestone_id
       WHERE m.deleted_at IS NULL ORDER BY r.milestone_id, r.offset_days DESC`,
    );
    return rows.map(toRule);
  }

  async rulesFor(milestoneId: string): Promise<ReminderRule[]> {
    const rows = await this.db.query<RuleRow>(
      'SELECT * FROM reminder_rules WHERE milestone_id = ? ORDER BY offset_days DESC',
      [milestoneId],
    );
    return rows.map(toRule);
  }

  async create(input: ValidMilestone, photoPath: string | null = null): Promise<Milestone> {
    const id = this.newId();
    const now = this.clock.now().toString();
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      await tx.run(
        `INSERT INTO milestones
          (id, title, category, event_date, event_time, event_time_zone_id, recurrence_rule,
           leap_day_policy, note, photo_path, is_pinned, created_at, updated_at, version, author_person_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.title,
          input.category,
          input.eventDate,
          input.eventTime,
          input.recurrence,
          input.leapDayPolicy,
          input.note,
          photoPath,
          input.isPinned ? 1 : 0,
          now,
          now,
          version,
          await this.journal.selfPersonId(tx),
        ],
      );
      await this.syncRules(tx, id, input.reminders, now);
      await this.journal.changed(tx, 'milestone', id, version);
    });
    return (await this.get(id))!;
  }

  /**
   * Updates fields and reminder rules. Rules whose offset is unchanged keep their ID and
   * notification ID, so rescheduling replaces the pending OS request instead of adding one.
   * `photoPath` undefined keeps the current photo.
   */
  async update(id: string, input: ValidMilestone, photoPath?: string | null): Promise<Milestone> {
    const now = this.clock.now().toString();
    await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ photo_path: string | null }>(
        'SELECT photo_path FROM milestones WHERE id = ? AND deleted_at IS NULL',
        [id],
      );
      if (existing.length === 0) throw new Error('Milestone not found');
      const nextPhoto = photoPath === undefined ? existing[0].photo_path : photoPath;
      if (nextPhoto !== existing[0].photo_path) await photoReplaced(tx, 'milestone', id, now);
      const version = await this.journal.stamp(tx);
      await tx.run(
        `UPDATE milestones SET title = ?, category = ?, event_date = ?, event_time = ?,
           recurrence_rule = ?, leap_day_policy = ?, note = ?, photo_path = ?, is_pinned = ?, updated_at = ?,
           version = ?, author_person_id = ?
         WHERE id = ?`,
        [
          input.title,
          input.category,
          input.eventDate,
          input.eventTime,
          input.recurrence,
          input.leapDayPolicy,
          input.note,
          nextPhoto,
          input.isPinned ? 1 : 0,
          now,
          version,
          await this.journal.selfPersonId(tx),
          id,
        ],
      );
      await this.syncRules(tx, id, input.reminders, now);
      await this.journal.changed(tx, 'milestone', id, version);
    });
    return (await this.get(id))!;
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.db.transaction(async (tx) => {
      const version = await this.journal.stamp(tx);
      await tx.run(
        'UPDATE milestones SET is_pinned = ?, updated_at = ?, version = ?, author_person_id = ? WHERE id = ? AND deleted_at IS NULL',
        [pinned ? 1 : 0, this.clock.now().toString(), version, await this.journal.selfPersonId(tx), id],
      );
      await this.journal.changed(tx, 'milestone', id, version);
    });
  }

  async countLinkedMemories(id: string): Promise<number> {
    const rows = await this.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM memories WHERE milestone_id = ? AND deleted_at IS NULL',
      [id],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Moves a milestone to the trash (30 days). Its reminder rules stay but no longer apply.
   * Linked memories either stay (and show as unlinked until the date is restored) or go
   * to the trash with it, as the user chose. Nothing is removed from disk here.
   */
  async delete(id: string, options: { deleteLinkedMemories: boolean }): Promise<MilestoneDeletion> {
    return this.db.transaction(async (tx) => {
      const now = this.clock.now().toString();
      const found = await tx.query<{ id: string }>('SELECT id FROM milestones WHERE id = ? AND deleted_at IS NULL', [id]);
      if (found.length === 0) return { orphanedFiles: [] };
      if (options.deleteLinkedMemories) {
        const linked = await tx.query<{ id: string }>(
          'SELECT id FROM memories WHERE milestone_id = ? AND deleted_at IS NULL',
          [id],
        );
        for (const memory of linked) {
          const version = await this.journal.stamp(tx);
          await tx.run('UPDATE memories SET deleted_at = ?, trashed_with = ?, version = ?, updated_at = ? WHERE id = ?', [
            now,
            id,
            version,
            now,
            memory.id,
          ]);
          await this.journal.changed(tx, 'memory', memory.id, version);
        }
      }
      const version = await this.journal.stamp(tx);
      await tx.run('UPDATE milestones SET deleted_at = ?, version = ?, updated_at = ? WHERE id = ?', [now, version, now, id]);
      await this.journal.changed(tx, 'milestone', id, version);
      return { orphanedFiles: [] };
    });
  }

  private async syncRules(tx: SqlExecutor, milestoneId: string, drafts: readonly ReminderDraft[], now: string): Promise<void> {
    const existing = (
      await tx.query<RuleRow>('SELECT * FROM reminder_rules WHERE milestone_id = ?', [milestoneId])
    ).map(toRule);
    const byOffset = new Map(existing.map((r) => [r.offsetDays, r]));
    const wanted = new Set(drafts.map((d) => d.offsetDays));

    for (const rule of existing) {
      if (!wanted.has(rule.offsetDays)) await tx.run('DELETE FROM reminder_rules WHERE id = ?', [rule.id]);
    }
    for (const draft of drafts) {
      const current = byOffset.get(draft.offsetDays);
      if (current) {
        await tx.run(
          `UPDATE reminder_rules SET local_time = ?, is_enabled = 1, include_event_title = ?, updated_at = ?
           WHERE id = ?`,
          [draft.localTime, draft.includeEventTitle ? 1 : 0, now, current.id],
        );
      } else {
        await tx.run(
          `INSERT INTO reminder_rules
            (id, milestone_id, offset_days, local_time, is_enabled, include_event_title, notification_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [
            this.newId(),
            milestoneId,
            draft.offsetDays,
            draft.localTime,
            draft.includeEventTitle ? 1 : 0,
            await nextNotificationId(tx),
            now,
            now,
          ],
        );
      }
    }
  }
}

/** Monotonic 32-bit notification IDs, persisted so deleted IDs are never reissued. */
async function nextNotificationId(tx: SqlExecutor): Promise<number> {
  const rows = await tx.query<{ value: number }>("SELECT value FROM id_sequences WHERE name = 'notification'");
  const next = rows[0] ? rows[0].value + 1 : FIRST_NOTIFICATION_ID;
  // IDs from TOGETHER_NOTIFICATION_ID_BASE on are reserved for derived reminders.
  if (next >= TOGETHER_NOTIFICATION_ID_BASE) throw new Error('Notification ID space exhausted');
  await tx.run(
    `INSERT INTO id_sequences (name, value) VALUES ('notification', ?)
     ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
    [next],
  );
  return next;
}
