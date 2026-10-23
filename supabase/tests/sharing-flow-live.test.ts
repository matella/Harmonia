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
import { fromBase64, toBase64, toBytea } from '../../src/app/core/sync/encoding';
import { Sharing, SharingEndedError } from '../../src/app/core/sync/sharing';
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
    expect(await alex.sharing.currentInvite()).toEqual({ code, forMe: false });
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

    // The end-to-end device list: each device wrote its own record with its own keys.
    const alexDevice = await alex.session.connect();
    const samDevice = await sam.session.connect();
    const expected = [alexDevice, samDevice]
      .map((d) => ({
        id: d.deviceId,
        signPublicKey: toBase64(d.keys.signPublicKey),
        boxPublicKey: toBase64(d.keys.boxPublicKey),
        platform: 'android',
        revokedAt: null,
      }))
      .sort((x, y) => x.id.localeCompare(y.id));
    for (const p of [alex, sam]) {
      const listed = (await p.store.devices())
        .map(({ personId: _person, ...rest }) => rest)
        .sort((x, y) => x.id.localeCompare(y.id));
      expect(listed).toEqual(expected);
    }
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

  it('leaves for both: each keeps everything, the server copy is gone, the ex stays out of a new space', async () => {
    type Phone = Awaited<ReturnType<typeof phone>>;
    const pair = async (inviter: Phone, joiner: Phone, joinerName: string) => {
      const code = await inviter.sharing.createInvite();
      await joiner.sharing.claim(code, joinerName);
      await inviter.sharing.approveInvite();
      let progress = await joiner.sharing.checkJoin();
      if (progress.state === 'chooseStart') progress = await joiner.sharing.chooseStart('space');
      expect(progress).toEqual({ state: 'joined' });
      await inviter.sharing.sync();
    };
    const alex = await phone();
    const sam = await phone();
    await alex.profiles.save(profile({}));
    await sam.profiles.save(profile({}));
    await alex.milestones.create(date('Alex’s date'));
    await sam.milestones.create(date('Sam’s date'));
    await alex.sharing.startSharing('Alex');
    await pair(alex, sam, 'Sam');
    const space = (await alex.store.state())!.spaceId;

    await alex.sharing.leave();
    expect(await alex.sharing.status()).toBe('off');
    expect(psql(`select count(*) from records where space_id = '${space}'`)).toBe('0');
    expect(psql(`select count(*) from spaces where id = '${space}'`)).toBe('0');

    await expect(sam.sharing.sync()).rejects.toBeInstanceOf(SharingEndedError);
    expect(await sam.sharing.status()).toBe('off');
    for (const p of [alex, sam]) {
      expect((await p.milestones.list()).map((m) => m.title).sort()).toEqual([
        'Alex’s date',
        'Sam’s date',
      ]);
    }
    expect((await sam.profiles.get())?.displayName).toBe('Alex'); // still shown on Sam's phone
    expect((await sam.profiles.persons()).find((p) => !p.isSelf)?.isPlaceholder).toBe(true);

    // Sam shares again, with Kim: a new space, and Alex's name never reaches it.
    const kim = await phone();
    await kim.profiles.save(profile({}));
    await sam.sharing.startSharing('Sam');
    expect((await sam.store.state())!.spaceId).not.toBe(space);
    await pair(sam, kim, 'Kim');
    expect((await kim.profiles.persons()).map((p) => p.displayName).sort()).toEqual(['Kim', 'Sam']);
    expect((await sam.profiles.get())?.displayName).toBe('Kim');
  });

  it('adds one of my devices: same person, no start-date question, both listed', async () => {
    const phoneA = await phone();
    const tablet = await phone();
    await phoneA.profiles.save(profile({ displayName: 'Sam' }));
    await tablet.profiles.save(profile({ startDate: '2025-01-01' })); // differs: must not ask
    await tablet.milestones.create(date('From the tablet'));
    await phoneA.sharing.startSharing('Alex');

    const code = await phoneA.sharing.createInvite({ forMe: true });
    expect(await phoneA.sharing.currentInvite()).toEqual({ code, forMe: true });
    const tabletCode = await tablet.sharing.claim(code, 'Alex');
    expect(await phoneA.sharing.checkInvite()).toEqual({
      state: 'claimed',
      safetyCode: tabletCode,
    });
    await phoneA.sharing.approveInvite();
    expect(await tablet.sharing.checkJoin()).toEqual({ state: 'joined', ownDevice: true });
    await phoneA.sharing.sync();

    const self = async (p: Awaited<ReturnType<typeof phone>>) =>
      (await p.profiles.persons()).find((x) => x.isSelf)!;
    expect((await self(tablet)).id).toBe((await self(phoneA)).id);
    expect((await self(tablet)).displayName).toBe('Alex');
    expect((await tablet.profiles.get())?.startDate).toBe('2024-06-14');
    expect((await phoneA.milestones.list()).map((m) => m.title)).toContain('From the tablet');
    const devices = await phoneA.store.devices();
    expect(devices).toHaveLength(2);
    expect(new Set(devices.map((d) => d.personId))).toEqual(new Set([(await self(phoneA)).id]));
  });

  it('removes one of my devices: a new key reaches the others, the removed one can read nothing new', async () => {
    type Phone = Awaited<ReturnType<typeof phone>>;
    const join = async (inviter: Phone, joiner: Phone, name: string, forMe: boolean) => {
      const code = await inviter.sharing.createInvite({ forMe });
      await joiner.sharing.claim(code, name);
      await inviter.sharing.approveInvite();
      let progress = await joiner.sharing.checkJoin();
      if (progress.state === 'chooseStart') progress = await joiner.sharing.chooseStart('space');
      expect(progress.state).toBe('joined');
      await inviter.sharing.sync();
    };
    const alexPhone = await phone();
    const alexTablet = await phone();
    const sam = await phone();
    for (const p of [alexPhone, alexTablet, sam]) await p.profiles.save(profile({}));
    await alexPhone.milestones.create(date('Before the removal'));
    await alexPhone.sharing.startSharing('Alex');
    await join(alexPhone, alexTablet, 'Alex', true);
    await join(alexPhone, sam, 'Sam', false);
    await alexTablet.sharing.sync();
    const space = (await alexPhone.store.state())!.spaceId;
    const tablet = await alexTablet.session.connect();

    const mine = await alexPhone.sharing.myDevices();
    expect(mine.map((d) => d.thisDevice)).toEqual([true, false]);
    expect(mine[1].id).toBe(tablet.deviceId);
    await alexPhone.sharing.removeDevice(tablet.deviceId);
    expect((await alexPhone.store.state())!.epoch).toBe(2);
    expect((await alexPhone.sharing.myDevices()).map((d) => d.id)).not.toContain(tablet.deviceId);

    // Before Sam has synced, the server swaps Sam's envelope for a key the removed tablet
    // chose and signed. Sam learns of the removal first (it was written under the old
    // key), so it refuses the tablet's key.
    const samDevice = await sam.session.connect();
    const honest = psql(
      `select translate(encode(sealed, 'base64'), E'\n', '') || ' ' || translate(encode(signature, 'base64'), E'\n', '') || ' ' || signer_device_id
       from key_envelopes where device_id = '${samDevice.deviceId}' and epoch = 2`,
    )
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ');
    const chosen = crypto.sealSpaceKey(crypto.newSpaceKey(), samDevice.keys.boxPublicKey);
    const tabletSigned = crypto.sign(
      envelopeMessage(space, 2, samDevice.deviceId, chosen),
      tablet.keys,
    );
    const setEnvelope = (sealed: string, signature: string, signer: string) =>
      psql(`update key_envelopes set sealed = decode('${sealed}', 'base64'), signature = decode('${signature}', 'base64'),
             signer_device_id = '${signer}' where device_id = '${samDevice.deviceId}' and epoch = 2;`);
    setEnvelope(toBase64(chosen), toBase64(tabletSigned), tablet.deviceId);
    await expect(sam.sharing.sync()).rejects.toMatchObject({ code: 'newKeyNotTrusted' });
    expect((await sam.store.state())!.epoch).toBe(1);
    expect(
      (await sam.store.devices()).find((d) => d.id === tablet.deviceId)?.revokedAt,
    ).not.toBeNull();
    setEnvelope(honest[0], honest[1], honest[2]);

    // Sam takes the new key from the envelope Alex's phone sealed and signed.
    await sam.sharing.sync();
    expect((await sam.store.state())!.epoch).toBe(2);
    await sam.milestones.create(date('After the removal'));
    await sam.sharing.sync();
    await alexPhone.sharing.sync();
    expect((await alexPhone.milestones.list()).map((m) => m.title)).toContain('After the removal');

    // The tablet learns it was removed, goes solo and keeps what it had.
    await expect(alexTablet.sharing.sync()).rejects.toMatchObject({ reason: 'removed' });
    expect(await alexTablet.sharing.status()).toBe('off');
    expect((await alexTablet.milestones.list()).map((m) => m.title)).toContain(
      'Before the removal',
    );

    // Read as the database owner: the new record is under epoch 2, and the tablet's key
    // (epoch 1) can't decrypt it. The new key can.
    const row = psql(
      `select record_id || ' ' || version || ' ' || encode(nonce, 'base64') || ' ' || encode(ciphertext, 'base64')
       from records where space_id = '${space}' and epoch = 2 and record_type = 'milestone'`,
    ).replace(/\n/g, '');
    const [recordId, recordVersion, nonce, ciphertext] = row.split(' ');
    const address = {
      spaceId: space,
      recordType: 'milestone',
      recordId,
      epoch: 2,
      version: recordVersion,
      deleted: false,
    };
    const sealed = { nonce: fromBase64(nonce), ciphertext: fromBase64(ciphertext) };
    const tabletKey = fromBase64(
      (await alexTablet.secrets.get(`space.${space}.1`)) ?? toBase64(new Uint8Array(32)),
    );
    expect(() => crypto.decryptRecord(tabletKey, address, sealed)).toThrow();
    const newKey = fromBase64((await sam.secrets.get(`space.${space}.2`))!);
    expect(JSON.parse(crypto.decryptRecord(newKey, address, sealed)).data.title).toBe(
      'After the removal',
    );

    // A device added after the removal reads history too (the invite carries every key).
    const alexNewPhone = await phone();
    await alexNewPhone.profiles.save(profile({}));
    await join(alexPhone, alexNewPhone, 'Alex', true);
    expect((await alexNewPhone.milestones.list()).map((m) => m.title).sort()).toEqual([
      'After the removal',
      'Before the removal',
    ]);

    // A removal of mine interrupted while another device's removal won is not taken as
    // done (only a key this device created proves that), and it is not dropped either:
    // it is finished from the new epoch.
    const samTablet = await phone();
    await samTablet.profiles.save(profile({}));
    await join(sam, samTablet, 'Sam', true);
    await alexPhone.sharing.sync();
    const newPhone = await alexNewPhone.session.connect();
    await alexPhone.secrets.set(
      'sharing.rotation',
      JSON.stringify({ from: 2, target: newPhone.deviceId, key: toBase64(crypto.newSpaceKey()) }),
    );
    await sam.sharing.removeDevice((await samTablet.session.connect()).deviceId);
    await alexPhone.sharing.sync();
    expect((await alexPhone.store.state())!.epoch).toBe(4); // Sam's 3, then Alex's own 4
    expect(await alexPhone.secrets.get('sharing.rotation')).toBeNull();
    expect(
      (await alexPhone.store.devices()).find((d) => d.id === newPhone.deviceId)?.revokedAt,
    ).not.toBeNull();

    // A key planted by the server and signed by the removed tablet is never adopted.
    const planted = crypto.sealSpaceKey(crypto.newSpaceKey(), samDevice.keys.boxPublicKey);
    const tabletSignature = crypto.sign(
      envelopeMessage(space, 5, samDevice.deviceId, planted),
      tablet.keys,
    );
    psql(`update spaces set epoch = 5 where id = '${space}';
      insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values ('${space}', 5, '${samDevice.deviceId}', decode('${toBase64(planted)}', 'base64'),
              decode('${toBase64(tabletSignature)}', 'base64'), '${tablet.deviceId}');`);
    await expect(sam.sharing.sync()).rejects.toMatchObject({ code: 'newKeyNotTrusted' });
    expect((await sam.store.state())!.epoch).toBe(3);
  });

  it('resumes a removal whose key change failed, and shows it as pending meanwhile', async () => {
    const alexPhone = await phone();
    const alexTablet = await phone();
    for (const p of [alexPhone, alexTablet]) await p.profiles.save(profile({}));
    await alexPhone.sharing.startSharing('Alex');
    const code = await alexPhone.sharing.createInvite({ forMe: true });
    await alexTablet.sharing.claim(code, 'Alex');
    await alexPhone.sharing.approveInvite();
    expect((await alexTablet.sharing.checkJoin()).state).toBe('joined');
    await alexPhone.sharing.sync();
    const tablet = await alexTablet.session.connect();

    // The server can't rotate for a moment (as if offline right after the removal record).
    psql('alter function public.rotate(uuid, integer, jsonb) rename to rotate_paused;');
    try {
      await expect(alexPhone.sharing.removeDevice(tablet.deviceId)).rejects.toMatchObject({
        code: 'removalPending',
      });
      expect(await alexPhone.sharing.myDevices()).toEqual([
        expect.objectContaining({ thisDevice: true, pendingRemoval: false }),
        expect.objectContaining({ id: tablet.deviceId, pendingRemoval: true }),
      ]);
      expect((await alexPhone.store.state())!.epoch).toBe(1);
    } finally {
      psql('alter function public.rotate_paused(uuid, integer, jsonb) rename to rotate;');
    }

    // The next sync finishes it: new epoch, the tablet is out and learns it.
    await alexPhone.sharing.sync();
    expect((await alexPhone.store.state())!.epoch).toBe(2);
    expect((await alexPhone.sharing.myDevices()).map((d) => d.id)).not.toContain(tablet.deviceId);
    expect(await alexPhone.secrets.get('sharing.rotation')).toBeNull();
    await expect(alexTablet.sharing.sync()).rejects.toMatchObject({ reason: 'removed' });
  });

  it('cleans up', async () => {
    for (const fn of dissolve) await fn();
  });
});
