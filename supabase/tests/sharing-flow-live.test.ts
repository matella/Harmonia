import { execSync } from 'node:child_process';

import { createClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

import { MutableClock } from '../../src/app/core/domain/clock';
import type { ValidMilestone, ValidProfile } from '../../src/app/core/domain/validation';
import { ChangeJournal } from '../../src/app/core/persistence/change-journal';
import { newId } from '../../src/app/core/persistence/ids';
import { MilestoneRepository } from '../../src/app/core/persistence/milestone.repository';
import { migrate } from '../../src/app/core/persistence/migrations';
import { RelationshipRepository } from '../../src/app/core/persistence/relationship.repository';
import { SqlJsDriver } from '../../src/app/core/persistence/sqljs-driver';
import { MemorySecureKeyStore } from '../../src/app/core/platform/secure-key-store';
import { DeviceSession, type AuthStorage } from '../../src/app/core/sync/device-session';
import { toBase64, toBytea } from '../../src/app/core/sync/encoding';
import { Sharing } from '../../src/app/core/sync/sharing';
import { SpaceApi } from '../../src/app/core/sync/space-api';
import { envelopeMessage, MissingSpaceKeyError } from '../../src/app/core/sync/space-keys';
import { loadSyncCrypto, type SyncCrypto } from '../../src/app/core/sync/sync-crypto-port';
import { SyncStore } from '../../src/app/core/sync/sync-store';

/**
 * Slice 3a end to end on a running local Supabase stack (`bunx supabase start`):
 * start sharing, invite, claim, compare safety codes, approve, join with existing data.
 * Run with: SUPABASE_LIVE=1 bunx vitest run supabase/tests/sharing-flow-live.test.ts
 */
const live = process.env['SUPABASE_LIVE'] === '1';

let crypto: SyncCrypto;

/** Runs SQL as the database owner (like the server operator) in the Supabase container. */
function psql(sql: string): string {
  return execSync('docker exec -i supabase_db_Harmonia psql -U postgres -At -v ON_ERROR_STOP=1', {
    input: sql,
    encoding: 'utf-8',
  }).trim();
}
let stack: { url: string; key: string };
const dissolve: (() => Promise<unknown>)[] = [];

function localStack(): { url: string; key: string } {
  const status = JSON.parse(
    execSync('bunx supabase status -o json', { encoding: 'utf-8' }),
  ) as Record<string, string>;
  return { url: status['API_URL'], key: status['PUBLISHABLE_KEY'] ?? status['ANON_KEY'] };
}

const profile = (overrides: Partial<ValidProfile>): ValidProfile => ({
  displayName: null,
  selfName: null,
  relationshipLabel: null,
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
  ...overrides,
});

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

async function phone(zone = 'Europe/Brussels', secrets = new MemorySecureKeyStore()) {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock(new Date().toISOString(), zone);
  const journal = new ChangeJournal(clock);
  const store = new SyncStore(driver, clock, journal);
  const profiles = new RelationshipRepository(driver, clock, newId, journal);
  const milestones = new MilestoneRepository(driver, clock, newId, journal);
  const session = new DeviceSession(secrets, crypto, 'android', (storage: AuthStorage) =>
    createClient(stack.url, stack.key, {
      auth: {
        storage,
        storageKey: 'session',
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    }),
  );
  const sharing = new Sharing({
    store,
    profiles,
    session,
    crypto,
    secrets,
    defaults: () => ({ calendarTimeZoneId: zone }),
  });
  dissolve.push(async () => {
    if (await store.state()) await (await session.connect()).client.rpc('dissolve_space');
  });
  return { driver, clock, store, profiles, milestones, secrets, session, sharing };
}

/** A secure store whose write of the start-date question can fail once. */
class FlakySecrets extends MemorySecureKeyStore {
  failNextChoose = false;

  override async set(name: string, value: string): Promise<void> {
    if (this.failNextChoose && name === 'sharing.join' && value.includes('"choose"')) {
      this.failNextChoose = false;
      throw new Error('stopped');
    }
    await super.set(name, value);
  }
}

describe.skipIf(!live)('sharing flow over a live local Supabase', () => {
  beforeAll(async () => {
    crypto = await loadSyncCrypto();
    stack = localStack();
  });

  it('invites, compares safety codes, approves and merges both phones', async () => {
    const alex = await phone();
    const samSecrets = new FlakySecrets();
    const sam = await phone('America/Montreal', samSecrets);
    await alex.profiles.save(profile({ displayName: 'Sam', relationshipLabel: 'Us' }));
    await alex.milestones.create(date('Alex’s date'));
    await sam.profiles.save(profile({ displayName: 'Alexandre', startDate: '2024-06-15' }));
    await sam.milestones.create(date('Sam’s date'));

    await expect(alex.sharing.startSharing('  ')).rejects.toMatchObject({ code: 'nameRequired' });
    await alex.sharing.startSharing('Alex');
    expect(await alex.sharing.status()).toBe('member');
    const code = await alex.sharing.createInvite();
    expect(await alex.sharing.currentInviteCode()).toBe(code);
    expect(await alex.sharing.checkInvite()).toEqual({ state: 'waiting' });

    await expect(sam.sharing.claim('no code here', 'Sam')).rejects.toMatchObject({
      code: 'invalidCode',
    });
    const samCode = await sam.sharing.claim(`Join me on Harmonia: ${code}`, 'Sam');
    expect(samCode).toMatch(/^\d{6}$/);
    expect(await sam.sharing.status()).toBe('joining');
    expect(await alex.sharing.checkInvite()).toEqual({ state: 'claimed', safetyCode: samCode });
    expect(await sam.sharing.checkJoin()).toEqual({ state: 'waiting', safetyCode: samCode });

    await alex.sharing.approveInvite();
    // The write that records the date question fails once, as if the app stopped there.
    samSecrets.failNextChoose = true;
    await expect(sam.sharing.checkJoin()).rejects.toThrow(/stopped/);
    const choice = await sam.sharing.checkJoin();
    expect(choice).toMatchObject({
      state: 'chooseStart',
      space: { startDate: '2024-06-14' },
      mine: { startDate: '2024-06-15' },
    });
    // Asked again after a restart, the same question comes back without the server.
    expect(await sam.sharing.checkJoin()).toEqual(choice);
    await expect(sam.sharing.sync()).rejects.toMatchObject({ code: 'joinInProgress' });
    expect(await sam.sharing.chooseStart('space')).toEqual({ state: 'joined' });
    expect(await sam.sharing.status()).toBe('member');

    await alex.sharing.sync();
    for (const p of [alex, sam]) {
      expect((await p.milestones.list()).map((m) => m.title).sort()).toEqual([
        'Alex’s date',
        'Sam’s date',
      ]);
      expect((await p.profiles.get())?.startDate).toBe('2024-06-14');
    }
    expect((await alex.profiles.get())?.displayName).toBe('Sam');
    expect((await sam.profiles.get())?.displayName).toBe('Alex');
    expect((await sam.profiles.get())?.relationshipLabel).toBe('Us');
    expect((await alex.profiles.persons()).some((p) => p.isPlaceholder)).toBe(false);
    expect((await sam.profiles.persons()).some((p) => p.isPlaceholder)).toBe(false);

    // Sam's phone loses its space key: it reopens its own sealed copy from the server.
    const state = (await sam.store.state())!;
    await sam.secrets.remove(`space.${state.spaceId}.${state.epoch}`);
    expect(await sam.sharing.status()).toBe('memberWithoutKey');
    sam.clock.set(new Date(Date.now() + 1000).toISOString());
    await sam.milestones.create(date('After losing the key'));
    expect((await sam.sharing.sync()).pushed).toBe(1);
    expect(await sam.sharing.status()).toBe('member');
    await alex.sharing.sync();
    expect((await alex.milestones.list()).map((m) => m.title)).toContain('After losing the key');
  });

  it('lets the inviter decline, which ends the join on the other phone', async () => {
    const alex = await phone();
    const eve = await phone();
    await alex.profiles.save(profile({}));
    await eve.profiles.save(profile({}));
    await alex.sharing.startSharing('Alex');
    const code = await alex.sharing.createInvite();
    await eve.sharing.claim(code, 'Eve');
    await alex.sharing.declineInvite();
    expect(await eve.sharing.checkJoin()).toEqual({ state: 'gone' });
    expect(await eve.sharing.status()).toBe('off');
    expect(await alex.sharing.checkInvite()).toEqual({ state: 'gone' });
  });

  it('finishes turning sharing on after a crash right after the server created the space', async () => {
    const kim = await phone();
    await kim.profiles.save(profile({ selfName: 'Kim' }));
    const device = await kim.session.connect({ createKeys: true });
    const key = crypto.newSpaceKey();
    const spaceId = newId();
    await kim.secrets.set('sharing.pendingKey', JSON.stringify({ spaceId, key: toBase64(key) }));
    const self = (await kim.profiles.persons()).find((p) => p.isSelf)!;
    const sealed = crypto.sealSpaceKey(key, device.keys.boxPublicKey);
    const created = await new SpaceApi(device.client).createSpace(
      spaceId,
      sealed,
      crypto.sign(envelopeMessage(spaceId, 1, device.deviceId, sealed), device.keys),
      self.id,
    );
    expect(created.spaceId).toBe(spaceId);

    await kim.sharing.startSharing('Kim'); // the retry
    expect((await kim.store.state())?.spaceId).toBe(created.spaceId);
    expect(await kim.secrets.get('sharing.pendingKey')).toBeNull();
    expect(await kim.sharing.status()).toBe('member');
  });

  it('rejoins its old space with the same key when sharing again after going solo here', async () => {
    const lee = await phone();
    await lee.profiles.save(profile({}));
    await lee.sharing.startSharing('Lee');
    const state = (await lee.store.state())!;
    const key = await lee.secrets.get(`space.${state.spaceId}.${state.epoch}`);
    await lee.sharing.stopSharingHere();
    expect(await lee.sharing.status()).toBe('off');

    await lee.sharing.startSharing('Lee');
    const again = (await lee.store.state())!;
    expect(again.spaceId).toBe(state.spaceId);
    expect(await lee.secrets.get(`space.${again.spaceId}.${again.epoch}`)).toBe(key);
    await lee.milestones.create(date('Still readable'));
    expect((await lee.sharing.sync()).rejected).toBe(0);
  });

  it('never takes a key the server planted for a device that lost its own', async () => {
    const ann = await phone();
    await ann.profiles.save(profile({}));
    await ann.sharing.startSharing('Ann');
    const state = (await ann.store.state())!;
    const device = await ann.session.connect();

    // The server (which can write any row) replaces Ann's envelope with a key it knows,
    // first unsigned, then signed with a key that is not Ann's.
    const planted = crypto.sealSpaceKey(crypto.newSpaceKey(), device.keys.boxPublicKey);
    const stranger = crypto.generateDeviceKeys();
    const forgedSignature = crypto.sign(
      envelopeMessage(state.spaceId, 1, device.deviceId, planted),
      stranger,
    );
    for (const signature of ['null', `'${toBytea(forgedSignature)}'`]) {
      psql(
        `update key_envelopes set sealed = '${toBytea(planted)}', signature = ${signature}
         where device_id = '${device.deviceId}';`,
      );
      await ann.secrets.remove(`space.${state.spaceId}.${state.epoch}`);
      await expect(ann.sharing.sync()).rejects.toBeInstanceOf(MissingSpaceKeyError);
      expect(await ann.sharing.status()).toBe('memberWithoutKey');
    }
  });

  it('cleans up', async () => {
    for (const fn of dissolve) await fn();
  });
});
