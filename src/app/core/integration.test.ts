/**
 * End-to-end data flow without Angular: real SQLite (sql.js) repositories feeding the
 * reminder planner/reconciler and the widget snapshot builder, exactly as the app's
 * services compose them (persist → reload → reconcile → snapshot).
 */
import { describe, expect, it } from 'vitest';

import { FakeNotificationPort } from '../../testing/fake-notification-port';
import { translator } from '../../testing/fixtures';
import { MutableClock } from './domain/clock';
import { buildExportDocument, parseExportDocument } from './domain/export-format';
import { planReminders } from './domain/reminder-planner';
import { reconcileReminders } from './domain/reminder-reconciler';
import type { ValidMilestone } from './domain/validation';
import { buildWidgetSnapshot } from './domain/widget-snapshot';
import { createReminderCopy } from './i18n/reminder-copy';
import { DataRepository } from './persistence/data.repository';
import { newId } from './persistence/ids';
import { MemoryRepository } from './persistence/memory.repository';
import { MilestoneRepository } from './persistence/milestone.repository';
import { migrate } from './persistence/migrations';
import { RelationshipRepository } from './persistence/relationship.repository';
import { SettingsRepository } from './persistence/settings.repository';
import { SqlJsDriver } from './persistence/sqljs-driver';

const copy = createReminderCopy(translator);

async function app(bytes?: Uint8Array) {
  const driver = await SqlJsDriver.open({ initialBytes: bytes });
  await migrate(driver);
  const clock = new MutableClock('2026-10-18T08:00:00Z', 'Europe/Brussels');
  const repos = {
    profile: new RelationshipRepository(driver, clock),
    milestones: new MilestoneRepository(driver, clock, newId),
    memories: new MemoryRepository(driver, clock, newId),
    settings: new SettingsRepository(driver, clock),
    data: new DataRepository(driver),
  };
  const port = new FakeNotificationPort();

  /** What SyncService does after every write. */
  async function sync() {
    const [profile, milestones, rules, settings] = await Promise.all([
      repos.profile.get(),
      repos.milestones.list(),
      repos.milestones.listRules(),
      repos.settings.load(),
    ]);
    const plan = planReminders({ milestones, rules, settings, now: clock.now(), deviceTimeZoneId: clock.timeZoneId(), copy });
    const report = await reconcileReminders(port, plan);
    const snapshot = buildWidgetSnapshot({ profile, milestones, settings, clock });
    return { report, snapshot };
  }

  return { driver, clock, repos, port, sync };
}

const anniversary = (overrides: Partial<ValidMilestone> = {}): ValidMilestone => ({
  title: 'Our anniversary',
  category: 'anniversary',
  eventDate: '2024-06-14',
  eventTime: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: 'Dinner by the river',
  isPinned: false,
  remindersEnabled: true,
  reminders: [{ offsetDays: 1, localTime: '09:00', includeEventTitle: false }],
  ...overrides,
});

const profile = {
  displayName: 'Sam',
  relationshipLabel: null,
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
};

describe('app data flow', () => {
  it('schedules, reschedules and cancels reminders as milestones change', async () => {
    const { repos, port, sync } = await app();
    await repos.profile.save(profile);

    const m = await repos.milestones.create(anniversary());
    await sync();
    expect(port.pending.size).toBe(1);
    const [first] = port.pending.values();
    expect(first.occurrenceDate).toBe('2027-06-14');
    expect(first.body).toBe('A special date is tomorrow.');

    // Edit: move the date, add an on-the-day reminder, reveal the title.
    await repos.milestones.update(
      m.id,
      anniversary({
        eventDate: '2024-11-02',
        reminders: [
          { offsetDays: 1, localTime: '09:00', includeEventTitle: true },
          { offsetDays: 0, localTime: '18:00', includeEventTitle: true },
        ],
      }),
    );
    await sync();
    expect(port.pending.size).toBe(2);
    expect([...port.pending.values()].map((n) => n.occurrenceDate)).toEqual(['2026-11-02', '2026-11-02']);
    expect([...port.pending.values()].map((n) => n.body).sort()).toEqual([
      'Our anniversary is today.',
      'Our anniversary is tomorrow.',
    ]);

    // Turning reminders off for the date removes its notifications.
    await repos.milestones.update(m.id, anniversary({ eventDate: '2024-11-02', remindersEnabled: false, reminders: [] }));
    await sync();
    expect(port.pending.size).toBe(0);

    // Deleting a milestone with reminders cancels them.
    const other = await repos.milestones.create(anniversary({ title: 'Wedding', category: 'wedding' }));
    await sync();
    expect(port.pending.size).toBe(1);
    await repos.milestones.delete(other.id, { deleteLinkedMemories: false });
    await sync();
    expect(port.pending.size).toBe(0);
  });

  it('never schedules anything when permission is denied, and recovers once granted', async () => {
    const { repos, port, sync } = await app();
    await repos.profile.save(profile);
    await repos.milestones.create(anniversary());
    port.permission = 'denied';
    expect((await sync()).report).toMatchObject({ permission: 'denied', scheduled: 0 });
    expect(port.pending.size).toBe(0);
    port.permission = 'granted';
    expect((await sync()).report).toMatchObject({ permission: 'granted', scheduled: 1 });
  });

  it('keeps the widget snapshot in line with profile, dates and privacy', async () => {
    const { repos, sync } = await app();
    expect((await sync()).snapshot.state).toBe('empty');

    await repos.profile.save(profile);
    await repos.milestones.create(anniversary());
    let { snapshot } = await sync();
    expect(snapshot).toMatchObject({ state: 'ready', startDate: '2024-06-14', privacy: 'discreet', displayName: null, upcoming: [] });

    await repos.settings.save({ widgetPrivacy: 'normal' });
    ({ snapshot } = await sync());
    expect(snapshot.displayName).toBe('Sam');
    expect(snapshot.upcoming[0]).toEqual({ title: 'Our anniversary', date: '2027-06-14' });

    await repos.profile.save({ ...profile, startDate: '2025-01-01' });
    ({ snapshot } = await sync());
    expect(snapshot.startDate).toBe('2025-01-01');
    // Changing the start date does not rewrite independent milestone dates.
    expect((await repos.milestones.list())[0].eventDate).toBe('2024-06-14');
  });

  it('survives a cold start with reminders reconciled from the database', async () => {
    const first = await app();
    await first.repos.profile.save(profile);
    await first.repos.milestones.create(anniversary());
    await first.sync();
    const bytes = first.driver.exportBytes();

    const second = await app(bytes); // new process: empty notification centre
    const { report } = await second.sync();
    expect(report.missing).toBe(1);
    expect(second.port.pending.size).toBe(1);
  });

  it('exports every record and leaves no personal data after delete-all', async () => {
    const { repos, port, sync, clock } = await app();
    await repos.profile.save(profile, 'media/11111111-1111-4111-8111-111111111111.jpg');
    const m = await repos.milestones.create(anniversary());
    await repos.memories.create({ title: 'Lisbon', body: 'Tram 28', memoryDate: '2025-05-01', milestoneId: m.id }, [
      { filePath: 'media/22222222-2222-4222-8222-222222222222.jpg', thumbnailPath: null },
    ]);
    await repos.settings.save({ widgetPrivacy: 'normal' });
    await sync();

    const document = buildExportDocument(
      {
        profile: await repos.profile.get(),
        settings: await repos.settings.load(),
        milestones: await repos.milestones.list(),
        reminderRules: await repos.milestones.listRules(),
        memories: await repos.memories.list(),
      },
      { exportedAt: clock.now().toString(), appVersion: '1.0.0', databaseSchemaVersion: 1 },
      new Set(['media/11111111-1111-4111-8111-111111111111.jpg', 'media/22222222-2222-4222-8222-222222222222.jpg']),
    );
    const parsed = parseExportDocument(JSON.stringify(document));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.profile?.displayName).toBe('Sam');
    expect(parsed.document.milestones).toHaveLength(1);
    expect(parsed.document.reminderRules).toHaveLength(1);
    expect(parsed.document.memories[0].media[0].archivePath).toBe('media/22222222-2222-4222-8222-222222222222.jpg');
    expect(parsed.document.mediaComplete).toBe(true);

    // Delete all: cancel reminders, wipe records, privacy-safe widget payload.
    await port.cancel(await port.pendingIds());
    await repos.data.deleteAll();
    const { snapshot, report } = await sync();
    expect(port.pending.size).toBe(0);
    expect(report.planned).toBe(0);
    expect(snapshot.state).toBe('empty');
    const payload = JSON.stringify(snapshot);
    for (const secret of ['Sam', 'anniversary', '2024-06-14', 'Lisbon']) expect(payload).not.toContain(secret);
  });
});
