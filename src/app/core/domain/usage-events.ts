import type { AppSettings } from './models';

/**
 * The complete schema of anonymous usage events (opt-in, off by default).
 *
 * Events describe which features are used — never what happened in the relationship.
 * Every property value is a boolean or one of the fixed strings below; there is no
 * free text, no title, no name, no date, no exact count and no record ID. Life-event
 * categories (engagement, wedding, …) are deliberately not sent either.
 * `isSafeUsageEvent` enforces this at runtime, and a test walks every event.
 */

/** Coarse size buckets instead of exact counts. */
export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21+'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

export function countBucket(count: number): CountBucket {
  if (count <= 0) return '0';
  if (count === 1) return '1';
  if (count <= 5) return '2-5';
  if (count <= 20) return '6-20';
  return '21+';
}

/** Screens by template, never by record (`milestone/:id` → `date_detail`). */
export const SCREENS = [
  'onboarding',
  'home',
  'timeline',
  'dates',
  'memories',
  'counter',
  'date_new',
  'date_edit',
  'date_detail',
  'memory_new',
  'memory_edit',
  'memory_detail',
  'settings',
  'settings_profile',
  'settings_appearance',
  'settings_reminders',
  'settings_widgets',
  'settings_privacy',
  'settings_about',
] as const;
export type ScreenName = (typeof SCREENS)[number];

const ROUTE_SCREENS: Record<string, ScreenName> = {
  welcome: 'onboarding',
  home: 'home',
  timeline: 'timeline',
  dates: 'dates',
  memories: 'memories',
  counter: 'counter',
  'milestone/new': 'date_new',
  'milestone/:id/edit': 'date_edit',
  'milestone/:id': 'date_detail',
  'memory/new': 'memory_new',
  'memory/:id/edit': 'memory_edit',
  'memory/:id': 'memory_detail',
  settings: 'settings',
  'settings/profile': 'settings_profile',
  'settings/appearance': 'settings_appearance',
  'settings/reminders': 'settings_reminders',
  'settings/widgets': 'settings_widgets',
  'settings/privacy': 'settings_privacy',
  'settings/about': 'settings_about',
};

/** Maps a route *pattern* (from the router config, not the URL) to a screen name. */
export function screenForRoutePath(path: string | undefined): ScreenName | null {
  return path === undefined ? null : (ROUTE_SCREENS[path] ?? null);
}

/** Settings whose changes are counted; times, offsets and consent itself are not. */
export const TRACKED_SETTINGS = [
  'theme',
  'accent',
  'counterFormat',
  'remindersEnabled',
  'notificationsRevealTitles',
  'widgetPrivacy',
  'widgetCounterMode',
  'leapDayPolicy',
  'timelineOrder',
  'togetherMonths',
  'togetherDays',
  'togetherReminders',
  'language',
] as const satisfies readonly (keyof AppSettings)[];
export type TrackedSetting = (typeof TRACKED_SETTINGS)[number];

/** Every enum value a tracked setting can take (booleans are sent as booleans). */
const SETTING_VALUES = [
  'system',
  'light',
  'dark',
  'berry',
  'sage',
  'calendar',
  'days',
  'weeks',
  'normal',
  'discreet',
  'minimal',
  'feb28',
  'mar1',
  'oldest',
  'newest',
  'off',
  'key',
  'every',
  'en',
  'fr',
  'nl',
] as const;

export type UsageEvent =
  | {
      name: 'app_started';
      props: {
        language: 'en' | 'fr' | 'nl';
        theme: AppSettings['theme'];
        counter_format: AppSettings['counterFormat'];
        widget_privacy: AppSettings['widgetPrivacy'];
        together_months: AppSettings['togetherMonths'];
        together_days: boolean;
        reminders_enabled: boolean;
        together_reminders: boolean;
        has_start_time: boolean;
        has_photo: boolean;
        dates: CountBucket;
        memories: CountBucket;
      };
    }
  | { name: 'screen_viewed'; props: { screen: ScreenName } }
  | {
      name: 'onboarding_completed';
      props: { start_time: boolean; name: boolean; photo: boolean; anniversary: boolean; reminder: boolean };
    }
  | {
      name: 'date_saved';
      props: { is_new: boolean; yearly: boolean; has_time: boolean; reminders: boolean; has_photo: boolean; pinned: boolean };
    }
  | { name: 'date_deleted'; props: Record<string, never> }
  | { name: 'memory_saved'; props: { is_new: boolean; photos: CountBucket; linked: boolean } }
  | { name: 'memory_deleted'; props: Record<string, never> }
  | { name: 'setting_changed'; props: { setting: TrackedSetting; value: string | boolean } }
  | { name: 'export_created'; props: { complete: boolean } }
  | { name: 'reminders_rechecked'; props: { repaired: boolean } }
  | { name: 'notification_permission'; props: { result: 'granted' | 'denied' } };

export type UsageEventName = UsageEvent['name'];

const EVENT_NAMES: readonly UsageEventName[] = [
  'app_started',
  'screen_viewed',
  'onboarding_completed',
  'date_saved',
  'date_deleted',
  'memory_saved',
  'memory_deleted',
  'setting_changed',
  'export_created',
  'reminders_rechecked',
  'notification_permission',
];

const ALLOWED_STRINGS: ReadonlySet<string> = new Set<string>([
  ...COUNT_BUCKETS,
  ...SCREENS,
  ...TRACKED_SETTINGS,
  ...SETTING_VALUES,
  'granted',
  'denied',
]);

/**
 * Runtime guard: a known event name and only booleans or whitelisted strings as values.
 * Anything else (a title, a date, a number) makes the whole event invalid.
 */
export function isSafeUsageEvent(event: { name: string; props: Record<string, unknown> }): boolean {
  if (!(EVENT_NAMES as readonly string[]).includes(event.name)) return false;
  return Object.values(event.props).every(
    (value) => typeof value === 'boolean' || (typeof value === 'string' && ALLOWED_STRINGS.has(value)),
  );
}

/** One `setting_changed` event per counted setting in `changes`; others are ignored. */
export function settingChangedEvents(changes: Partial<AppSettings>): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const setting of TRACKED_SETTINGS) {
    const value = changes[setting];
    if (value === undefined) continue;
    events.push({ name: 'setting_changed', props: { setting, value } });
  }
  return events;
}
