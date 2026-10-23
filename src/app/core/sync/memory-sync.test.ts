import { beforeAll, describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import type { ValidMemory, ValidMilestone } from '../domain/validation';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { MemoryRepository } from '../persistence/memory.repository';
import { MilestoneRepository } from '../persistence/milestone.repository';
import { MIGRATIONS, migrate } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { TrashRepository } from '../persistence/trash.repository';
import { loadSyncCrypto, type SyncCrypto } from './sync-crypto-port';
import { SyncEngine, type SpaceKeyring, type SyncEngineOptions } from './sync-engine';
import { SyncStore } from './sync-store';
import { InMemoryTransport, type SyncTransport } from './sync-transport';

/** Phase 5, slice 1 (docs/PARTNER_SYNC.md §18): memories and their photo records. */
const SPACE = '7d0c3b8e-1f2a-4c5d-9e6f-0a1b2c3d4e5f';

let crypto: SyncCrypto;
let keyring: SpaceKeyring;

beforeAll(async () => {
  crypto = await loadSyncCrypto();
  const key = crypto.newSpaceKey();
  keyring = { currentEpoch: () => 1, key: (epoch) => (epoch === 1 ? key : null) };
});

async function device(transport: SyncTransport, options: SyncEngineOptions = {}) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-23T10:00:00Z', 'Europe/Brussels');
  const journal = new ChangeJournal(clock);
  const store = new SyncStore(driver, clock, journal);
  const engine = (more: SyncEngineOptions = {}) =>
    new SyncEngine(
      store,
      transport,
      crypto,
      keyring,
      () => ({ calendarTimeZoneId: 'Europe/Brussels' }),
      { ...options, ...more },
    );
  return {
    driver,
    clock,
    store,
    engine: engine(),
    withEngine: engine,
    memories: new MemoryRepository(driver, clock, newId, journal),
    milestones: new MilestoneRepository(driver, clock, newId, journal),
    profiles: new RelationshipRepository(driver, clock, newId, journal),
    trash: new TrashRepository(driver, clock, journal),
  };
}

const memory = (overrides: Partial<ValidMemory> = {}): ValidMemory => ({
  title: 'Ghent',
  body: 'Rain, then sun on the Graslei.',
  memoryDate: '2025-03-02',
  milestoneId: null,
  ...overrides,
});

const date = (): ValidMilestone => ({
  title: 'First trip',
  category: 'first_trip',
  eventDate: '2025-03-02',
  eventTime: null,
  recurrence: 'none',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: false,
  reminders: [],
});

const photo = (n: number) => ({
  filePath: `media/${n}.jpg`,
  thumbnailPath: `media/thumbs/${n}.jpg`,
});

/** What slice 2 does once a photo's encrypted file is on the server. */
async function markUploaded(driver: SqlJsDriver, mediaId: string) {
  await driver.run(
    `UPDATE memory_media SET blob_state = 'uploaded', blob_id = ?, blob_key = ?, blob_header = ?, blob_size = 1234
     WHERE id = ?`,
    [newId(), 'A'.repeat(43) + '=', 'B'.repeat(32), mediaId],
  );
}

describe('memories between two devices', () => {
  it('shares memories, and keeps photos on the phone until their file is uploaded', async () => {
    const server = new InMemoryTransport();
    const a = await device(server);
    const b = await device(server);
    const made = await a.memories.create(memory(), [photo(1), photo(2)]);
    await a.store.joinSpace(SPACE, 1);
    await a.engine.sync();
    expect(server.all().map((r) => r.recordType)).toEqual(['memory']);
    expect((await a.store.outbox()).length).toBe(0); // the photos wait outside the push

    await b.store.joinSpace(SPACE, 1);
    await b.engine.sync();
    const received = await b.memories.get(made.id);
    expect(received).toMatchObject({ title: 'Ghent', body: 'Rain, then sun on the Graslei.' });
    expect(received?.media).toEqual([]);

    // An edit on B comes back to A.
    await b.memories.update(made.id, memory({ title: 'Ghent, in March' }), {
      add: [],
      removeIds: [],
    });
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.memories.get(made.id))?.title).toBe('Ghent, in March');
    expect((await a.memories.get(made.id))?.media.map((m) => m.filePath)).toEqual([
      'media/1.jpg',
      'media/2.jpg',
    ]);
  });

  it('links everything even when children arrive before their memory or date', async () => {
    const server = new InMemoryTransport();
    const a = await device(server);
    await a.store.joinSpace(SPACE, 1);
    const trip = await a.milestones.create(date());
    const made = await a.memories.create(memory({ milestoneId: trip.id }), [photo(1)]);
    const mediaId = made.media[0].id;
    await a.engine.sync();
    // The photo's entry has been waiting in the outbox; once its file is up, it goes too.
    await markUploaded(a.driver, mediaId);
    await a.engine.sync();
    // The parents change again, so a full pull now delivers the photo and the memory
    // before the memory and the date they belong to.
    await a.memories.update(made.id, memory({ milestoneId: trip.id, title: 'Later title' }), {
      add: [],
      removeIds: [],
    });
    await a.milestones.update(trip.id, { ...date(), title: 'First trip abroad' });
    await a.engine.sync();
    expect(
      server
        .all()
        .sort((x, y) => x.seq - y.seq)
        .map((r) => r.recordType),
    ).toEqual(['memory_media', 'memory', 'milestone']);

    const c = await device(server);
    await c.store.joinSpace(SPACE, 1);
    expect((await c.engine.sync()).rejected).toBe(0);
    const received = await c.memories.get(made.id);
    expect(received?.milestoneId).toBe(trip.id);
    expect((await c.milestones.get(trip.id))?.title).toBe('First trip abroad');
    const rows = await c.driver.query(
      'SELECT memory_id, file_path, blob_state, blob_size FROM memory_media WHERE id = ?',
      [mediaId],
    );
    expect(rows).toEqual([
      { memory_id: made.id, file_path: null, blob_state: 'remote', blob_size: 1234 },
    ]);
    expect(received?.media).toEqual([]); // shown once downloaded (slice 2)
  });

  it('uploads the memories a sharing device made before it could sync them, once', async () => {
    const server = new InMemoryTransport();
    const a = await device(server);
    await a.store.joinSpace(SPACE, 1);
    const old = await a.memories.create(memory(), []);
    // As on a device that shared before this update: memories never queued, capability 3.
    await a.driver.run("DELETE FROM outbox WHERE record_type IN ('memory', 'memory_media')");
    await a.driver.run('UPDATE sync_state SET capability = 3');
    await a.engine.sync();
    expect(
      server
        .all()
        .filter((r) => r.recordType === 'memory')
        .map((r) => r.recordId),
    ).toEqual([old.id]);
    expect((await a.store.state())?.capability).toBe(4);
    await a.engine.sync();
    expect(server.all().filter((r) => r.recordType === 'memory')).toHaveLength(1);
  });

  it('never brings back to the trash what was deleted for good here', async () => {
    const server = new InMemoryTransport();
    const a = await device(server);
    const b = await device(server);
    const made = await a.memories.create(memory(), []);
    await a.store.joinSpace(SPACE, 1);
    await a.engine.sync();
    await b.store.joinSpace(SPACE, 1);
    await b.engine.sync();
    await a.memories.delete(made.id);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.trash.list()).map((t) => t.id)).toEqual([made.id]);

    await b.trash.deleteForever('memory', made.id);
    // A full pull (after an update) brings the same tombstone again: it stays gone.
    await b.driver.run('UPDATE sync_state SET capability = 3');
    await b.engine.sync();
    expect(await b.trash.list()).toEqual([]);

    // A newer version (the partner restores it) does come back.
    await a.trash.restoreMemory(made.id);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.memories.get(made.id))?.title).toBe('Ghent');
  });

  it('refuses memory and photo records the editors would refuse', async () => {
    const server = new InMemoryTransport();
    const a = await device(server);
    const b = await device(server);
    await a.store.joinSpace(SPACE, 1);
    const bad = await a.memories.create(memory(), []);
    await a.driver.run('UPDATE memories SET title = ? WHERE id = ?', ['x'.repeat(101), bad.id]);
    await a.engine.sync();
    await b.store.joinSpace(SPACE, 1);
    expect((await b.engine.sync()).rejected).toBe(1);
    expect(await b.memories.get(bad.id)).toBeNull();
  });
});

describe('schema 6', () => {
  it('keeps memories and photos and drops the links that refused out-of-order records', async () => {
    const driver = await SqlJsDriver.open();
    await migrate(driver, MIGRATIONS.slice(0, 5));
    await driver.run(
      `INSERT INTO memories (id, title, body, memory_date, created_at, updated_at) VALUES ('m1', 'T', 'B', '2025-01-01', 'x', 'x')`,
    );
    await driver.run(
      `INSERT INTO memory_media (id, memory_id, file_path, thumbnail_path, sort_order, created_at) VALUES ('p1', 'm1', 'media/1.jpg', NULL, 0, 'x')`,
    );
    await migrate(driver);
    expect(
      await driver.query('SELECT id, memory_id, file_path, blob_state FROM memory_media'),
    ).toEqual([{ id: 'p1', memory_id: 'm1', file_path: 'media/1.jpg', blob_state: 'local' }]);
    expect(await driver.query('SELECT id, title FROM memories')).toEqual([
      { id: 'm1', title: 'T' },
    ]);
    for (const table of ['memories', 'memory_media']) {
      expect(await driver.query(`PRAGMA foreign_key_list(${table})`), table).toEqual([]);
    }
    // A photo row before its memory, and a memory before its date, are accepted now.
    await driver.run(
      `INSERT INTO memory_media (id, memory_id, sort_order, created_at, blob_state) VALUES ('p2', 'later', 0, 'x', 'remote')`,
    );
    await driver.run(
      `INSERT INTO memories (id, milestone_id, memory_date, created_at, updated_at) VALUES ('m2', 'not-yet', '2025-01-01', 'x', 'x')`,
    );
  });
});
