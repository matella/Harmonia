import { TestBed } from '@angular/core/testing';

import { MutableClock } from '../domain/clock';
import { DatabaseService } from './database.service';
import { SharingService, SYNC_SERVER } from './sharing.service';
import { SyncService } from './sync.service';
import { CLOCK } from './tokens';

/** "Delete all data" while sharing forgets every sharing secret on the device. */
describe('SharingService.forgetSecrets', () => {
  it('forgets the device identity, its session, pending steps and every space key', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: SYNC_SERVER, useValue: { url: 'http://127.0.0.1:54321', publishableKey: 'k' } },
        {
          provide: DatabaseService,
          useValue: {
            repos: {
              sync: { state: async () => ({ spaceId: 's1', epoch: 2, cursor: 0, capability: 2 }) },
            },
          },
        },
        { provide: SyncService, useValue: { onLocalChange: () => undefined } },
        { provide: CLOCK, useValue: new MutableClock('2026-10-23T08:00:00Z', 'Europe/Brussels') },
      ],
    });
    const sharing = TestBed.inject(SharingService);
    const secrets = (
      sharing as unknown as {
        secrets: {
          set(n: string, v: string): Promise<void>;
          get(n: string): Promise<string | null>;
        };
      }
    ).secrets;
    const names = [
      'device.keys',
      'device.id',
      'device.secret',
      'auth.session',
      'sharing.join',
      'space.s1.1',
      'space.s1.2',
    ];
    for (const name of names) await secrets.set(name, 'x');
    await sharing.forgetSecrets();
    for (const name of names) expect(await secrets.get(name)).toBeNull();
  });
});
