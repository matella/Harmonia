import { describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import type { ValidMilestone, ValidProfile } from '../domain/validation';
import { DataRepository } from './data.repository';
import { newId } from './ids';
import { MemoryRepository } from './memory.repository';
import { MilestoneRepository } from './milestone.repository';
import { DatabaseTooNewError, LATEST_SCHEMA_VERSION, migrate, MigrationError, MIGRATIONS } from './migrations';
import { RelationshipRepository } from './relationship.repository';
import { SettingsRepository } from './settings.repository';
import { SqlJsDriver } from './sqljs-driver';

async function openDb(initialBytes?: Uint8Array) {
  const driver = await SqlJsDriver.open({ initialBytes });
  await migrate(driver);
  const clock = new MutableClock('2026-10-18T10:00:00Z', 'Europe/Brussels');
  return {
    driver,
    clock,
    profiles: new RelationshipRepository(driver, clock),
    milestones: new MilestoneRepository(driver, clock, newId),
    memories: new MemoryRepository(driver, clock, newId),
    settings: new SettingsRepository(driver, clock),
    data: new DataRepository(driver),
  };
}

const profile: ValidProfile = {
  displayName: 'Sam',
  selfName: null,
  relationshipLabel: null,
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
};

const milestone = (overrides: Partial<ValidMilestone> = {}): ValidMilestone => ({
  title: 'Our anniversary',
  category: 'anniversary',
  eventDate: '2024-06-14',
  eventTime: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: true,
  reminders: [
    { offsetDays: 7, localTime: '09:00', includeEventTitle: false },
    { offsetDays: 0, localTime: '09:00', includeEventTitle: false },
  ],
  ...overrides,
});

describe('migrations', () => {
  it('creates the latest schema and is idempotent', async () => {
    const driver = await SqlJsDriver.open();
    expect(await migrate(driver)).toEqual({ from: 0, to: LATEST_SCHEMA_VERSION });
    expect(await migrate(driver)).toEqual({ from: LATEST_SCHEMA_VERSION, to: LATEST_SCHEMA_VERSION });
    const tables = await driver.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['app_settings', 'memories', 'memory_media', 'milestones', 'relationship_profile', 'reminder_rules']),
    );
  });

  it('rolls back a failing migration completely and keeps existing data', async () => {
    const { driver, profiles } = await openDb();
    await profiles.save(profile);
    const broken = [
      ...MIGRATIONS,
      { version: LATEST_SCHEMA_VERSION + 1, name: 'broken', statements: ['CREATE TABLE extra (id TEXT)', 'NOT VALID SQL'] },
    ];
    await expect(migrate(driver, broken)).rejects.toBeInstanceOf(MigrationError);
    const extra = await driver.query("SELECT name FROM sqlite_master WHERE name = 'extra'");
    expect(extra).toHaveLength(0);
    expect((await profiles.get())?.displayName).toBe('Sam');
  });

  it('refuses to open a database written by a newer app version', async () => {
    const driver = await SqlJsDriver.open();
    await migrate(driver);
    await driver.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, 'future', 'x')");
    await expect(migrate(driver)).rejects.toBeInstanceOf(DatabaseTooNewError);
  });
});

describe('RelationshipRepository', () => {
  it('creates, updates and keeps createdAt', async () => {
    const { profiles, clock } = await openDb();
    expect(await profiles.get()).toBeNull();
    const created = await profiles.save(profile, 'media/p.jpg');
    clock.set('2026-10-19T10:00:00Z');
    const updated = await profiles.save({ ...profile, displayName: 'Alex' });
    expect(updated.displayName).toBe('Alex');
    expect(updated.photoPath).toBe('media/p.jpg'); // undefined photo keeps the existing one
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBe('2026-10-19T10:00:00Z');
    expect((await profiles.save(profile, null)).photoPath).toBeNull();
  });

  it('stores date-only values verbatim', async () => {
    const { profiles } = await openDb();
    await profiles.save({ ...profile, startDate: '2024-02-29' });
    expect((await profiles.get())?.startDate).toBe('2024-02-29');
  });
});

describe('MilestoneRepository', () => {
  it('creates milestones with reminder rules and unique notification IDs', async () => {
    const { milestones } = await openDb();
    const a = await milestones.create(milestone());
    const b = await milestones.create(milestone({ title: 'First date', recurrence: 'none' }));
    const rules = await milestones.listRules();
    expect(rules).toHaveLength(4);
    expect(new Set(rules.map((r) => r.notificationId)).size).toBe(4);
    expect((await milestones.rulesFor(a.id)).map((r) => r.offsetDays)).toEqual([7, 0]);
    expect(b.recurrence).toBe('none');
  });

  it('keeps notification IDs for unchanged offsets when editing', async () => {
    const { milestones } = await openDb();
    const m = await milestones.create(milestone());
    const before = await milestones.rulesFor(m.id);
    await milestones.update(
      m.id,
      milestone({
        title: 'Anniversary',
        reminders: [
          { offsetDays: 0, localTime: '18:30', includeEventTitle: true },
          { offsetDays: 1, localTime: '09:00', includeEventTitle: false },
        ],
      }),
    );
    const after = await milestones.rulesFor(m.id);
    const onDayBefore = before.find((r) => r.offsetDays === 0)!;
    const onDayAfter = after.find((r) => r.offsetDays === 0)!;
    expect(onDayAfter.notificationId).toBe(onDayBefore.notificationId);
    expect(onDayAfter).toMatchObject({ localTime: '18:30', includeEventTitle: true });
    expect(after.map((r) => r.offsetDays)).toEqual([1, 0]);
    const issued = new Set([...before, ...after].map((r) => r.notificationId));
    expect(issued.size).toBe(3); // the removed 7-day rule's ID is not reused
  });

  it('removes every rule when reminders are turned off', async () => {
    const { milestones } = await openDb();
    const m = await milestones.create(milestone());
    await milestones.update(m.id, milestone({ remindersEnabled: false, reminders: [] }));
    expect(await milestones.rulesFor(m.id)).toEqual([]);
  });

  it('pins and unpins', async () => {
    const { milestones } = await openDb();
    const m = await milestones.create(milestone());
    await milestones.setPinned(m.id, true);
    expect((await milestones.get(m.id))?.isPinned).toBe(true);
  });

  it('moves a milestone to the trash, hiding its rules, and can keep linked memories', async () => {
    const { milestones, memories } = await openDb();
    const m = await milestones.create(milestone());
    const memory = await memories.create(
      { title: 'Dinner', body: 'Candles', memoryDate: '2025-06-14', milestoneId: m.id },
      [{ filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' }],
    );
    expect(await milestones.countLinkedMemories(m.id)).toBe(1);
    const result = await milestones.delete(m.id, { deleteLinkedMemories: false });
    expect(result.orphanedFiles).toEqual([]);
    expect(await milestones.get(m.id)).toBeNull();
    expect(await milestones.listRules()).toEqual([]);
    // The kept memory keeps its link (shown as unlinked while the date is in the trash).
    const kept = await memories.get(memory.id);
    expect(kept?.milestoneId).toBe(m.id);
    expect(kept?.media).toHaveLength(1);
  });

  it('can trash linked memories together with the milestone, keeping every file until purge', async () => {
    const { milestones, memories } = await openDb();
    const m = await milestones.create(milestone(), 'media/cover.jpg');
    await memories.create({ title: null, body: 'x', memoryDate: '2025-06-14', milestoneId: m.id }, [
      { filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' },
    ]);
    const result = await milestones.delete(m.id, { deleteLinkedMemories: true });
    expect(result.orphanedFiles).toEqual([]);
    expect(await memories.list()).toEqual([]);
    expect([...(await memories.referencedFiles())].sort()).toEqual(['media/a.jpg', 'media/cover.jpg', 'media/thumbs/a.jpg']);
  });

  it('rejects whitespace titles at the database level too', async () => {
    const { milestones } = await openDb();
    await expect(milestones.create(milestone({ title: '   ' }))).rejects.toThrow();
  });
});

describe('MemoryRepository', () => {
  it('creates, updates media and trashes, reporting files that can go now', async () => {
    const { memories } = await openDb();
    const memory = await memories.create({ title: 'Lisbon', body: null, memoryDate: '2025-05-01', milestoneId: null }, [
      { filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' },
      { filePath: 'media/b.jpg', thumbnailPath: null },
    ]);
    expect(memory.media.map((m) => [m.filePath, m.sortOrder])).toEqual([
      ['media/a.jpg', 0],
      ['media/b.jpg', 1],
    ]);
    const { memory: updated, orphanedFiles } = await memories.update(
      memory.id,
      { title: 'Lisbon, again', body: 'Tram 28', memoryDate: '2025-05-02', milestoneId: null },
      { add: [{ filePath: 'media/c.jpg', thumbnailPath: null }], removeIds: [memory.media[0].id] },
    );
    expect(orphanedFiles).toEqual(['media/a.jpg', 'media/thumbs/a.jpg']);
    expect(updated.media.map((m) => [m.filePath, m.sortOrder])).toEqual([
      ['media/b.jpg', 1],
      ['media/c.jpg', 2],
    ]);
    expect(updated.title).toBe('Lisbon, again');
    const deletion = await memories.delete(memory.id);
    expect(deletion.orphanedFiles).toEqual([]);
    expect(await memories.get(memory.id)).toBeNull();
    // Trashed photos stay referenced; the removed photo does not.
    expect([...(await memories.referencedFiles())].sort()).toEqual(['media/b.jpg', 'media/c.jpg']);
  });

  it('lists referenced files across tables for orphan cleanup', async () => {
    const { memories, profiles, milestones } = await openDb();
    await profiles.save(profile, 'media/profile.jpg');
    await milestones.create(milestone(), 'media/cover.jpg');
    await memories.create({ title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null }, [
      { filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' },
    ]);
    expect([...(await memories.referencedFiles())].sort()).toEqual([
      'media/a.jpg',
      'media/cover.jpg',
      'media/profile.jpg',
      'media/thumbs/a.jpg',
    ]);
  });
});

describe('SettingsRepository', () => {
  it('returns defaults, persists changes and ignores corrupt values', async () => {
    const { settings, driver } = await openDb();
    expect((await settings.load()).widgetPrivacy).toBe('discreet');
    expect((await settings.save({ theme: 'dark', defaultReminderOffsets: [3] })).theme).toBe('dark');
    await driver.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('counterFormat', '\"bogus\"', 'x')");
    await driver.run("INSERT INTO app_settings (key, value, updated_at) VALUES ('leapDayPolicy', 'not json', 'x')");
    const loaded = await settings.load();
    expect(loaded).toMatchObject({ theme: 'dark', defaultReminderOffsets: [3], counterFormat: 'calendar', leapDayPolicy: 'feb28' });
  });

  it('rejects invalid values on save', async () => {
    const { settings } = await openDb();
    await expect(settings.save({ defaultReminderTime: '25:00' })).rejects.toThrow();
  });

  it('keeps the app lock off by default and its delay to the offered choices', async () => {
    const { settings, driver } = await openDb();
    expect(await settings.load()).toMatchObject({ appLock: false, appLockAfter: 1 });
    expect(await settings.save({ appLock: true, appLockAfter: 15 })).toMatchObject({ appLock: true, appLockAfter: 15 });
    await driver.run("UPDATE app_settings SET value = '7' WHERE key = 'appLockAfter'");
    expect((await settings.load()).appLockAfter).toBe(1);
    await expect(settings.save({ appLockAfter: 7 as never })).rejects.toThrow();
  });
});

describe('cold start and deletion', () => {
  it('restores all data from the persisted database image', async () => {
    const first = await openDb();
    await first.profiles.save(profile);
    const m = await first.milestones.create(milestone());
    await first.settings.save({ counterFormat: 'days' });
    const bytes = first.driver.exportBytes();
    await first.driver.close();

    const second = await openDb(bytes);
    expect((await second.profiles.get())?.startDate).toBe('2024-06-14');
    expect((await second.milestones.get(m.id))?.title).toBe('Our anniversary');
    expect(await second.milestones.rulesFor(m.id)).toHaveLength(2);
    expect((await second.settings.load()).counterFormat).toBe('days');
    // Foreign keys stay enforced after reopening.
    await expect(
      second.driver.run(
        "INSERT INTO reminder_rules (id, milestone_id, offset_days, local_time, notification_id, created_at, updated_at) VALUES ('x', 'missing', 0, '09:00', 1, 'x', 'x')",
      ),
    ).rejects.toThrow();
  });

  it('deletes every user record', async () => {
    const { profiles, milestones, memories, settings, data, driver } = await openDb();
    await profiles.save(profile);
    await milestones.create(milestone());
    await memories.create({ title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null }, []);
    await settings.save({ theme: 'dark' });
    await data.deleteAll();
    expect(await profiles.get()).toBeNull();
    expect(await milestones.list()).toEqual([]);
    expect(await milestones.listRules()).toEqual([]);
    expect(await memories.list()).toEqual([]);
    expect((await settings.load()).theme).toBe('system');
    const dump = JSON.stringify(await driver.query('SELECT * FROM app_settings'));
    expect(dump).toBe('[]');
  });
});
