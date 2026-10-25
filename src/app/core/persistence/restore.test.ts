import { describe, expect, it } from 'vitest';

import { makeMilestone, makeProfile, makeRule, settings } from '../../../testing/fixtures';
import { MutableClock } from '../domain/clock';
import { buildExportDocument, parseExportDocument } from '../domain/export-format';
import { planRestore, type RestorePlan } from '../domain/restore-plan';
import { Temporal } from '../domain/temporal';
import { newId } from './ids';
import { MemoryRepository } from './memory.repository';
import { MilestoneRepository } from './milestone.repository';
import { migrate } from './migrations';
import { RelationshipRepository } from './relationship.repository';
import { RestoreNotEmptyError, RestoreRepository } from './restore.repository';
import { SettingsRepository } from './settings.repository';
import { SqlJsDriver } from './sqljs-driver';

async function openDb() {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-24T10:00:00Z', 'Europe/Brussels');
  return {
    driver,
    restore: new RestoreRepository(driver, clock, newId),
    profiles: new RelationshipRepository(driver, clock),
    milestones: new MilestoneRepository(driver, clock, newId),
    memories: new MemoryRepository(driver, clock, newId),
    settings: new SettingsRepository(driver, clock),
  };
}

function plan(): RestorePlan {
  const at = '2026-10-20T10:00:00Z';
  const doc = buildExportDocument(
    {
      profile: makeProfile({ displayName: 'Sam', selfName: 'Alex', photoPath: 'media/me.jpg' }),
      settings: settings({ theme: 'dark', appLock: true }),
      milestones: [
        makeMilestone({
          id: 'trip',
          title: 'First trip',
          photoPath: 'media/trip.jpg',
          isPinned: true,
        }),
      ],
      reminderRules: [
        makeRule('trip', { offsetDays: 1, includeEventTitle: true }),
        makeRule('trip', { offsetDays: 0 }),
      ],
      memories: [
        {
          id: 'lisbon',
          milestoneId: 'trip',
          title: 'Lisbon',
          body: 'Tram 28',
          memoryDate: '2025-05-01',
          media: [
            {
              id: 'a',
              memoryId: 'lisbon',
              filePath: 'media/a.jpg',
              thumbnailPath: null,
              sortOrder: 0,
              createdAt: at,
            },
            {
              id: 'b',
              memoryId: 'lisbon',
              filePath: 'media/b.jpg',
              thumbnailPath: null,
              sortOrder: 1,
              createdAt: at,
            },
          ],
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
    { exportedAt: at, appVersion: '1.0.0', databaseSchemaVersion: 8 },
    new Set(['media/me.jpg', 'media/trip.jpg', 'media/a.jpg', 'media/b.jpg']),
  );
  const parsed = parseExportDocument(JSON.stringify(doc));
  if (!parsed.ok) throw new Error(parsed.reason);
  const result = planRestore(parsed.document, Temporal.PlainDate.from('2026-10-24'));
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

/** Photos as stored on the new phone (new file names); "b" couldn't be read. */
const stored = new Map([
  ['media/me.jpg', { filePath: 'media/n-me.jpg', thumbnailPath: 'media/thumbs/n-me.jpg' }],
  ['media/trip.jpg', { filePath: 'media/n-trip.jpg', thumbnailPath: 'media/thumbs/n-trip.jpg' }],
  ['media/a.jpg', { filePath: 'media/n-a.jpg', thumbnailPath: 'media/thumbs/n-a.jpg' }],
]);

describe('RestoreRepository', () => {
  it('brings back the profile, names, dates, reminders, memories and settings, with their IDs', async () => {
    const db = await openDb();
    expect(await db.restore.isEmpty()).toBe(true);
    await db.restore.restore(plan(), stored);

    const profile = await db.profiles.get();
    expect(profile).toMatchObject({
      displayName: 'Sam',
      selfName: 'Alex',
      startDate: '2024-06-14',
      photoPath: 'media/n-me.jpg',
    });
    expect((await db.profiles.persons()).map((p) => [p.isSelf, p.isPlaceholder])).toEqual([
      [true, false],
      [false, true],
    ]);

    const [trip] = await db.milestones.list();
    expect(trip).toMatchObject({
      id: 'trip',
      title: 'First trip',
      photoPath: 'media/n-trip.jpg',
      isPinned: true,
    });
    const rules = await db.milestones.rulesFor('trip');
    expect(rules.map((r) => [r.offsetDays, r.includeEventTitle])).toEqual([
      [1, true],
      [0, false],
    ]);
    expect(new Set(rules.map((r) => r.notificationId)).size).toBe(2);

    const [lisbon] = await db.memories.list();
    expect(lisbon).toMatchObject({ id: 'lisbon', milestoneId: 'trip', title: 'Lisbon' });
    expect(lisbon.media.map((m) => [m.filePath, m.thumbnailPath])).toEqual([
      ['media/n-a.jpg', 'media/thumbs/n-a.jpg'],
    ]);

    const s = await db.settings.load();
    expect(s.theme).toBe('dark');
    expect(s.appLock).toBe(false); // the phone's own choice
    expect(s.lastBackupAt).toBe('2026-10-24T10:00:00Z'); // the restored file counts as a copy
    expect(await db.restore.isEmpty()).toBe(false);
  });

  it('later edits work as usual on restored records', async () => {
    const db = await openDb();
    await db.restore.restore(plan(), stored);
    const created = await db.milestones.create({
      title: 'Dinner',
      category: 'custom',
      eventDate: '2026-11-20',
      eventTime: null,
      recurrence: 'none',
      leapDayPolicy: null,
      note: null,
      isPinned: false,
      remindersEnabled: true,
      reminders: [{ offsetDays: 1, localTime: '09:00', includeEventTitle: false }],
    });
    const ids = [...(await db.milestones.listRules())].map((r) => r.notificationId);
    expect(new Set(ids).size).toBe(ids.length); // no notification ID handed out twice
    expect(created.id).not.toBe('trip');
  });

  it('refuses over existing data, even data in the trash, and while sharing', async () => {
    const withProfile = await openDb();
    await withProfile.profiles.save({
      displayName: null,
      selfName: null,
      relationshipLabel: null,
      startDate: '2024-01-01',
      startTime: null,
      startTimeZoneId: null,
      calendarTimeZoneId: 'Europe/Brussels',
    });
    await expect(withProfile.restore.restore(plan(), stored)).rejects.toBeInstanceOf(
      RestoreNotEmptyError,
    );

    const sharing = await openDb();
    await sharing.driver.run(
      `INSERT INTO sync_state (id, space_id, created_at) VALUES (1, 'space', '2026-10-24T10:00:00Z')`,
    );
    expect(await sharing.restore.isEmpty()).toBe(false);
    await expect(sharing.restore.restore(plan(), stored)).rejects.toBeInstanceOf(
      RestoreNotEmptyError,
    );
  });

  it('saves nothing when any record fails', async () => {
    const db = await openDb();
    const broken = plan();
    broken.memories.push({ ...broken.memories[0] }); // the same ID twice
    await expect(db.restore.restore(broken, stored)).rejects.toThrow();
    expect(await db.restore.isEmpty()).toBe(true);
    expect(await db.profiles.persons()).toEqual([]);
  });
});
