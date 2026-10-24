import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { MutableClock } from '../domain/clock';
import { DEFAULT_SETTINGS, type AppSettings } from '../domain/models';
import type { AppLockPort, UnlockResult } from '../platform/app-lock';
import { AppStore } from '../state/app-store';
import { AppLockService } from './app-lock.service';
import { SettingsService } from './settings.service';
import { APP_LOCK_PORT, CLOCK, NOTIFICATION_PORT } from './tokens';

/** The phone's unlock, scripted. */
class FakeLock implements AppLockPort {
  secure = true;
  answers: UnlockResult[] = [];
  prompts = 0;
  async deviceIsSecure(): Promise<boolean> {
    return this.secure;
  }
  async unlock(): Promise<UnlockResult> {
    this.prompts++;
    return this.answers.shift() ?? 'unlocked';
  }
}

function configure(settings: Partial<AppSettings> = {}) {
  const port = new FakeLock();
  const clock = new MutableClock('2026-10-24T08:00:00Z', 'Europe/Brussels');
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
      { provide: CLOCK, useValue: clock },
      { provide: APP_LOCK_PORT, useValue: port },
      {
        provide: SettingsService,
        useFactory: () => {
          const store = TestBed.inject(AppStore);
          return {
            update: async (changes: Partial<AppSettings>) =>
              store.settings.set({ ...store.settings(), ...changes }),
          };
        },
      },
    ],
  });
  const store = TestBed.inject(AppStore);
  store.settings.set({ ...DEFAULT_SETTINGS, ...settings });
  return { lock: TestBed.inject(AppLockService), port, clock, store };
}

describe('AppLockService', () => {
  it('starts unlocked when the lock is off, and never locks', () => {
    const { lock, clock } = configure();
    lock.init();
    expect(lock.locked()).toBe(false);
    lock.onPause();
    clock.set('2026-10-24T09:00:00Z');
    lock.onResume();
    expect(lock.locked()).toBe(false);
  });

  it('starts locked, and locks again only after the chosen time away', async () => {
    const { lock, clock } = configure({ appLock: true, appLockAfter: 5 });
    lock.init();
    expect(lock.locked()).toBe(true);
    expect(await lock.unlock()).toBe('unlocked');
    expect(lock.locked()).toBe(false);

    lock.onPause();
    clock.set('2026-10-24T08:04:00Z');
    lock.onResume();
    expect(lock.locked()).toBe(false);

    lock.onPause();
    clock.set('2026-10-24T08:10:00Z');
    lock.onResume();
    expect(lock.locked()).toBe(true);
  });

  it('stays locked after a cancel, and ignores the pause the unlock prompt itself causes', async () => {
    const { lock, port, clock } = configure({ appLock: true, appLockAfter: 0 });
    lock.init();
    port.answers = ['cancelled'];
    expect(await lock.unlock()).toBe('cancelled');
    expect(lock.locked()).toBe(true);

    // The PIN screen sends the app to the background and back while unlocking.
    port.unlock = async () => {
      lock.onPause();
      clock.set('2026-10-24T08:00:30Z');
      lock.onResume();
      return 'unlocked';
    };
    expect(await lock.unlock()).toBe('unlocked');
    expect(lock.locked()).toBe(false);
  });

  it('turns on only after one successful unlock, and only with a screen lock on the phone', async () => {
    const { lock, port, store } = configure();
    port.answers = ['cancelled'];
    expect(await lock.enable()).toBe('cancelled');
    expect(store.settings().appLock).toBe(false);
    expect(await lock.enable()).toBe('unlocked');
    expect(store.settings().appLock).toBe(true);

    await lock.disable();
    port.secure = false;
    const prompts = port.prompts;
    expect(await lock.enable()).toBe('failed');
    expect(port.prompts).toBe(prompts); // nothing to unlock with: not even asked
    expect(store.settings().appLock).toBe(false);
  });
});
