import { beforeAll, describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import { compareHlc } from '../domain/hlc';
import type { ValidMilestone, ValidProfile } from '../domain/validation';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { MilestoneRepository } from '../persistence/milestone.repository';
import { migrate } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { TrashRepository } from '../persistence/trash.repository';
import { loadSyncCrypto, type SyncCrypto } from './sync-crypto-port';
import { SyncEngine, type SpaceKeyring, type SyncEngineOptions } from './sync-engine';
import { PROFILE_RECORD_ID, SyncStore } from './sync-store';
import { InMemoryTransport, type SyncTransport, type WireRecord } from './sync-transport';

const SPACE = '7d0c3b8e-1f2a-4c5d-9e6f-0a1b2c3d4e5f';

let crypto: SyncCrypto;
let spaceKey: Uint8Array;
let keyring: SpaceKeyring;

beforeAll(async () => {
  crypto = await loadSyncCrypto();
  spaceKey = crypto.newSpaceKey();
  keyring = { currentEpoch: () => 1, key: (epoch) => (epoch === 1 ? spaceKey : null) };
});

async function device(transport: SyncTransport, zone: string, options: SyncEngineOptions = {}) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-22T10:00:00Z', zone);
  const journal = new ChangeJournal(clock);
  const store = new SyncStore(driver, clock, journal);
  return {
    driver,
    clock,
    store,
    profiles: new RelationshipRepository(driver, clock, newId, journal),
    milestones: new MilestoneRepository(driver, clock, newId, journal),
    trash: new TrashRepository(driver, clock, journal),
    engine: new SyncEngine(
      store,
      transport,
      crypto,
      keyring,
      () => ({ calendarTimeZoneId: clock.timeZoneId() }),
      options,
    ),
    /** Turns sharing on; everything already here is queued for upload. */
    join: () => store.joinSpace(SPACE, 1),
  };
}

const profile: ValidProfile = {
  displayName: 'Sam',
  selfName: 'Alex',
  relationshipLabel: 'Us',
  startDate: '2024-06-14',
  startTime: '20:15',
  startTimeZoneId: 'Europe/Brussels',
  calendarTimeZoneId: 'Europe/Brussels',
};

const date = (overrides: Partial<ValidMilestone> = {}): ValidMilestone => ({
  title: 'First trip',
  category: 'first_trip',
  eventDate: '2025-03-02',
  eventTime: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: 'Ghent',
  isPinned: false,
  remindersEnabled: true,
  reminders: [{ offsetDays: 1, localTime: '09:00', includeEventTitle: false }],
  ...overrides,
});

/** Two devices in one space; A starts with a profile and one date and uploads them. */
async function pair(options: SyncEngineOptions = {}) {
  const server = new InMemoryTransport();
  const a = await device(server, 'Europe/Brussels', options);
  const b = await device(server, 'America/Montreal', options);
  await a.profiles.save(profile, 'media/profile.jpg');
  const trip = await a.milestones.create(date(), 'media/trip.jpg');
  await a.join();
  await a.engine.sync();
  await b.store.joinSpace(SPACE, 1);
  await b.engine.sync();
  return { server, a, b, trip };
}

function openAll(server: InMemoryTransport): Record<string, unknown>[] {
  return server.all().map((wire) => {
    const address = {
      spaceId: SPACE,
      recordType: wire.recordType,
      recordId: wire.recordId,
      epoch: wire.epoch,
      version: wire.version,
      deleted: wire.deleted,
    };
    return JSON.parse(crypto.decryptRecord(spaceKey, address, wire)).data;
  });
}

describe('sync engine (two devices, in-memory server)', () => {
  it('shares the profile, both names and the dates, without local-only columns', async () => {
    const { server, a, b, trip } = await pair();

    const p = await b.profiles.get();
    expect(p).toMatchObject({
      relationshipLabel: 'Us',
      startDate: '2024-06-14',
      startTime: '20:15',
      startTimeZoneId: 'Europe/Brussels',
    });
    expect(p?.calendarTimeZoneId).toBe('America/Montreal'); // B keeps its own "today"
    expect(p?.photoPath).toBeNull();
    // A's own person arrives; "Sam" was only typed on A (a placeholder) and stays there,
    // because Sam's device brings Sam's own person when it joins.
    const people = await b.profiles.persons();
    expect(people.map((x) => [x.displayName, x.isSelf, x.isPlaceholder])).toEqual([
      ['Alex', false, false],
    ]);
    expect((await a.profiles.get())?.displayName).toBe('Sam');

    const received = await b.milestones.get(trip.id);
    expect(received).toMatchObject({ title: 'First trip', eventDate: '2025-03-02', note: 'Ghent' });
    expect(received?.photoPath).toBeNull();
    expect(await b.milestones.rulesFor(trip.id)).toEqual([]); // partner dates arrive without reminders

    expect(server.all().find((r) => r.recordType === 'profile')?.recordId).toBe(PROFILE_RECORD_ID);
    for (const data of openAll(server)) {
      for (const local of [
        'calendar_time_zone_id',
        'photo_path',
        'is_self',
        'is_placeholder',
        'created_at',
        'updated_at',
        'id',
      ]) {
        expect(data).not.toHaveProperty(local);
      }
    }
    // Nothing received was echoed back into the outbox.
    expect(await b.store.outbox()).toEqual([]);
  });

  it('carries edits both ways and settles concurrent edits on the newest version', async () => {
    const { a, b, trip } = await pair();

    b.clock.set('2026-10-22T11:00:00Z');
    await b.milestones.update(trip.id, date({ title: 'Our first trip' }));
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.milestones.get(trip.id))?.title).toBe('Our first trip');
    expect(await a.milestones.rulesFor(trip.id)).toHaveLength(1); // A's own reminder is untouched

    // Concurrent edits: A edits first, B later; whoever syncs first, B's edit wins everywhere.
    a.clock.set('2026-10-22T12:00:00Z');
    await a.milestones.update(trip.id, date({ title: 'From A' }));
    b.clock.set('2026-10-22T12:00:05Z');
    await b.milestones.update(trip.id, date({ title: 'From B' }));
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.milestones.get(trip.id))?.title).toBe('From B');
    expect((await b.milestones.get(trip.id))?.title).toBe('From B');
    expect(await a.store.outbox()).toEqual([]);
    expect(await b.store.outbox()).toEqual([]);
  });

  it('notices when the server skipped a push as stale and takes the newer version', async () => {
    const server = new InMemoryTransport();
    let beforePush: (() => Promise<void>) | null = null;
    const racing: SyncTransport = {
      push: async (space, records) => {
        const hook = beforePush;
        beforePush = null;
        if (hook) await hook();
        await server.push(space, records);
      },
      versions: (space, keys) => server.versions(space, keys),
      pull: (space, after, limit) => server.pull(space, after, limit),
    };
    const a = await device(racing, 'Europe/Brussels');
    const b = await device(server, 'Europe/Brussels');
    await a.profiles.save(profile);
    const trip = await a.milestones.create(date());
    await a.join();
    await a.engine.sync();
    await b.store.joinSpace(SPACE, 1);
    await b.engine.sync();

    a.clock.set('2026-10-22T12:00:00Z');
    await a.milestones.update(trip.id, date({ title: 'From A' }));
    b.clock.set('2026-10-22T12:00:05Z');
    await b.milestones.update(trip.id, date({ title: 'From B' }));
    // B's newer edit reaches the server between A's pull and A's push.
    beforePush = async () => {
      await b.engine.sync();
    };
    const report = await a.engine.sync();

    expect(report.superseded).toBe(1);
    expect((await a.milestones.get(trip.id))?.title).toBe('From B');
    expect(await a.store.outbox()).toEqual([]);
  });

  it('moves dates to the trash and back on the other device', async () => {
    const { a, b, trip } = await pair();

    await a.milestones.delete(trip.id, { deleteLinkedMemories: false });
    await a.engine.sync();
    const report = await b.engine.sync();
    expect(report.changedTypes).toContain('milestone');
    expect(await b.milestones.get(trip.id)).toBeNull();
    expect((await b.trash.list()).map((t) => t.id)).toEqual([trip.id]);

    b.clock.set('2026-10-22T11:00:00Z');
    await b.trash.restoreMilestone(trip.id);
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.milestones.get(trip.id))?.title).toBe('First trip');
    expect(await a.trash.list()).toEqual([]);
  });

  it('orders a local edit after a received one even when this device clock is behind', async () => {
    const { a, b, trip } = await pair();
    b.clock.set('2026-10-22T09:00:00Z'); // an hour behind A's writes
    await b.milestones.update(trip.id, date({ title: 'Edited on a slow clock' }));
    const versions = await b.driver.query<{ version: string }>(
      'SELECT version FROM milestones WHERE id = ?',
      [trip.id],
    );
    const fromA = (
      await a.driver.query<{ version: string }>('SELECT version FROM milestones WHERE id = ?', [
        trip.id,
      ])
    )[0]!.version;
    expect(compareHlc(versions[0]!.version, fromA)).toBe(1);
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.milestones.get(trip.id))?.title).toBe('Edited on a slow clock');
  });

  it('rejects tampered, foreign and malformed records without stalling', async () => {
    const { server, a, b } = await pair();
    const before = (await b.store.state())!.cursor;
    const sealed = (
      data: unknown,
      overrides: Partial<WireRecord> = {},
      key = spaceKey,
    ): WireRecord => {
      const base = {
        recordType: 'milestone' as const,
        recordId: newId(),
        epoch: 1,
        version: '1793000000000-000000-0000beef',
        deleted: false,
        ...overrides,
      };
      const address = { spaceId: SPACE, ...base };
      return { ...base, ...crypto.encryptRecord(key, address, JSON.stringify(data)) };
    };
    const good = (await a.store.read('milestone', (await a.milestones.list())[0]!.id))!.payload;
    await server.push(SPACE, [
      sealed({ format: 1, data: good }, {}, crypto.newSpaceKey()), // wrong key
      sealed({ format: 1, data: { ...good, photo_path: 'x' } }), // a column that never syncs
      sealed({ format: 1, data: { ...good, title: '   ' } }), // blank title
      sealed({ format: 1, data: { ...good, category: 'travel' } }), // unknown category
      sealed({ format: 1, data: { ...good, event_date: '2025-02-30' } }), // impossible date
      sealed({ format: 1, data: { ...good, event_time_zone_id: 'Mars/Olympus' } }), // unknown zone
      sealed({ format: 1, data: { ...good, author_person_id: 'robert' } }), // author is not an ID
      sealed({ format: 1, data: { ...good, is_pinned: 'yes' } }), // wrong type
      sealed({ format: 2, data: good }), // a payload format this version does not know
      sealed({ format: 1, data: good }, { deleted: true }), // tombstone flag without deleted_at
      sealed({ format: 1, data: { relationship_label: 'x' } }, { recordType: 'profile' }), // profile under a foreign id
      sealed({ format: 1, data: { ...good, title: 'Still arrives' } }),
    ]);

    const report = await b.engine.sync();
    expect(report.rejected).toBe(11);
    expect(report.applied).toBe(1);
    expect((await b.milestones.list()).map((m) => m.title)).toContain('Still arrives');
    expect((await b.store.state())!.cursor).toBeGreaterThan(before);
  });

  it('still pulls a write that becomes visible behind the cursor', async () => {
    const { server, a, b } = await pair();
    const late = await a.milestones.create(date({ title: 'Committed late' }));
    const record = (await a.store.read('milestone', late.id))!;
    await a.store.acknowledge({ type: 'milestone', id: late.id, version: record.version });
    const address = {
      spaceId: SPACE,
      recordType: 'milestone',
      recordId: late.id,
      epoch: 1,
      version: record.version,
      deleted: false,
    };
    const wire: WireRecord = {
      recordType: 'milestone',
      recordId: late.id,
      epoch: 1,
      version: record.version,
      deleted: false,
      ...crypto.encryptRecord(
        spaceKey,
        address,
        JSON.stringify({ format: 1, data: record.payload }),
      ),
    };
    const seq = server.writeUncommitted(SPACE, wire);

    a.clock.set('2026-10-22T11:00:00Z');
    await a.profiles.save({ ...profile, relationshipLabel: 'Together' });
    await a.engine.sync(); // lands after the slow write, so B's cursor moves past it
    await b.engine.sync();
    expect((await b.store.state())!.cursor).toBeGreaterThan(seq);
    expect(await b.milestones.get(late.id)).toBeNull();

    server.commit(seq);
    await b.engine.sync();
    expect((await b.milestones.get(late.id))?.title).toBe('Committed late');
  });

  it('pulls everything again after an update, so records an older build refused arrive', async () => {
    const server = new InMemoryTransport();
    const a = await device(server, 'Europe/Brussels');
    // B runs an older build that knows only the profile and people.
    const b = await device(server, 'Europe/Brussels', {
      acceptedTypes: ['profile', 'person'],
      capability: 1,
    });
    await a.profiles.save(profile);
    const trip = await a.milestones.create(date());
    await a.join();
    await a.engine.sync();
    await b.store.joinSpace(SPACE, 1);
    expect((await b.engine.sync()).rejected).toBe(1);
    expect(await b.milestones.get(trip.id)).toBeNull();
    await b.engine.sync();
    expect(await b.milestones.get(trip.id)).toBeNull(); // still behind the cursor

    // B updates: the new build accepts dates and has a higher capability.
    const updated = new SyncEngine(
      b.store,
      server,
      crypto,
      keyring,
      () => ({ calendarTimeZoneId: 'Europe/Brussels' }),
      {
        capability: 2,
      },
    );
    const report = await updated.sync();
    expect(report.changedTypes).toEqual(['milestone']);
    expect((await b.milestones.get(trip.id))?.title).toBe('First trip');
    expect((await b.store.state())?.capability).toBe(2);
    const cursor = (await b.store.state())!.cursor;
    await updated.sync();
    expect((await b.store.state())!.cursor).toBe(cursor); // only once
  });

  it('refuses a remote tombstone for this device owner', async () => {
    const { server, b } = await pair();
    await b.profiles.save({ ...profile, selfName: 'Sam', displayName: null });
    const self = (await b.profiles.persons()).find((p) => p.isSelf)!;
    const base = {
      recordType: 'person' as const,
      recordId: self.id,
      epoch: 1,
      version: '1893456000000-000000-0000beef',
      deleted: true,
    };
    const data = { display_name: 'Sam', deleted_at: '2030-01-01T00:00:00Z' };
    const sealed = crypto.encryptRecord(
      spaceKey,
      { spaceId: SPACE, ...base },
      JSON.stringify({ format: 1, data }),
    );
    await server.push(SPACE, [{ ...base, ...sealed }]);

    expect((await b.engine.sync()).rejected).toBe(1);
    expect((await b.profiles.persons()).find((p) => p.isSelf)?.id).toBe(self.id);
    await expect(
      b.profiles.save({ ...profile, selfName: 'Sam R.', displayName: null }),
    ).resolves.toBeTruthy();
  });

  it('never uploads a placeholder partner', async () => {
    const { server, a } = await pair();
    const placeholder = (await a.profiles.persons()).find((p) => p.isPlaceholder)!;
    expect(placeholder.displayName).toBe('Sam');
    expect(server.all().map((r) => r.recordId)).not.toContain(placeholder.id);
    expect(await a.store.outbox()).toEqual([]);
  });

  it('keeps a record the server could not store local instead of blocking every push', async () => {
    const server = new InMemoryTransport();
    const a = await device(server, 'Europe/Brussels');
    await a.profiles.save(profile);
    const trip = await a.milestones.create(date());
    await a.driver.run(
      `INSERT INTO milestones (id, title, category, event_date, version, created_at, updated_at)
       VALUES ('legacy-1', 'Imported', 'custom', '2020-01-01', '0000000000000-000000-00000000', ?, ?)`,
      ['2026-10-22T10:00:00Z', '2026-10-22T10:00:00Z'],
    );
    await a.join();
    const report = await a.engine.sync();
    expect(report.unsendable).toBe(1);
    expect(report.pushed).toBe(3); // the profile, Alex and the trip (Sam is a placeholder)
    expect(server.all().map((r) => r.recordId)).toContain(trip.id);
    expect(await a.store.outbox()).toEqual([]);
  });
});
