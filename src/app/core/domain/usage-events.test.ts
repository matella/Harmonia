import { describe, expect, it } from 'vitest';

import {
  countBucket,
  isSafeUsageEvent,
  screenForRoutePath,
  SCREENS,
  settingChangedEvents,
  type UsageEvent,
} from './usage-events';

/** One example of every event, with the most revealing values the schema allows. */
const EXAMPLES: UsageEvent[] = [
  {
    name: 'app_started',
    props: {
      language: 'fr',
      theme: 'dark',
      counter_format: 'calendar',
      widget_privacy: 'normal',
      together_months: 'every',
      together_days: true,
      reminders_enabled: true,
      together_reminders: false,
      has_start_time: true,
      has_photo: false,
      dates: '6-20',
      memories: '21+',
    },
  },
  { name: 'screen_viewed', props: { screen: 'date_detail' } },
  { name: 'onboarding_completed', props: { start_time: true, name: true, photo: false, anniversary: true, reminder: true } },
  { name: 'date_saved', props: { is_new: true, yearly: true, has_time: false, reminders: true, has_photo: false, pinned: false } },
  { name: 'date_deleted', props: {} },
  { name: 'memory_saved', props: { is_new: false, photos: '2-5', linked: true } },
  { name: 'memory_deleted', props: {} },
  { name: 'setting_changed', props: { setting: 'widgetPrivacy', value: 'minimal' } },
  { name: 'export_created', props: { complete: true } },
  { name: 'reminders_rechecked', props: { repaired: false } },
  { name: 'notification_permission', props: { result: 'denied' } },
];

describe('usage event schema', () => {
  it('accepts every documented event', () => {
    for (const event of EXAMPLES) expect(isSafeUsageEvent(event), event.name).toBe(true);
  });

  it('only ever carries booleans and short whitelisted words', () => {
    for (const event of EXAMPLES) {
      for (const value of Object.values(event.props)) {
        if (typeof value === 'boolean') continue;
        expect(typeof value).toBe('string');
        expect(value as string).toMatch(/^[a-z0-9_+-]{1,24}$/i);
      }
    }
  });

  it('rejects anything that could carry personal content', () => {
    const leaks: { name: string; props: Record<string, unknown> }[] = [
      { name: 'screen_viewed', props: { screen: 'milestone/9f2c' } },
      { name: 'setting_changed', props: { setting: 'theme', value: 'Our anniversary' } },
      { name: 'date_saved', props: { is_new: true, title: 'Paris trip' } },
      { name: 'app_started', props: { dates: 12 } },
      { name: 'memory_saved', props: { photos: '2024-06-14' } },
      { name: 'custom_event', props: {} },
    ];
    for (const leak of leaks) expect(isSafeUsageEvent(leak), JSON.stringify(leak)).toBe(false);
  });

  it('buckets counts coarsely', () => {
    expect([0, 1, 2, 5, 6, 20, 21, 500].map(countBucket)).toEqual(['0', '1', '2-5', '2-5', '6-20', '6-20', '21+', '21+']);
  });

  it('names screens by route pattern, never by record', () => {
    expect(screenForRoutePath('milestone/:id')).toBe('date_detail');
    expect(screenForRoutePath('home')).toBe('home');
    expect(screenForRoutePath('milestone/abc123')).toBeNull();
    expect(screenForRoutePath(undefined)).toBeNull();
    expect(new Set(SCREENS).size).toBe(SCREENS.length);
  });

  it('reports counted settings only — never consent, times or offsets', () => {
    expect(
      settingChangedEvents({ theme: 'dark', usageSharing: true, defaultReminderTime: '07:30', defaultReminderOffsets: [3] }),
    ).toEqual([{ name: 'setting_changed', props: { setting: 'theme', value: 'dark' } }]);
    for (const event of settingChangedEvents({ language: 'nl', togetherDays: false, widgetPrivacy: 'normal' })) {
      expect(isSafeUsageEvent(event)).toBe(true);
    }
  });
});
