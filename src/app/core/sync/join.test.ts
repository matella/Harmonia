import { beforeAll, describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import type { ValidMilestone, ValidProfile } from '../domain/validation';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { MilestoneRepository } from '../persistence/milestone.repository';
import { migrate } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { formatInviteCode, parseInviteCode } from './invite-code';
import { loadSyncCrypto, type SyncCrypto } from './sync-crypto-port';
import { SyncEngine, type SpaceKeyring } from './sync-engine';
import { SyncStore } from './sync-store';
import { InMemoryTransport } from './sync-transport';

/** The joiner's side of §6.2 on two sql.js devices (the server calls are tested live). */
const SPACE = '7d0c3b8e-1f2a-4c5d-9e6f-0a1b2c3d4e5f';

let crypto: SyncCrypto;
let keyring: SpaceKeyring;

beforeAll(async () => {
  crypto = await loadSyncCrypto();
  const key = crypto.newSpaceKey();
  keyring = { currentEpoch: () => 1, key: (e) => (e === 1 ? key : null) };
});

async function device(server: InMemoryTransport, zone: string) {
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
    engine: new SyncEngine(store, server, crypto, keyring, () => ({ calendarTimeZoneId: zone })),
  };
}

const alexProfile: ValidProfile = {
  displayName: 'Sam', // typed by Alex: a placeholder until Sam joins
  selfName: 'Alex',
  relationshipLabel: 'Us',
  startDate: '2024-06-14',
  startTime: '20:15',
  startTimeZoneId: 'Europe/Brussels',
  calendarTimeZoneId: 'Europe/Brussels',
};

const samProfile: ValidProfile = {
  displayName: 'Alexandre', // typed by Sam
  selfName: 'Sam',
  relationshipLabel: 'Together',
  startDate: '2024-06-15',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'America/Montreal',
};

const date = (title: string): ValidMilestone => ({
  title,
  category: 'custom',
  eventDate: '2025-03-02',
  eventTime: null,
  recurrence: 'none',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: false,
  reminders: [],
});

/** Alex shares first; Sam, who edited the profile later (a newer version), joins. */
async function setUp() {
  const server = new InMemoryTransport();
  const alex = await device(server, 'Europe/Brussels');
  const sam = await device(server, 'America/Montreal');
  await alex.profiles.save(alexProfile);
  await alex.milestones.create(date('Alex’s date'));
  await alex.store.joinSpace(SPACE, 1);
  await alex.engine.sync();

  sam.clock.set('2026-10-22T11:00:00Z');
  await sam.profiles.save(samProfile);
  const samsDate = await sam.milestones.create(date('Sam’s date'));
  const before = await sam.store.startOfRelationship();
  await sam.store.joinSpace(SPACE, 1, { queueProfile: false });
  await sam.engine.sync({ pullOnly: true, adoptProfile: true });
  return { server, alex, sam, samsDate, before: before! };
}

describe('joining a space with data of your own', () => {
  it('adopts the space’s profile even when the joiner’s own copy is newer', async () => {
    const { alex, sam, before } = await setUp();
    expect(before.startDate).toBe('2024-06-15');
    const adopted = await sam.profiles.get();
    expect(adopted).toMatchObject({
      startDate: '2024-06-14',
      startTime: '20:15',
      relationshipLabel: 'Us',
    });
    expect(adopted?.calendarTimeZoneId).toBe('America/Montreal'); // Sam keeps their own "today"
    expect((await sam.store.outbox()).map((e) => e.type)).not.toContain('profile');

    await sam.engine.sync();
    await alex.engine.sync();
    expect((await alex.profiles.get())?.startDate).toBe('2024-06-14');
    expect((await alex.profiles.get())?.relationshipLabel).toBe('Us');
  });

  it('keeps the joiner’s start when they choose it, everywhere, and merges both sets of dates', async () => {
    const { alex, sam, before } = await setUp();
    await sam.store.restampStart(before);
    await sam.engine.sync();
    await alex.engine.sync();
    for (const d of [alex, sam]) {
      expect(await d.profiles.get()).toMatchObject({
        startDate: '2024-06-15',
        startTime: null,
        relationshipLabel: 'Us', // the label stays the space's
      });
      expect((await d.milestones.list()).map((m) => m.title).sort()).toEqual([
        'Alex’s date',
        'Sam’s date',
      ]);
    }
  });

  it('replaces the names each side typed for the other with their own', async () => {
    const { alex, sam } = await setUp();
    await sam.engine.sync();
    await alex.engine.sync();
    const names = async (d: typeof alex) =>
      (await d.profiles.persons()).map((p) => [p.displayName, p.isSelf, p.isPlaceholder]);
    expect(await names(alex)).toEqual([
      ['Alex', true, false],
      ['Sam', false, false],
    ]);
    expect(await names(sam)).toEqual([
      ['Sam', true, false],
      ['Alex', false, false],
    ]);
    expect((await sam.profiles.get())?.displayName).toBe('Alex');
    expect(await alex.store.outbox()).toEqual([]);
  });

  it('goes back to solo on one device and keeps every record', async () => {
    const { sam } = await setUp();
    await sam.engine.sync();
    const datesBefore = (await sam.milestones.list()).length;
    await sam.store.leaveLocally();
    expect(await sam.store.state()).toBeNull();
    expect(await sam.store.outbox()).toEqual([]);
    expect((await sam.milestones.list()).length).toBe(datesBefore);
    await sam.milestones.create(date('Solo again'));
    expect(await sam.store.outbox()).toEqual([]); // solo writes queue nothing
  });
});

describe('invite codes', () => {
  const inviteId = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const secret = new Uint8Array(32).map((_, i) => i * 7);

  it('round-trips and is found inside a pasted message', () => {
    const code = formatInviteCode({ inviteId, secret });
    expect(code).toMatch(/^H1\.[A-Za-z0-9_-]{64}$/);
    expect(parseInviteCode(code)).toEqual({ inviteId, secret });
    expect(parseInviteCode(`Join me on Harmonia: ${code} (valid 24 h)`)).toEqual({
      inviteId,
      secret,
    });
  });

  it('refuses anything else', () => {
    const code = formatInviteCode({ inviteId, secret });
    for (const bad of ['', 'H1.', code.slice(0, -1), code + 'x', code.replace('H1.', 'H2.')]) {
      expect(parseInviteCode(bad)).toBeNull();
    }
  });
});
