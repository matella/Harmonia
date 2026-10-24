import { TestBed } from '@angular/core/testing';

import { MutableClock } from '../domain/clock';
import { DatabaseService } from './database.service';
import { SharingService, SYNC_SERVER } from './sharing.service';
import { SyncService } from './sync.service';
import { CLOCK } from './tokens';

/** Background sync scheduling: solo devices must never load sharing code or go online. */
class FakeDatabase {
  stateChecks = 0;
  readonly repos = {
    sync: {
      state: async () => {
        this.stateChecks++;
        return null; // solo: sharing was never turned on
      },
    },
  };
}

class FakeSync {
  listeners: (() => void)[] = [];
  onLocalChange(listener: () => void): void {
    this.listeners.push(listener);
  }
  async afterChange(): Promise<void> {
    // not used here
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('SharingService background sync', () => {
  function setUp(server: { url: string; publishableKey: string } | null) {
    const db = new FakeDatabase();
    const sync = new FakeSync();
    TestBed.configureTestingModule({
      providers: [
        { provide: SYNC_SERVER, useValue: server },
        { provide: DatabaseService, useValue: db },
        { provide: SyncService, useValue: sync },
        { provide: CLOCK, useValue: new MutableClock('2026-10-23T08:00:00Z', 'Europe/Brussels') },
      ],
    });
    return { db, sync, sharing: TestBed.inject(SharingService) };
  }

  it('checks only the local database on a solo device, and loads nothing', async () => {
    const { db, sync, sharing } = setUp({ url: 'http://127.0.0.1:54321', publishableKey: 'k' });
    expect(sync.listeners).toHaveLength(1); // uploads follow local changes

    sharing.requestSync();
    sharing.requestSync(); // a second request before the first ran is merged into it
    await tick(10);
    expect(db.stateChecks).toBe(1);
    expect((sharing as unknown as { loading: unknown }).loading).toBeNull();
  });

  it('answers "off" for a solo device on screens that ask, and loads nothing', async () => {
    const { db, sharing } = setUp({ url: 'http://127.0.0.1:54321', publishableKey: 'k' });
    expect(await sharing.ensureStatus()).toBe('off');
    expect(sharing.sharingOn()).toBe(false);
    expect(db.stateChecks).toBe(1);
    expect((sharing as unknown as { loading: unknown }).loading).toBeNull();
  });

  it('does nothing at all when no sharing server is configured', async () => {
    const { db, sharing } = setUp(null);
    expect(sharing.available).toBe(false);
    sharing.requestSync();
    await tick(10);
    expect(db.stateChecks).toBe(0);
  });
});
