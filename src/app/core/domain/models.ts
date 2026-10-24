import type { IsoDate, LocalTime } from './local-date';
import type { AppLockDelay } from './app-lock';

/** ISO-8601 instant string (UTC), used only for record bookkeeping. */
export type IsoInstant = string;

export type ThemePreference = 'system' | 'light' | 'dark';
export type AccentPreset = 'berry' | 'sage';
export type CounterFormat = 'calendar' | 'days' | 'weeks';
export type WidgetPrivacyMode = 'normal' | 'discreet' | 'minimal';
export type LeapDayPolicy = 'feb28' | 'mar1';
export type Recurrence = 'none' | 'yearly';
export type TimelineOrder = 'oldest' | 'newest';
/** Which month counts since the start are celebrated as "together" milestones. */
export type TogetherMonthsMode = 'off' | 'key' | 'every';
export type LanguagePreference = 'system' | 'en' | 'fr' | 'nl';

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
  /** The partner's name (from `persons`): the placeholder typed here, or, once shared, their own. */
  displayName: string | null;
  /** The device owner's own name, shown as "Matthieu & Sam" once sharing exists. */
  selfName: string | null;
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

/** A member of the relationship. Exactly one person is the device owner (`isSelf`). */
export interface Person {
  id: string;
  displayName: string | null;
  isSelf: boolean;
  /** A partner name typed on this device, to be replaced by the partner's own once they join. */
  isPlaceholder: boolean;
}

/** An item in "Recently deleted" (kept 30 days, then purged). */
export interface TrashItem {
  kind: 'milestone' | 'memory';
  id: string;
  /** Milestone title or memory title (null for an untitled memory). */
  title: string | null;
  /** Event or memory date. */
  date: string;
  deletedAt: IsoInstant;
  /** For a milestone: memories that went to the trash with it and come back with it. */
  memoryCount: number;
  photoCount: number;
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
  /** Month milestones derived from the start date (1, 3, 6 months…). */
  togetherMonths: TogetherMonthsMode;
  /** Day-count milestones derived from the start date (100, 500, 1,000 days…). */
  togetherDays: boolean;
  /** Reminders for together milestones, using the default reminder time and offsets. */
  togetherReminders: boolean;
  language: LanguagePreference;
  /** Opt-in anonymous usage sharing; off unless the user turns it on. */
  usageSharing: boolean;
  /** The one-time invitation to share usage was answered (either way). */
  usagePromptAnswered: boolean;
  /** App lock with the phone's own unlock (docs/APP_LOCK.md); off by default. */
  appLock: boolean;
  /** Minutes in the background before the app locks again (0 = right away). */
  appLockAfter: AppLockDelay;
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
  togetherMonths: 'key',
  togetherDays: true,
  togetherReminders: false,
  language: 'system',
  usageSharing: false,
  usagePromptAnswered: false,
  appLock: false,
  appLockAfter: 1,
});

/** Offsets offered as one-tap choices; any whole number 0–365 is accepted. */
export const PRESET_REMINDER_OFFSETS = [0, 1, 3, 7] as const;
export const MAX_REMINDER_OFFSET_DAYS = 365;
