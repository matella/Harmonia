import { Injectable, InjectionToken, computed, effect, inject, isDevMode, signal } from '@angular/core';
import { NavigationEnd, Router, type ActivatedRouteSnapshot } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { filter } from 'rxjs';

import { countBucket, screenForRoutePath, settingChangedEvents, type UsageEvent } from '../domain/usage-events';
import type { AppSettings } from '../domain/models';
import { aptabaseEndpoint, UsageRecorder, type FetchLike, type UsageConfig } from '../platform/usage-analytics';
import { HarmoniaWidgets } from '../platform/widget-bridge';
import { USAGE_CONFIG as CONFIGURED } from '../platform/usage-config';
import { AppStore } from '../state/app-store';
import { I18nService } from './i18n.service';
import { APP_VERSION, CLOCK } from './tokens';

/** Destination for usage events; null disables the feature entirely. */
export const USAGE_CONFIG = new InjectionToken<UsageConfig | null>('USAGE_CONFIG', {
  providedIn: 'root',
  // Only native builds may send: the browser preview never does.
  factory: () => (Capacitor.isNativePlatform() ? CONFIGURED : null),
});

export const USAGE_FETCH = new InjectionToken<FetchLike>('USAGE_FETCH', {
  providedIn: 'root',
  factory: () => (url, init) => fetch(url, init),
});

const FLUSH_DELAY_MS = 30_000;

/**
 * Opt-in anonymous usage events. Off unless the user turns it on; when off (or after
 * "Delete all data") nothing is recorded and anything queued is discarded. Failures
 * never reach the UI.
 */
@Injectable({ providedIn: 'root' })
export class UsageService {
  private readonly store = inject(AppStore);
  private readonly clock = inject(CLOCK);
  private readonly i18n = inject(I18nService);
  private readonly config = inject(USAGE_CONFIG);
  private readonly endpoint = this.config ? aptabaseEndpoint(this.config) : null;
  private readonly recorder: UsageRecorder | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Until the native side answers, assume a test build: better to under-count than pollute. */
  private debuggable = true;

  /** True when a destination is configured: only then do the prompt and setting exist. */
  readonly available = this.endpoint !== null;
  readonly enabled = computed(() => this.available && this.store.settings().usageSharing);
  private readonly onboardedNow = signal(false);
  /**
   * The one-time invitation: only with a destination, never during the session that
   * completed onboarding, and gone for good once answered either way.
   */
  readonly showPrompt = computed(
    () => this.available && this.store.hasProfile() && !this.store.settings().usagePromptAnswered && !this.onboardedNow(),
  );
  /** "Aptabase (EU)", "Aptabase (US)" or the self-hosted server's name. */
  readonly destination = this.describeDestination();

  constructor() {
    const fetchFn = inject(USAGE_FETCH);
    this.recorder =
      this.endpoint && this.config
        ? new UsageRecorder({
            endpoint: this.endpoint,
            appKey: this.config.appKey,
            fetch: fetchFn,
            nowMs: () => this.clock.now().epochMilliseconds,
            random: Math.random,
            system: () => ({
              locale: this.i18n.language(),
              osName: Capacitor.getPlatform(),
              appVersion: APP_VERSION,
              isDebug: isDevMode() || this.debuggable,
              sdkVersion: 'harmonia-usage@1',
            }),
          })
        : null;

    effect(() => this.recorder?.setEnabled(this.enabled()));
    if (this.recorder) {
      HarmoniaWidgets.buildInfo()
        .then((info) => (this.debuggable = info.debuggable))
        .catch(() => undefined);
    }

    if (this.recorder) {
      const router = inject(Router);
      router.events.pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd)).subscribe(() => {
        const screen = screenForRoutePath(leafRoutePath(router.routerState.snapshot.root));
        if (screen) this.track({ name: 'screen_viewed', props: { screen } });
      });
    }
  }

  markOnboardedThisSession(): void {
    this.onboardedNow.set(true);
  }

  track(event: UsageEvent): void {
    if (!this.recorder || !this.enabled()) return;
    this.recorder.record(event);
    if (this.recorder.pending >= 10) void this.flush();
    else this.scheduleFlush();
  }

  /** Counted setting changes; the consent setting itself is never reported. */
  trackSettings(changes: Partial<AppSettings>): void {
    for (const event of settingChangedEvents(changes)) this.track(event);
  }

  /** Coarse snapshot of how the app is set up, once per cold start. */
  trackStart(): void {
    const s = this.store.settings();
    const p = this.store.profile();
    if (!p) return;
    this.track({
      name: 'app_started',
      props: {
        language: this.i18n.language(),
        theme: s.theme,
        counter_format: s.counterFormat,
        widget_privacy: s.widgetPrivacy,
        together_months: s.togetherMonths,
        together_days: s.togetherDays,
        reminders_enabled: s.remindersEnabled,
        together_reminders: s.togetherReminders,
        has_start_time: p.startTime !== null,
        has_photo: p.photoPath !== null,
        dates: countBucket(this.store.milestones().length),
        memories: countBucket(this.store.memories().length),
      },
    });
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.recorder?.flush().catch(() => undefined);
  }

  /** Used by "Delete all data": nothing queued may be sent afterwards. */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.recorder?.discard();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), FLUSH_DELAY_MS);
  }

  private describeDestination(): string {
    if (!this.endpoint) return '';
    const host = new URL(this.endpoint).host;
    if (host === 'eu.aptabase.com') return 'Aptabase (EU)';
    if (host === 'us.aptabase.com') return 'Aptabase (US)';
    return host;
  }
}

/** The pattern of the deepest active route (`home`, `milestone/:id`), never the URL. */
function leafRoutePath(root: ActivatedRouteSnapshot): string | undefined {
  let node = root;
  while (node.firstChild) node = node.firstChild;
  return node.routeConfig?.path;
}
