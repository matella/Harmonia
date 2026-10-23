import { execSync, spawn } from 'node:child_process';

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
import {
  DeviceLostError,
  DeviceSession,
  type AuthStorage,
} from '../../src/app/core/sync/device-session';
import {
  fromBase64,
  fromBytea,
  randomBytes,
  sha256,
  toBase64,
  toBytea,
} from '../../src/app/core/sync/encoding';
import { SupabaseTransport } from '../../src/app/core/sync/supabase-transport';
import { loadSyncCrypto, type SyncCrypto } from '../../src/app/core/sync/sync-crypto-port';
import { SyncEngine } from '../../src/app/core/sync/sync-engine';
import { SyncStore } from '../../src/app/core/sync/sync-store';

/**
 * Phase 2 slice 2 end to end on a running local Supabase stack (`bunx supabase start`):
 * two devices with their own anonymous sessions sync encrypted records through PostgREST.
 * Run with: SUPABASE_LIVE=1 bunx vitest run supabase/tests/sync-live.test.ts
 */
const live = process.env['SUPABASE_LIVE'] === '1';
const DB_CONTAINER = 'supabase_db_Harmonia';

function localStack(): { url: string; key: string } {
  const status = JSON.parse(
    execSync('bunx supabase status -o json', { encoding: 'utf-8' }),
  ) as Record<string, string>;
  return { url: status['API_URL'], key: status['PUBLISHABLE_KEY'] ?? status['ANON_KEY'] };
}

const profile: ValidProfile = {
  displayName: null,
  selfName: 'Alex',
  relationshipLabel: 'Us',
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
};

const date: ValidMilestone = {
  title: 'First trip',
  category: 'first_trip',
  eventDate: '2025-03-02',
  eventTime: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: false,
  reminders: [],
};

let crypto: SyncCrypto;
let stack: { url: string; key: string };

function sessionFor(secrets: MemorySecureKeyStore) {
  return new DeviceSession(secrets, crypto, 'android', (storage: AuthStorage) =>
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
}

async function localDevice() {
  const driver = await SqlJsDriver.open();
  await migrate(driver);
  const clock = new MutableClock('2026-10-22T10:00:00Z', 'Europe/Brussels');
  const journal = new ChangeJournal(clock);
  return {
    clock,
    store: new SyncStore(driver, clock, journal),
    profiles: new RelationshipRepository(driver, clock, newId, journal),
    milestones: new MilestoneRepository(driver, clock, newId, journal),
  };
}

/** Runs SQL as the database owner inside the Supabase Postgres container. */
function psql(sql: string): string {
  return execSync(`docker exec -i ${DB_CONTAINER} psql -U postgres -At -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: 'utf-8',
  }).trim();
}

describe.skipIf(!live)('sync over a live local Supabase', () => {
  beforeAll(async () => {
    crypto = await loadSyncCrypto();
    stack = localStack();
  });

  it('registers, shares, re-attaches lost sessions and syncs both ways', async () => {
    const aSecrets = new MemorySecureKeyStore();
    const bSecrets = new MemorySecureKeyStore();
    const aSession = sessionFor(aSecrets);
    const a = await aSession.connect();
    expect((await aSession.connect()).client).toBe(a.client); // one client per session
    const b = await sessionFor(bSecrets).connect();
    expect(a.deviceId).not.toBe(b.deviceId);

    // Space and invite (the screens come in slice 3).
    const spaceKey = crypto.newSpaceKey();
    const created = await a.client.rpc('create_space', {
      sealed_key: toBytea(crypto.sealSpaceKey(spaceKey, a.keys.boxPublicKey)),
      self_person: globalThis.crypto.randomUUID(),
    });
    expect(created.error).toBeNull();
    const spaceId = (created.data as { space_id: string }[])[0].space_id;
    const inviteSecret = crypto.newInviteSecret();
    const invite = await a.client.rpc('create_invite', {
      wrapped_key: toBytea(crypto.wrapForInvite(spaceKey, inviteSecret)),
    });
    const claim = await b.client.rpc('claim_invite', {
      invite: invite.data as string,
      person: globalThis.crypto.randomUUID(),
    });
    expect(claim.error).toBeNull();
    const approved = await a.client.rpc('approve_invite', { invite: invite.data as string });
    expect(approved.error).toBeNull();
    const accepted = await b.client.rpc('accept_invite', { invite: invite.data as string });
    const envelope = fromBytea((accepted.data as { envelope: string }[])[0].envelope);
    const bSpaceKey = crypto.unwrapInvite(envelope, inviteSecret);

    const keyringOf = (key: Uint8Array) => ({
      currentEpoch: () => 1,
      key: (e: number) => (e === 1 ? key : null),
    });
    const aLocal = await localDevice();
    const bLocal = await localDevice();
    await aLocal.profiles.save(profile);
    const trip = await aLocal.milestones.create(date);
    await aLocal.store.joinSpace(spaceId, 1);
    await bLocal.store.joinSpace(spaceId, 1);
    const engine = (local: typeof aLocal, client: typeof a.client, key: Uint8Array) =>
      new SyncEngine(local.store, new SupabaseTransport(client), crypto, keyringOf(key), () => ({
        calendarTimeZoneId: 'Europe/Brussels',
      }));

    const first = await engine(aLocal, a.client, spaceKey).sync();
    expect(first.pushed).toBe(3); // profile, Alex, the trip
    const received = await engine(bLocal, b.client, bSpaceKey).sync();
    expect(received.applied).toBe(3);
    expect((await bLocal.milestones.get(trip.id))?.title).toBe('First trip');

    // The server holds ciphertext only.
    const stored = psql(
      `select string_agg(encode(ciphertext, 'escape'), '') from records where space_id = '${spaceId}'`,
    );
    expect(stored).not.toContain('First trip');

    bLocal.clock.set('2026-10-22T11:00:00Z');
    await bLocal.milestones.update(trip.id, { ...date, title: 'Our first trip' });
    expect((await engine(bLocal, b.client, bSpaceKey).sync()).pushed).toBe(1);
    await engine(aLocal, a.client, spaceKey).sync();
    expect((await aLocal.milestones.get(trip.id))?.title).toBe('Our first trip');

    // A restart resumes the stored session: same device, same anonymous user.
    const aUser = (await a.client.auth.getUser()).data.user?.id;
    const resumed = await sessionFor(aSecrets).connect();
    expect(resumed.deviceId).toBe(a.deviceId);
    expect((await resumed.client.auth.getUser()).data.user?.id).toBe(aUser);

    // A lost session: a new anonymous user re-attaches the same device and keeps syncing.
    await aSecrets.remove('auth.session');
    const reattached = await sessionFor(aSecrets).connect();
    expect(reattached.deviceId).toBe(a.deviceId);
    expect((await reattached.client.auth.getUser()).data.user?.id).not.toBe(aUser);
    bLocal.clock.set('2026-10-22T12:00:00Z');
    await bLocal.milestones.update(trip.id, { ...date, title: 'After the reinstall' });
    await engine(bLocal, b.client, bSpaceKey).sync();
    await engine(aLocal, reattached.client, spaceKey).sync();
    expect((await aLocal.milestones.get(trip.id))?.title).toBe('After the reinstall');

    // The device row now belongs to the new anonymous user only. (The old client object
    // reads the shared storage, so ask the database rather than that client.)
    const newUser = (await reattached.client.auth.getUser()).data.user?.id;
    expect(psql(`select auth_user_id from devices where id = '${a.deviceId}';`)).toBe(newUser);
    expect(psql(`select count(*) from devices where auth_user_id = '${aUser}';`)).toBe('0');
    expect((await reattached.client.rpc('dissolve_space')).error).toBeNull();
  });

  it('recovers when the server took a new secret but the device did not save it', async () => {
    const secrets = new MemorySecureKeyStore();
    const first = await sessionFor(secrets).connect();
    // Re-attach from another session, as if the app crashed right after the server
    // accepted the next secret: it is stored as pending, the old one is still current.
    const pending = randomBytes(32);
    await secrets.set('device.secret.next', toBase64(pending));
    const other = createClient(stack.url, stack.key, { auth: { persistSession: false } });
    await other.auth.signInAnonymously();
    const crashed = await other.rpc('rebind_device', {
      device: first.deviceId,
      secret: toBytea(fromBase64((await secrets.get('device.secret'))!)),
      next_credential: toBytea(await sha256(pending)),
    });
    expect(crashed.error).toBeNull();

    await secrets.remove('auth.session');
    const recovered = await sessionFor(secrets).connect();
    expect(recovered.deviceId).toBe(first.deviceId);
    expect(await secrets.get('device.secret.next')).toBeNull();
  });

  it('reports a revoked device as lost instead of registering it again', async () => {
    const secrets = new MemorySecureKeyStore();
    const device = await sessionFor(secrets).connect();
    expect(
      (
        await device.client.rpc('create_space', {
          sealed_key: toBytea(randomBytes(80)),
          self_person: globalThis.crypto.randomUUID(),
        })
      ).error,
    ).toBeNull();
    expect(
      (await device.client.rpc('revoke_device', { target: device.deviceId })).error,
    ).toBeNull();
    await secrets.remove('auth.session');
    await expect(sessionFor(secrets).connect()).rejects.toBeInstanceOf(DeviceLostError);
    psql(
      `delete from spaces where id = (select space_id from devices where id = '${device.deviceId}');`,
    );
  });

  it('makes a second writer in the same space wait until the first commits', async () => {
    const space = psql(`insert into spaces default values returning id;`).split('\n')[0];
    const row = (id: string, ms: number) =>
      `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
       values ('${space}', 'milestone', '${id}', '${String(ms).padStart(13, '0')}-000000-0000abcd', 1, '\\x00', '\\x00');`;
    const slow = '55555555-5555-4555-8555-555555555555';
    const fast = '66666666-6666-4666-8666-666666666666';

    // The slow transaction draws its number first and holds it for 2 seconds.
    const first = spawn('docker', [
      'exec',
      '-i',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
    ]);
    const firstDone = new Promise<number>((resolve) =>
      first.on('close', (code) => resolve(code ?? -1)),
    );
    first.stdin.end(`begin; ${row(slow, 1000)} select pg_sleep(2); commit;`);
    await new Promise((r) => setTimeout(r, 700));

    const started = Date.now();
    psql(row(fast, 1000));
    const waited = Date.now() - started;
    expect(await firstDone).toBe(0);

    const order = psql(
      `select record_id from records where space_id = '${space}' order by seq;`,
    ).split('\n');
    expect(order).toEqual([slow, fast]);
    expect(waited).toBeGreaterThan(900); // it waited for the slow commit
    psql(`delete from spaces where id = '${space}';`);
  }, 20_000);
});
