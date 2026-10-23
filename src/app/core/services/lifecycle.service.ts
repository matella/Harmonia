import { Injectable, NgZone, inject } from '@angular/core';
import { Router } from '@angular/router';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

import { applyPreferredTextScale } from '../platform/text-scale';
import { AppStore } from '../state/app-store';
import { routeForLink } from './deep-links';
import { SharingService } from './sharing.service';
import { SyncService } from './sync.service';
import { UsageService } from './usage.service';
import { WidgetService } from './widget.service';

/**
 * Foreground-only time keeping and OS event handling:
 *  - refreshes `now` at each minute boundary while the app is visible (no background
 *    timers, no polling while paused);
 *  - on resume: refreshes time, reconciles reminders and the widget snapshot, and asks
 *    widgets to re-render if the calendar day or time zone changed;
 *  - routes widget deep links and notification taps.
 */
@Injectable({ providedIn: 'root' })
export class LifecycleService {
  private readonly store = inject(AppStore);
  private readonly sync = inject(SyncService);
  private readonly widgets = inject(WidgetService);
  private readonly usage = inject(UsageService);
  private readonly sharing = inject(SharingService);
  private readonly router = inject(Router);
  private readonly zone = inject(NgZone);
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private lastDay = '';
  private lastZone = '';

  start(): void {
    if (this.started) return;
    this.started = true;
    this.remember();
    this.scheduleTick();
    void applyPreferredTextScale();

    if (Capacitor.isNativePlatform()) {
      void App.addListener('appStateChange', ({ isActive }) => (isActive ? this.onResume() : this.onPause()));
      void App.addListener('appUrlOpen', ({ url }) => this.navigate(routeForLink(url)));
      void LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
        const route = (action.notification.extra as { route?: string } | undefined)?.route;
        this.navigate(routeForLink(route));
      });
      void App.getLaunchUrl().then((launch) => {
        if (launch?.url) this.navigate(routeForLink(launch.url));
      });
    } else {
      document.addEventListener('visibilitychange', () =>
        document.visibilityState === 'visible' ? this.onResume() : this.onPause(),
      );
    }
  }

  private navigate(route: string): void {
    if (!this.store.hasProfile()) return;
    this.zone.run(() => void this.router.navigateByUrl(route));
  }

  private async onResume(): Promise<void> {
    void applyPreferredTextScale();
    this.store.tick();
    this.scheduleTick();
    const dayChanged = this.store.today().toString() !== this.lastDay;
    const zoneChanged = this.store.deviceTimeZone() !== this.lastZone;
    this.remember();
    await this.sync.runSideEffects(true);
    this.sharing.requestSync();
    if (dayChanged || zoneChanged) await this.widgets.reload().catch(() => undefined);
  }

  private onPause(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Send queued usage events (if the user opted in) before the OS may suspend us.
    void this.usage.flush();
  }

  private scheduleTick(): void {
    if (this.timer) clearTimeout(this.timer);
    const msToNextMinute = 60_000 - (Date.now() % 60_000) + 50;
    this.timer = setTimeout(() => {
      const before = this.store.today().toString();
      this.store.tick();
      if (this.store.today().toString() !== before) {
        this.remember();
        void this.sync.runSideEffects(true).then(() => this.widgets.reload().catch(() => undefined));
      }
      this.scheduleTick();
    }, msToNextMinute);
  }

  private remember(): void {
    this.lastDay = this.store.today().toString();
    this.lastZone = this.store.deviceTimeZone();
  }
}
