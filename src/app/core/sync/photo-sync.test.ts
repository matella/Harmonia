import { beforeAll, describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import type { ValidMemory } from '../domain/validation';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { MemoryRepository } from '../persistence/memory.repository';
import { migrate } from '../persistence/migrations';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { PhotoSync, type PhotoFiles } from './photo-sync';
import { InMemoryPhotoTransport } from './photo-transport';
import { loadSyncCrypto, type SyncCrypto } from './sync-crypto-port';
import { SyncEngine, type SpaceKeyring } from './sync-engine';
import { SyncStore } from './sync-store';
import { InMemoryTransport } from './sync-transport';

/** Phase 5, slice 2 (docs/PARTNER_SYNC.md §18): encrypted photos between two devices. */
const SPACE = '7d0c3b8e-1f2a-4c5d-9e6f-0a1b2c3d4e5f';
const MiB = 1024 * 1024;

let crypto: SyncCrypto;
let keyring: SpaceKeyring;

beforeAll(async () => {
  crypto = await loadSyncCrypto();
  const key = crypto.newSpaceKey();
  keyring = { currentEpoch: () => 1, key: (epoch) => (epoch === 1 ? key : null) };
});

/** Photo files in memory; "not an image" is anything not starting with the JPEG marker. */
class Files implements PhotoFiles {
  readonly saved = new Map<string, Uint8Array>();
  constructor(readonly local = new Map<string, Uint8Array>()) {}
  async read(path: string): Promise<Uint8Array | null> {
    return this.local.get(path) ?? null;
  }
  async saveDownloaded(bytes: Uint8Array) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not an image');
    const id = newId();
    this.saved.set(`media/${id}.jpg`, bytes);
    return { filePath: `media/${id}.jpg`, thumbnailPath: `media/thumbs/${id}.jpg` };
  }
}

const jpeg = (size: number, seed = 1) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed) & 0xff;
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  return bytes;
};

const memory = (): ValidMemory => ({
  title: 'Ghent',
  body: null,
  memoryDate: '2025-03-02',
  milestoneId: null,
});

async function device(server: InMemoryTransport, photos: InMemoryPhotoTransport, files: Files) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-23T10:00:00Z', 'Europe/Brussels');
  const journal = new ChangeJournal(clock);
  const store = new SyncStore(driver, clock, journal);
  const engine = new SyncEngine(store, server, crypto, keyring, () => ({
    calendarTimeZoneId: 'Europe/Brussels',
  }));
  const photoSync = new PhotoSync(store, crypto, photos, files);
  return {
    driver,
    store,
    files,
    memories: new MemoryRepository(driver, clock, newId, journal),
    /** As Sharing.sync: photos up, records, then photos down. */
    sync: async () => {
      const up = await photoSync.upload(SPACE);
      const report = await engine.sync();
      return { ...report, ...up, downloaded: await photoSync.download(SPACE) };
    },
  };
}

async function pair(photos = new InMemoryPhotoTransport()) {
  const server = new InMemoryTransport();
  const a = await device(server, photos, new Files());
  const b = await device(server, photos, new Files());
  await a.store.joinSpace(SPACE, 1);
  await b.store.joinSpace(SPACE, 1);
  return { server, photos, a, b };
}

describe('photos between two devices', () => {
  it('sends a photo encrypted, before its record, and the other device keeps the same bytes', async () => {
    const { server, photos, a, b } = await pair();
    const original = jpeg(Math.round(2.5 * MiB)); // three parts
    a.files.local.set('media/1.jpg', original);
    const made = await a.memories.create(memory(), [
      { filePath: 'media/1.jpg', thumbnailPath: null },
    ]);

    const sent = await a.sync();
    expect(sent).toMatchObject({ uploaded: 1, waiting: 0, storageFull: false });
    expect([...photos.parts.keys()].map((k) => k.split('/')[2]).sort()).toEqual(['0', '1', '2']);
    // Only ciphertext on the server: no stored part contains a run of the photo.
    const probe = original.subarray(1000, 1064);
    for (const part of photos.parts.values()) {
      expect(Buffer.from(part).includes(Buffer.from(probe))).toBe(false);
    }
    expect(
      server
        .all()
        .map((r) => r.recordType)
        .sort(),
    ).toEqual(['memory', 'memory_media']);

    const got = await b.sync();
    expect(got.downloaded).toBe(1);
    expect(got.changedTypes).toContain('memory_media');
    const media = (await b.memories.get(made.id))?.media ?? [];
    expect(media).toHaveLength(1);
    expect(Buffer.from(b.files.saved.get(media[0].filePath)!).equals(Buffer.from(original))).toBe(
      true,
    );
    expect(media[0].thumbnailPath).toMatch(/^media\/thumbs\//);
    // Nothing is downloaded twice, and nothing goes back up.
    expect(await b.sync()).toMatchObject({ uploaded: 0, downloaded: 0, pushed: 0 });
  });

  it('starts an interrupted photo again and carries on with the rest', async () => {
    const { photos, a, b } = await pair();
    a.files.local.set('media/1.jpg', jpeg(Math.round(1.5 * MiB), 1));
    a.files.local.set('media/2.jpg', jpeg(1000, 2));
    await a.memories.create(memory(), [
      { filePath: 'media/1.jpg', thumbnailPath: null },
      { filePath: 'media/2.jpg', thumbnailPath: null },
    ]);
    photos.failNextUploadOfPart = 1; // the first photo stops after its first part
    expect(await a.sync()).toMatchObject({ uploaded: 1, waiting: 1 });
    expect((await b.sync()).downloaded).toBe(1); // only the complete photo was shared

    expect(await a.sync()).toMatchObject({ uploaded: 1, waiting: 0 });
    expect((await b.sync()).downloaded).toBe(1);
    expect(new Set([...b.files.saved.values()].map((x) => x.length))).toEqual(
      new Set([Math.round(1.5 * MiB), 1000]),
    );
    // The retry reused its reservation: 1.5 MiB + 1000 bytes in all.
    expect((await photos.usage()).used).toBe(Math.round(1.5 * MiB) + 1000);
  });

  it('keeps photos on this device when the space is full, and shares them once there is room', async () => {
    const photos = new InMemoryPhotoTransport();
    photos.limit = MiB;
    const { a, b } = await pair(photos);
    a.files.local.set('media/1.jpg', jpeg(900 * 1024, 1));
    a.files.local.set('media/2.jpg', jpeg(900 * 1024, 2));
    const made = await a.memories.create(memory(), [
      { filePath: 'media/1.jpg', thumbnailPath: null },
      { filePath: 'media/2.jpg', thumbnailPath: null },
    ]);
    expect(await a.sync()).toMatchObject({ uploaded: 1, waiting: 1, storageFull: true });
    await b.sync();
    expect((await b.memories.get(made.id))?.media).toHaveLength(1);
    expect((await a.memories.get(made.id))?.media).toHaveLength(2); // still all here

    photos.limit = 2 * MiB;
    expect(await a.sync()).toMatchObject({ uploaded: 1, storageFull: false });
    await b.sync();
    expect((await b.memories.get(made.id))?.media).toHaveLength(2);
  });

  it('never keeps a photo whose parts were changed, cut short or are not an image', async () => {
    const { photos, a, b } = await pair();
    a.files.local.set('media/1.jpg', jpeg(200 * 1024));
    const made = await a.memories.create(memory(), [
      { filePath: 'media/1.jpg', thumbnailPath: null },
    ]);
    await a.sync();
    const [key] = [...photos.parts.keys()];
    const good = photos.parts.get(key)!;

    const flipped = good.slice();
    flipped[100] ^= 1;
    photos.parts.set(key, flipped);
    expect((await b.sync()).downloaded).toBe(0);
    photos.parts.set(key, good.subarray(0, good.length - 1));
    expect((await b.sync()).downloaded).toBe(0);
    expect((await b.memories.get(made.id))?.media).toEqual([]);
    expect(b.files.saved.size).toBe(0);

    photos.parts.set(key, good); // the honest part again: it arrives
    expect((await b.sync()).downloaded).toBe(1);
  });
});
