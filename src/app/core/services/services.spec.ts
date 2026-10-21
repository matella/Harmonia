import { TestBed } from '@angular/core/testing';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { MutableClock } from '../domain/clock';
import { DEFAULT_SETTINGS, type Milestone, type ReminderRule } from '../domain/models';
import { reminderStateFor } from '../../shared/utilities/reminder-state';
import { AppStore } from '../state/app-store';
import { ReminderService } from './reminder.service';
import { CLOCK, NOTIFICATION_PORT } from './tokens';
import { WidgetService } from './widget.service';

const STAMP = '2026-01-01T00:00:00Z';
const milestone: Milestone = {
  id: 'm1',
  title: 'Our anniversary',
  category: 'anniversary',
  eventDate: '2024-06-14',
  eventTime: null,
  eventTimeZoneId: null,
  recurrence: 'yearly',
  leapDayPolicy: null,
  note: null,
  photoPath: null,
  isPinned: false,
  createdAt: STAMP,
  updatedAt: STAMP,
};
const rule: ReminderRule = {
  id: 'r1',
  milestoneId: 'm1',
  offsetDays: 1,
  localTime: '09:00',
  isEnabled: true,
  includeEventTitle: false,
  notificationId: 1001,
  createdAt: STAMP,
  updatedAt: STAMP,
};

describe('store-driven services', () => {
  let port: FakeNotificationPort;
  let clock: MutableClock;
  let store: AppStore;

  beforeEach(() => {
    port = new FakeNotificationPort();
    clock = new MutableClock('2026-10-18T08:00:00Z', 'Europe/Brussels');
    TestBed.configureTestingModule({
      providers: [
        { provide: NOTIFICATION_PORT, useValue: port },
        { provide: CLOCK, useValue: clock },
      ],
    });
    store = TestBed.inject(AppStore);
    store.profile.set({
      displayName: 'Sam',
      selfName: null,
      relationshipLabel: null,
      startDate: '2024-06-14',
      startTime: null,
      startTimeZoneId: null,
      calendarTimeZoneId: 'Europe/Brussels',
      photoPath: null,
      createdAt: STAMP,
      updatedAt: STAMP,
    });
    store.milestones.set([milestone]);
    store.rules.set([rule]);
  });

  it('derives the counter and upcoming dates from store state', () => {
    expect(store.counter()).toMatchObject({ state: 'counting', totalDays: 856 });
    expect(store.nextUpcoming()?.date.toString()).toBe('2027-06-14');
    clock.set('2027-06-14T08:00:00Z');
    store.tick();
    expect(store.nextUpcoming()?.status).toBe('today');
    expect(store.counter()).toMatchObject({ calendar: { years: 3, months: 0, days: 0 } });
  });

  it('reconciles reminders through the notification port', async () => {
    const reminders = TestBed.inject(ReminderService);
    const report = await reminders.reconcile();
    expect(report).toMatchObject({ permission: 'granted', scheduled: 1 });
    expect(port.pending.get(1001)?.body).toBe('A special date is tomorrow.');

    store.settings.set({ ...DEFAULT_SETTINGS, remindersEnabled: false });
    await reminders.reconcile();
    expect(port.pending.size).toBe(0);
  });

  it('requests permission only when asked, and never re-prompts after a denial', async () => {
    const reminders = TestBed.inject(ReminderService);
    port.permission = 'prompt';
    port.requestResult = 'denied';
    expect(await reminders.requestIfNeeded()).toBe('denied');
    expect(await reminders.requestIfNeeded()).toBe('denied');
    expect(port.requestCount).toBe(1);
    expect(reminderStateFor('m1', store.rulesByMilestone(), store.settings(), reminders.permission())).toBe('blocked');
  });

  it('builds a privacy-respecting widget snapshot from the store', () => {
    const widgets = TestBed.inject(WidgetService);
    expect(widgets.current()).toMatchObject({ state: 'ready', privacy: 'discreet', displayName: null, upcoming: [] });
    store.settings.set({ ...DEFAULT_SETTINGS, widgetPrivacy: 'normal' });
    const normal = widgets.current();
    expect(normal.displayName).toBe('Sam');
    expect(normal.upcoming).toContainEqual({ title: 'Our anniversary', date: '2027-06-14' });
    // Derived milestones together are titled in the app language and never exceed two entries.
    const together = normal.upcoming.filter((u) => u.title?.endsWith(' together'));
    expect(together.length).toBeGreaterThan(0);
    expect(together.length).toBeLessThanOrEqual(2);
    store.profile.set(null);
    expect(widgets.current().state).toBe('empty');
  });
});
