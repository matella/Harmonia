import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { MutableClock } from '../../core/domain/clock';
import { DEFAULT_SETTINGS } from '../../core/domain/models';
import { CLOCK, NOTIFICATION_PORT } from '../../core/services/tokens';
import { AppStore } from '../../core/state/app-store';
import { DatesPage } from './dates.page';

describe('DatesPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideIonicAngular(),
        provideRouter([]),
        { provide: NOTIFICATION_PORT, useValue: new FakeNotificationPort() },
        { provide: CLOCK, useValue: new MutableClock('2026-10-18T08:00:00Z', 'Europe/Brussels') },
      ],
    });
    const store = TestBed.inject(AppStore);
    store.settings.set({ ...DEFAULT_SETTINGS, defaultReminderOffsets: [1, 0] });
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
  });

  it('shows the next milestone together even before the user adds any date', () => {
    const fixture = TestBed.createComponent(DatesPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector('hm-together-row');
    expect(row?.textContent).toContain('2 years, 6 months together');
    // The invitation to add a first date is still there, below it.
    expect(el.querySelector('hm-empty-state')).not.toBeNull();
  });
});
