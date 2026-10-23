import { describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { migrate } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { MemorySecureKeyStore } from '../platform/secure-key-store';
import { DeviceKeysUnavailableError, DeviceSession } from './device-session';
import { sha256, toBase64, toBytea } from './encoding';
import { Sharing, SharingEndedError } from './sharing';
import { loadSyncCrypto, type SyncCrypto } from './sync-crypto-port';
import { SyncStore } from './sync-store';

/** Parts of the sharing flow that need no server (the rest is tested live). */
const setUp = () => setUpWith({} as SyncCrypto);

async function setUpWith(crypto: SyncCrypto) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-23T10:00:00Z', 'Europe/Brussels');
  const journal = new ChangeJournal(clock);
  const secrets = new MemorySecureKeyStore();
  const offline = {
    connect: () => Promise.reject(new Error('the server must not be contacted')),
  } as unknown as DeviceSession;
  const sharing = new Sharing({
    store: new SyncStore(driver, clock, journal),
    profiles: new RelationshipRepository(driver, clock, newId, journal),
    session: offline,
    crypto,
    secrets,
    defaults: () => ({ calendarTimeZoneId: 'Europe/Brussels' }),
  });
  return { clock, secrets, sharing };
}

describe('sharing without a server', () => {
  it('forgets an invite older than 24 hours instead of waiting for it forever', async () => {
    const { clock, secrets, sharing } = await setUp();
    const invite = {
      inviteId: '0f1e2d3c-4b5a-4968-8776-655443322110',
      secret: toBase64(new Uint8Array(32)),
      createdAt: clock.now().epochMilliseconds,
    };
    await secrets.set('sharing.invite', JSON.stringify(invite));
    expect((await sharing.currentInvite())?.code).toMatch(/^H1\./);

    clock.set('2026-10-24T10:00:00Z');
    expect(await sharing.checkInvite()).toEqual({ state: 'gone' });
    expect(await sharing.currentInvite()).toBeNull();
    expect(await secrets.get('sharing.invite')).toBeNull();
  });

  it('reports the status from local state only', async () => {
    const { secrets, sharing } = await setUp();
    expect(await sharing.status()).toBe('off');
    await secrets.set('sharing.join', JSON.stringify({ inviteId: 'x', secret: 'y' }));
    expect(await sharing.status()).toBe('joining');
  });

  it('never replaces the device identity when its keys cannot be read (a locked iPhone)', async () => {
    const secrets = new MemorySecureKeyStore();
    await secrets.set('device.id', 'registered-device');
    await secrets.set('device.secret', 'c2VjcmV0');
    const session = new DeviceSession(secrets, {} as SyncCrypto, 'ios', () => {
      throw new Error('must not reach the server');
    });
    await expect(session.connect()).rejects.toBeInstanceOf(DeviceKeysUnavailableError);
    expect(await secrets.get('device.id')).toBe('registered-device');
    expect(await secrets.get('device.secret')).toBe('c2VjcmV0');
  });
});

/** A device that is a member of a space, talking to a scripted server. */
async function member(
  answers: Record<string, { data: unknown; error: unknown }>,
  crypto = {} as SyncCrypto,
) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-23T10:00:00Z', 'Europe/Brussels');
  const journal = new ChangeJournal(clock);
  const store = new SyncStore(driver, clock, journal);
  const profiles = new RelationshipRepository(driver, clock, newId, journal);
  await profiles.save({
    displayName: 'Sam',
    selfName: 'Alex',
    relationshipLabel: null,
    startDate: '2024-06-14',
    startTime: null,
    startTimeZoneId: null,
    calendarTimeZoneId: 'Europe/Brussels',
  });
  // Sam's own person, as received from the space.
  await driver.run(`UPDATE persons SET is_placeholder = 0 WHERE is_self = 0`);
  await store.joinSpace(SPACE_ID, 1);
  const calls: string[] = [];
  const client = {
    rpc: async (fn: string) => {
      calls.push(fn);
      return answers[fn] ?? { data: null, error: { message: 'unexpected call', code: 'X' } };
    },
  };
  const session = {
    connect: async () => ({ client, keys: {}, deviceId: 'device-1' }),
  } as unknown as DeviceSession;
  const secrets = new MemorySecureKeyStore();
  const sharing = new Sharing({
    store,
    profiles,
    session,
    crypto,
    secrets,
    defaults: () => ({ calendarTimeZoneId: 'Europe/Brussels' }),
  });
  return { store, profiles, sharing, calls, secrets };
}

const SPACE_ID = '7d0c3b8e-1f2a-4c5d-9e6f-0a1b2c3d4e5f';
const OFFLINE = { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } };
const membershipRow = (spaceId: string | null, revoked = false) => ({
  data: [{ device_id: 'device-1', revoked, space_id: spaceId, person_id: null, epoch: null }],
  error: null,
});

describe('leaving and noticing the end', () => {
  it('stays a member when leaving fails offline', async () => {
    const { store, sharing } = await member({ dissolve_space: OFFLINE });
    await expect(sharing.leave()).rejects.toMatchObject({ code: 'network' });
    expect(await store.state()).not.toBeNull();
  });

  it('goes solo when the server says the space is gone, keeping the partner as a local name', async () => {
    const { store, profiles, sharing } = await member({ membership: membershipRow(null) });
    await expect(sharing.sync()).rejects.toBeInstanceOf(SharingEndedError);
    expect(await store.state()).toBeNull();
    const people = await profiles.persons();
    expect(people.map((p) => [p.displayName, p.isSelf, p.isPlaceholder])).toEqual([
      ['Alex', true, false],
      ['Sam', false, true],
    ]);
    expect((await profiles.get())?.displayName).toBe('Sam'); // still "You and Sam"
  });

  it('also goes solo when this device was removed', async () => {
    const { store, sharing } = await member({ membership: membershipRow(SPACE_ID, true) });
    await expect(sharing.sync()).rejects.toBeInstanceOf(SharingEndedError);
    expect(await store.state()).toBeNull();
  });

  it('changes nothing without a definite answer', async () => {
    for (const answer of [OFFLINE, { data: [], error: null }]) {
      const { store, sharing } = await member({ membership: answer });
      await expect(sharing.sync()).rejects.not.toBeInstanceOf(SharingEndedError);
      expect(await store.state()).not.toBeNull();
    }
  });
});

describe('the recovery key, before the server', () => {
  it('changes nothing until the two groups typed back match', async () => {
    const { sharing, secrets, calls } = await member({}, await loadSyncCrypto());
    await expect(sharing.confirmRecoveryKey(['A', 'B'])).rejects.toMatchObject({
      code: 'noRecoveryKey',
    });
    const created = await sharing.createRecoveryKey();
    expect(created.groups).toHaveLength(8);
    expect(created.display).toBe(created.groups.join('-'));
    const [a, b] = created.ask;
    expect(a).toBeLessThan(b);
    const wrong = created.groups[a] === '00000' ? '11111' : '00000';
    await expect(sharing.confirmRecoveryKey([created.groups[a], wrong])).rejects.toMatchObject({
      code: 'recoveryMismatch',
    });
    expect(calls).toEqual([]);
    expect(await secrets.get('sharing.rotation')).toBeNull();
    expect(await sharing.recoveryStatus()).toBe('missing');
  });

  it('accepts the groups typed loosely (case, spaces, O for 0, I or L for 1)', async () => {
    const { sharing, calls } = await member({ membership: OFFLINE }, await loadSyncCrypto());
    const created = await sharing.createRecoveryKey();
    const [a, b] = created.ask;
    const loose = (group: string) =>
      ` ${group.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')} `;
    // Past the check, it needs the server: offline here.
    await expect(
      sharing.confirmRecoveryKey([loose(created.groups[a]), loose(created.groups[b])]),
    ).rejects.toMatchObject({ code: 'network' });
    expect(calls).toEqual(['membership']);
  });

  it('refuses a mistyped key before contacting the server', async () => {
    const crypto = await loadSyncCrypto();
    const local = await setUpWith(crypto);
    await expect(local.sharing.recover('K7QX2-ABCDE')).rejects.toMatchObject({
      code: 'invalidRecoveryKey',
    });
    const typo = crypto.generateRecoveryKey().display.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
    await expect(local.sharing.recover(typo)).rejects.toMatchObject({
      code: 'invalidRecoveryKey',
    });
    expect(await local.sharing.status()).toBe('off');
  });

  it('asks for a new key when the server seals to another one than this device knows', async () => {
    const mine = new Uint8Array(32).fill(7);
    const other = new Uint8Array(32).fill(8);
    const cases: [Uint8Array | null | 'offline', string][] = [
      [null, 'set'],
      [mine, 'set'], // only this epoch's envelope is missing: repair handles it
      [other, 'missing'],
      ['offline', 'set'],
    ];
    for (const [serverKey, expected] of cases) {
      const answers: Record<string, { data: unknown; error: unknown }> = {};
      const { sharing, store, profiles } = await member(answers);
      const self = (await profiles.persons()).find((p) => p.isSelf)!.id;
      await store.writeRecovery(self, toBase64(mine));
      answers['persons_missing_recovery_envelope'] =
        serverKey === 'offline'
          ? OFFLINE
          : {
              data: serverKey
                ? [{ person_id: self, public_key_hash: toBytea(await sha256(serverKey)) }]
                : [],
              error: null,
            };
      expect(await sharing.recoveryStatus()).toBe(expected);
    }
  });

  it('treats an interrupted recovery as not started, and syncs nothing meanwhile', async () => {
    const { sharing, secrets, calls } = await member({});
    await secrets.set('sharing.recover', JSON.stringify({ spaceId: SPACE_ID, personId: 'p' }));
    expect(await sharing.status()).toBe('off');
    await expect(sharing.sync()).rejects.toMatchObject({ code: 'joinInProgress' });
    expect(calls).toEqual([]);
  });
});
