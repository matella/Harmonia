import type { IsoDate, LocalTime } from './local-date';

/** ISO-8601 instant string (UTC), used only for record bookkeeping. */
export type IsoInstant = string;

export type ThemePreference = 'system' | 'light' | 'dark';
export type AccentPreset = 'berry' | 'sage';
export type CounterFormat = 'calendar' | 'days' | 'weeks';
export type WidgetPrivacyMode = 'normal' | 'discreet' | 'minimal';
export type LeapDayPolicy = 'feb28' | 'mar1';
export type Recurrence = 'none' | 'yearly';
export type TimelineOrder = 'oldest' | 'newest';

export const MILESTONE_CATEGORIES = [
  'met',
  'first_date',
  'became_couple',
  'first_kiss',
  'first_trip',
  'moved_in',
  'engagement',
  'wedding',
  'anniversary',
  'custom',
] as const;
export type MilestoneCategory = (typeof MILESTONE_CATEGORIES)[number];

export interface RelationshipProfile {
  displayName: string | null;
  relationshipLabel: string | null;
  startDate: IsoDate;
  startTime: LocalTime | null;
  /** IANA zone of the exact start instant; present only when startTime is set. */
  startTimeZoneId: string | null;
  /** Zone used to evaluate calendar-day boundaries for the counter. */
  calendarTimeZoneId: string;
  photoPath: string | null;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface Milestone {
  id: string;
  title: string;
  category: MilestoneCategory;
  eventDate: IsoDate;
  eventTime: LocalTime | null;
  /**
   * Null means "floating local time": the event happens at its wall-clock time
   * wherever the device is. v1 always stores null; the column exists for the future.
   */
  eventTimeZoneId: string | null;
  recurrence: Recurrence;
  /** Null inherits the app-wide leap-day policy. */
  leapDayPolicy: LeapDayPolicy | null;
  note: string | null;
  photoPath: string | null;
  isPinned: boolean;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface ReminderRule {
  id: string;
  milestoneId: string;
  /** 0 = on the day, positive = days before. */
  offsetDays: number;
  localTime: LocalTime;
  isEnabled: boolean;
  includeEventTitle: boolean;
  /** Stable 32-bit identifier used for the OS notification request. */
  notificationId: number;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface MemoryMedia {
  id: string;
  memoryId: string;
  /** Path relative to the app-private data directory. */
  filePath: string;
  thumbnailPath: string | null;
  sortOrder: number;
  createdAt: IsoInstant;
}

export interface Memory {
  id: string;
  milestoneId: string | null;
  title: string | null;
  body: string | null;
  memoryDate: IsoDate;
  media: MemoryMedia[];
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
}

export interface AppSettings {
  theme: ThemePreference;
  accent: AccentPreset;
  counterFormat: CounterFormat;
  remindersEnabled: boolean;
  defaultReminderTime: LocalTime;
  defaultReminderOffsets: number[];
  /** Default for new reminders: may notifications reveal the milestone title? */
  notificationsRevealTitles: boolean;
  widgetPrivacy: WidgetPrivacyMode;
  widgetCounterMode: 'days' | 'calendar';
  leapDayPolicy: LeapDayPolicy;
  timelineOrder: TimelineOrder;
}

export const DEFAULT_SETTINGS: Readonly<AppSettings> = Object.freeze({
  theme: 'system',
  accent: 'berry',
  counterFormat: 'calendar',
  remindersEnabled: true,
  defaultReminderTime: '09:00',
  defaultReminderOffsets: [1, 0],
  notificationsRevealTitles: false,
  widgetPrivacy: 'discreet',
  widgetCounterMode: 'days',
  leapDayPolicy: 'feb28',
  timelineOrder: 'oldest',
});

/** Offsets offered as one-tap choices; any whole number 0–365 is accepted. */
export const PRESET_REMINDER_OFFSETS = [0, 1, 3, 7] as const;
export const MAX_REMINDER_OFFSET_DAYS = 365;
