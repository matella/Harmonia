import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { MutableClock } from '../domain/clock';
import { DEFAULT_SETTINGS, type AppSettings } from '../domain/models';
import type { FetchLike } from '../platform/usage-analytics';
import { AppStore } from '../state/app-store';
import { CLOCK, NOTIFICATION_PORT } from './tokens';
import { USAGE_CONFIG, USAGE_FETCH, UsageService } from './usage.service';

const viewed = { name: 'screen_viewed', props: { screen: 'home' } } as const;

function configure(withDestination: boolean) {
  const calls: string[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    calls.push(init.body);
    return { ok: true, status: 200 };
  };
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
      { provide: CLOCK, useValue: new MutableClock('2026-10-18T08:00:00Z', 'Europe/Brussels') },
      { provide: USAGE_FETCH, useValue: fetchFn },
      ...(withDestination ? [{ provide: USAGE_CONFIG, useValue: { appKey: 'A-EU-1234567890' } }] : []),
    ],
  });
  const store = TestBed.inject(AppStore);
  store.profile.set({
    displayName: 'Sam',
    relationshipLabel: null,
    startDate: '2024-06-14',
    startTime: null,
    startTimeZoneId: null,
    calendarTimeZoneId: 'Europe/Brussels',
    photoPath: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const setSettings = (changes: Partial<AppSettings>) => {
    store.settings.set({ ...DEFAULT_SETTINGS, defaultReminderOffsets: [1, 0], ...changes });
    TestBed.tick();
  };
  return { usage: TestBed.inject(UsageService), calls, setSettings };
}

describe('UsageService', () => {
  it('sends nothing with default settings', async () => {
    const { usage, calls, setSettings } = configure(true);
    setSettings({});
    usage.track(viewed);
    await usage.flush();
    expect(usage.available).toBe(true);
    expect(calls).toEqual([]);
  });

  it('sends once the user opted in', async () => {
    const { usage, calls, setSettings } = configure(true);
    setSettings({ usageSharing: true });
    usage.track(viewed);
    await usage.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('"screen":"home"');
    expect(calls[0]).not.toContain('Sam');
  });

  it('never sends events queued before "Delete all data" reset the settings', async () => {
    const { usage, calls, setSettings } = configure(true);
    setSettings({ usageSharing: true });
    usage.track(viewed);
    usage.discard();
    setSettings({});
    await usage.flush();
    expect(calls).toEqual([]);
  });

  it('asks once, never in the onboarding session', () => {
    const { usage, setSettings } = configure(true);
    setSettings({});
    expect(usage.showPrompt()).toBe(true);
    setSettings({ usagePromptAnswered: true });
    expect(usage.showPrompt()).toBe(false);
    setSettings({});
    usage.markOnboardedThisSession();
    expect(usage.showPrompt()).toBe(false);
  });

  it('does not exist without a destination, which is always the case in the browser', async () => {
    const { usage, calls, setSettings } = configure(false);
    setSettings({ usageSharing: true });
    usage.track(viewed);
    await usage.flush();
    expect(usage.available).toBe(false);
    expect(usage.showPrompt()).toBe(false);
    expect(calls).toEqual([]);
  });
});
