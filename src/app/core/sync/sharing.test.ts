import { describe, expect, it } from 'vitest';

import { MutableClock } from '../domain/clock';
import { ChangeJournal } from '../persistence/change-journal';
import { newId } from '../persistence/ids';
import { migrate } from '../persistence/migrations';
import { RelationshipRepository } from '../persistence/relationship.repository';
import { SqlJsDriver } from '../persistence/sqljs-driver';
import { MemorySecureKeyStore } from '../platform/secure-key-store';
import type { DeviceSession } from './device-session';
import { toBase64 } from './encoding';
import { Sharing } from './sharing';
import type { SyncCrypto } from './sync-crypto-port';
import { SyncStore } from './sync-store';

/** Parts of the sharing flow that need no server (the rest is tested live). */
async function setUp() {
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
    crypto: {} as SyncCrypto,
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
    expect(await sharing.currentInviteCode()).toMatch(/^H1\./);

    clock.set('2026-10-24T10:00:00Z');
    expect(await sharing.checkInvite()).toEqual({ state: 'gone' });
    expect(await sharing.currentInviteCode()).toBeNull();
    expect(await secrets.get('sharing.invite')).toBeNull();
  });

  it('reports the status from local state only', async () => {
    const { secrets, sharing } = await setUp();
    expect(await sharing.status()).toBe('off');
    await secrets.set('sharing.join', JSON.stringify({ inviteId: 'x', secret: 'y' }));
    expect(await sharing.status()).toBe('joining');
  });
});
