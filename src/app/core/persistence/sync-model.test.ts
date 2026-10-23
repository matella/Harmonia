import { describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import { compareHlc, HLC_PATTERN, ZERO_HLC } from '../domain/hlc';
import { SYNC_SCHEMA, type SyncedRecordType } from '../domain/sync-schema';
import type { ValidMilestone, ValidProfile } from '../domain/validation';
import { ChangeJournal } from './change-journal';
import { DataRepository } from './data.repository';
import { newId } from './ids';
import { MemoryRepository } from './memory.repository';
import { MilestoneRepository } from './milestone.repository';
import { migrate, MIGRATIONS } from './migrations';
import { RelationshipRepository } from './relationship.repository';
import { SettingsRepository } from './settings.repository';
import type { SqlDriver } from './sql-driver';
import { SqlJsDriver } from './sqljs-driver';
import { TrashRepository } from './trash.repository';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function repos(driver: SqlJsDriver, clock: MutableClock) {
  const journal = new ChangeJournal(clock);
  return {
    driver,
    clock,
    profiles: new RelationshipRepository(driver, clock, newId, journal),
    milestones: new MilestoneRepository(driver, clock, newId, journal),
    memories: new MemoryRepository(driver, clock, newId, journal),
    trash: new TrashRepository(driver, clock, journal),
    settings: new SettingsRepository(driver, clock),
    data: new DataRepository(driver),
  };
}

async function openLatest(initialBytes?: Uint8Array) {
  const driver = await SqlJsDriver.open({ initialBytes });
  await migrate(driver);
  return repos(driver, new MutableClock('2026-10-21T10:00:00Z', 'Europe/Brussels'));
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

const date = (overrides: Partial<ValidMilestone> = {}): ValidMilestone => ({
  title: 'Our anniversary',
  category: 'anniversary',
  eventDate: '2024-06-14',
  eventTime: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: true,
  reminders: [{ offsetDays: 1, localTime: '09:00', includeEventTitle: false }],
  ...overrides,
});

const versionOf = async (driver: SqlDriver, table: string, id: string) =>
  (await driver.query<{ version: string }>(`SELECT version FROM ${table} WHERE id = ?`, [id]))[0]
    ?.version;

describe('upgrade from schema v1 (existing installs)', () => {
  async function v1Database(withProfile: boolean) {
    const driver = await SqlJsDriver.open();
    await migrate(driver, MIGRATIONS.slice(0, 1));
    const at = '2025-01-01T00:00:00Z';
    if (withProfile) {
      await driver.run(
        `INSERT INTO relationship_profile (id, display_name, relationship_label, start_date, start_time, start_time_zone_id,
           calendar_time_zone_id, photo_path, created_at, updated_at)
         VALUES (1, 'Sam', 'Together', '2024-06-14', '20:15', 'Europe/Paris', 'Europe/Paris', 'media/p.jpg', ?, ?)`,
        [at, at],
      );
    }
    await driver.run(
      `INSERT INTO milestones (id, title, category, event_date, recurrence_rule, is_pinned, photo_path, created_at, updated_at)
       VALUES ('m1', 'Our anniversary', 'anniversary', '2024-06-14', 'yearly', 1, 'media/c.jpg', ?, ?)`,
      [at, at],
    );
    await driver.run(
      `INSERT INTO reminder_rules (id, milestone_id, offset_days, local_time, notification_id, created_at, updated_at)
       VALUES ('r1', 'm1', 1, '09:00', 1000, ?, ?)`,
      [at, at],
    );
    await driver.run(
      `INSERT INTO memories (id, milestone_id, title, body, memory_date, created_at, updated_at)
       VALUES ('x1', 'm1', 'Dinner', 'Candles', '2025-06-14', ?, ?)`,
      [at, at],
    );
    await driver.run(
      `INSERT INTO memory_media (id, memory_id, file_path, thumbnail_path, sort_order, created_at)
       VALUES ('p1', 'x1', 'media/a.jpg', 'media/thumbs/a.jpg', 0, ?)`,
      [at],
    );
    await driver.run(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ('theme', '"dark"', ?)`,
      [at],
    );
    await driver.run(`INSERT INTO id_sequences (name, value) VALUES ('notification', 1000)`);
    return driver;
  }

  it('keeps every value and turns the typed partner name into a placeholder person', async () => {
    const driver = await v1Database(true);
    expect(await migrate(driver)).toEqual({ from: 1, to: MIGRATIONS.length });
    const r = repos(driver, new MutableClock('2026-10-21T10:00:00Z', 'Europe/Paris'));

    const p = await r.profiles.get();
    expect(p).toMatchObject({
      displayName: 'Sam',
      selfName: null,
      relationshipLabel: 'Together',
      startDate: '2024-06-14',
      startTime: '20:15',
      startTimeZoneId: 'Europe/Paris',
      calendarTimeZoneId: 'Europe/Paris',
      photoPath: 'media/p.jpg',
      createdAt: '2025-01-01T00:00:00Z',
    });
    const people = await r.profiles.persons();
    expect(people.map((x) => [x.displayName, x.isSelf, x.isPlaceholder])).toEqual([
      [null, true, false],
      ['Sam', false, true],
    ]);
    for (const person of people) expect(person.id).toMatch(UUID_V4);
    expect(await driver.query('SELECT display_name FROM relationship_profile')).toEqual([
      { display_name: null },
    ]);

    const [m] = await r.milestones.list();
    expect(m).toMatchObject({
      id: 'm1',
      title: 'Our anniversary',
      isPinned: true,
      photoPath: 'media/c.jpg',
    });
    expect((await r.milestones.listRules()).map((x) => x.notificationId)).toEqual([1000]);
    const [memory] = await r.memories.list();
    expect(memory).toMatchObject({ id: 'x1', milestoneId: 'm1', title: 'Dinner' });
    expect(memory.media.map((x) => x.filePath)).toEqual(['media/a.jpg']);
    expect((await r.settings.load()).theme).toBe('dark');

    const self = people[0].id;
    expect(
      await driver.query('SELECT version, author_person_id AS author FROM milestones'),
    ).toEqual([{ version: ZERO_HLC, author: self }]);
    expect(await driver.query('SELECT author_person_id AS author FROM memories')).toEqual([
      { author: self },
    ]);
  });

  it('upgrades an install that never finished onboarding', async () => {
    const driver = await v1Database(false);
    await migrate(driver);
    const r = repos(driver, new MutableClock('2026-10-21T10:00:00Z', 'Europe/Paris'));
    expect(await r.profiles.persons()).toEqual([]);
    await r.profiles.save({ ...profile, selfName: 'Matthieu' });
    expect(
      (await r.profiles.persons()).map((x) => [x.displayName, x.isSelf, x.isPlaceholder]),
    ).toEqual([
      ['Matthieu', true, false],
      ['Sam', false, true],
    ]);
  });
});

describe('upgrade to schema v4 (device list)', () => {
  it('keeps queued changes and accepts device records', async () => {
    const driver = await SqlJsDriver.open();
    await migrate(driver, MIGRATIONS.slice(0, 3));
    const at = '2026-10-23T10:00:00Z';
    await driver.run(
      `INSERT INTO sync_state (id, space_id, epoch, cursor, created_at) VALUES (1, 's', 1, 0, ?)`,
      [at],
    );
    await driver.run(
      `INSERT INTO outbox (record_type, record_id, version, created_at) VALUES ('milestone', 'm1', ?, ?)`,
      [ZERO_HLC, at],
    );
    await migrate(driver);
    expect(await driver.query('SELECT record_type, record_id FROM outbox')).toEqual([
      { record_type: 'milestone', record_id: 'm1' },
    ]);
    await driver.run(
      `INSERT INTO outbox (record_type, record_id, version, created_at) VALUES ('device', 'd1', ?, ?)`,
      [ZERO_HLC, at],
    );
    expect(await driver.query(`SELECT seq FROM outbox ORDER BY seq`)).toEqual([
      { seq: 1 },
      { seq: 2 },
    ]);
  });
});

describe('versions', () => {
  it('advance on every write: create, update, pin, trash and restore', async () => {
    const { driver, milestones, memories, trash } = await openLatest();
    const m = await milestones.create(date());
    const seen = [await versionOf(driver, 'milestones', m.id)];
    await milestones.update(m.id, date({ title: 'Anniversary' }));
    seen.push(await versionOf(driver, 'milestones', m.id));
    await milestones.setPinned(m.id, true);
    seen.push(await versionOf(driver, 'milestones', m.id));
    await milestones.delete(m.id, { deleteLinkedMemories: false });
    seen.push(await versionOf(driver, 'milestones', m.id));
    await trash.restoreMilestone(m.id);
    seen.push(await versionOf(driver, 'milestones', m.id));
    for (const v of seen) expect(v).toMatch(HLC_PATTERN);
    for (let i = 1; i < seen.length; i++) expect(compareHlc(seen[i - 1]!, seen[i]!)).toBe(-1);

    const memory = await memories.create(
      { title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null },
      [],
    );
    const before = await versionOf(driver, 'memories', memory.id);
    await memories.update(
      memory.id,
      { title: 'y', body: 'x', memoryDate: '2025-01-01', milestoneId: null },
      { add: [], removeIds: [] },
    );
    expect(compareHlc(before!, (await versionOf(driver, 'memories', memory.id))!)).toBe(-1);
  });

  it('keep increasing when the device clock goes back and after a restart', async () => {
    const first = await openLatest();
    const m = await first.milestones.create(date());
    const v1 = (await versionOf(first.driver, 'milestones', m.id))!;
    first.clock.set('2020-01-01T00:00:00Z'); // clock jumped back years
    await first.milestones.update(m.id, date({ title: 'B' }));
    const v2 = (await versionOf(first.driver, 'milestones', m.id))!;
    expect(compareHlc(v1, v2)).toBe(-1);

    const second = await openLatest(first.driver.exportBytes());
    second.clock.set('2020-01-01T00:00:00Z');
    await second.milestones.update(m.id, date({ title: 'C' }));
    expect(compareHlc(v2, (await versionOf(second.driver, 'milestones', m.id))!)).toBe(-1);
  });

  it('writes a person version only when a name actually changes', async () => {
    const { driver, profiles } = await openLatest();
    await profiles.save(profile);
    const partner = (await profiles.persons()).find((p) => !p.isSelf)!;
    const v1 = await versionOf(driver, 'persons', partner.id);
    await profiles.save({ ...profile, relationshipLabel: 'Us' });
    expect(await versionOf(driver, 'persons', partner.id)).toBe(v1);
    await profiles.save({ ...profile, displayName: 'Samuel' });
    expect(compareHlc(v1!, (await versionOf(driver, 'persons', partner.id))!)).toBe(-1);
    expect((await profiles.get())?.displayName).toBe('Samuel');
  });
});

describe('outbox', () => {
  it('stays empty on a solo device', async () => {
    const { driver, profiles, milestones } = await openLatest();
    await profiles.save(profile);
    await milestones.create(date());
    expect(await driver.query('SELECT * FROM outbox')).toEqual([]);
  });

  it('queues one entry per changed record once sharing is on, with its latest version', async () => {
    const { driver, milestones } = await openLatest();
    await driver.run(
      `INSERT INTO sync_state (id, space_id, created_at) VALUES (1, 'space', 'now')`,
    );
    const m = await milestones.create(date());
    await milestones.update(m.id, date({ title: 'B' }));
    const rows = await driver.query<{
      record_type: SyncedRecordType;
      record_id: string;
      version: string;
    }>('SELECT record_type, record_id, version FROM outbox');
    expect(rows).toEqual([
      {
        record_type: 'milestone',
        record_id: m.id,
        version: await versionOf(driver, 'milestones', m.id),
      },
    ]);
  });
});

describe('trash', () => {
  it('restores a date with the memories that went with it, and its reminders with the same IDs', async () => {
    const { milestones, memories, trash } = await openLatest();
    const m = await milestones.create(date());
    const ids = (await milestones.listRules()).map((r) => r.notificationId);
    const withDate = await memories.create(
      { title: 'With it', body: 'x', memoryDate: '2025-01-01', milestoneId: m.id },
      [{ filePath: 'media/a.jpg', thumbnailPath: null }],
    );
    const alone = await memories.create(
      { title: 'Alone', body: 'x', memoryDate: '2025-01-02', milestoneId: null },
      [],
    );
    await memories.delete(alone.id);
    await milestones.delete(m.id, { deleteLinkedMemories: true });

    const items = await trash.list();
    expect(items.map((i) => [i.kind, i.id, i.memoryCount, i.photoCount])).toEqual(
      expect.arrayContaining([
        ['milestone', m.id, 1, 1],
        ['memory', alone.id, 0, 0],
      ]),
    );
    expect(items).toHaveLength(2);
    expect(await milestones.listRules()).toEqual([]);

    await trash.restoreMilestone(m.id);
    expect((await milestones.list()).map((x) => x.id)).toEqual([m.id]);
    expect((await milestones.listRules()).map((r) => r.notificationId)).toEqual(ids);
    expect((await memories.list()).map((x) => x.id)).toEqual([withDate.id]); // "Alone" stays in the trash
    expect((await memories.get(withDate.id))?.media.map((x) => x.filePath)).toEqual([
      'media/a.jpg',
    ]);
    expect((await trash.list()).map((i) => i.id)).toEqual([alone.id]);
  });

  it('never lets the startup cleanup delete photos of trashed items', async () => {
    const { memories, trash } = await openLatest();
    const memory = await memories.create(
      { title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null },
      [{ filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' }],
    );
    await memories.delete(memory.id);
    const referenced = await memories.referencedFiles();
    expect(referenced.has('media/a.jpg') && referenced.has('media/thumbs/a.jpg')).toBe(true);
    await trash.restoreMemory(memory.id);
    expect((await memories.get(memory.id))?.media).toHaveLength(1);
  });

  it('purges after 30 days, returning files to delete and dropping rules', async () => {
    const { driver, clock, milestones, memories, trash } = await openLatest();
    const m = await milestones.create(date(), 'media/cover.jpg');
    const kept = await memories.create(
      { title: 'Kept', body: 'x', memoryDate: '2025-01-01', milestoneId: m.id },
      [],
    );
    const gone = await memories.create(
      { title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null },
      [{ filePath: 'media/a.jpg', thumbnailPath: 'media/thumbs/a.jpg' }],
    );
    await milestones.delete(m.id, { deleteLinkedMemories: false });
    await memories.delete(gone.id);

    clock.set('2026-11-19T10:00:00Z'); // 29 days later: nothing yet
    expect(await trash.purgeExpired()).toEqual([]);
    clock.set('2026-11-21T10:00:01Z'); // just over 30 days
    expect((await trash.purgeExpired()).sort()).toEqual([
      'media/a.jpg',
      'media/cover.jpg',
      'media/thumbs/a.jpg',
    ]);
    expect(await trash.list()).toEqual([]);
    expect(await driver.query('SELECT COUNT(*) AS n FROM reminder_rules')).toEqual([{ n: 0 }]);
    expect((await memories.get(kept.id))?.milestoneId).toBeNull();
  });

  it('deletes forever on request', async () => {
    const { memories, trash } = await openLatest();
    const memory = await memories.create(
      { title: null, body: 'x', memoryDate: '2025-01-01', milestoneId: null },
      [{ filePath: 'media/a.jpg', thumbnailPath: null }],
    );
    await memories.delete(memory.id);
    expect(await trash.deleteForever('memory', memory.id)).toEqual(['media/a.jpg']);
    expect(await trash.list()).toEqual([]);
  });
});

describe('delete all', () => {
  it('also clears people, the clock, sync state and the outbox', async () => {
    const { driver, profiles, milestones, data } = await openLatest();
    await profiles.save({ ...profile, selfName: 'Matthieu' });
    await driver.run(
      `INSERT INTO sync_state (id, space_id, created_at) VALUES (1, 'space', 'now')`,
    );
    await milestones.create(date());
    await data.deleteAll();
    for (const table of [
      'persons',
      'hlc_state',
      'sync_state',
      'outbox',
      'space_devices',
      'milestones',
      'relationship_profile',
    ]) {
      expect(await driver.query(`SELECT COUNT(*) AS n FROM ${table}`), table).toEqual([{ n: 0 }]);
    }
  });
});

describe('sync schema', () => {
  it('classifies every column of every synced table exactly once', async () => {
    const { driver } = await openLatest();
    for (const [type, schema] of Object.entries(SYNC_SCHEMA)) {
      const columns = (await driver.query<{ name: string }>(`PRAGMA table_info(${schema.table})`))
        .map((c) => c.name)
        .sort();
      const classified = [...schema.shared, ...schema.local, ...schema.meta];
      expect(new Set(classified).size, type).toBe(classified.length);
      expect([...classified].sort(), type).toEqual(columns);
    }
  });

  it('never shares day-counting zones or local file paths', () => {
    expect(SYNC_SCHEMA.profile.shared).not.toContain('calendar_time_zone_id');
    for (const schema of Object.values(SYNC_SCHEMA)) {
      for (const column of schema.shared) expect(column).not.toMatch(/path/);
    }
  });
});
