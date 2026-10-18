import {
  isValidIsoDate,
  isValidLocalTime,
  isValidTimeZoneId,
  toPlainDate,
  type IsoDate,
  type LocalTime,
} from './local-date';
import {
  MAX_REMINDER_OFFSET_DAYS,
  MILESTONE_CATEGORIES,
  type LeapDayPolicy,
  type MilestoneCategory,
  type Recurrence,
} from './models';
import { Temporal } from './temporal';

export type ValidationCode =
  | 'required'
  | 'invalidDate'
  | 'futureDate'
  | 'invalidTime'
  | 'invalidTimeZone'
  | 'tooLong'
  | 'invalidOffset'
  | 'duplicateOffset'
  | 'invalidCategory'
  | 'bodyOrPhotoRequired';

export type ValidationErrors<F extends string> = Partial<Record<F, ValidationCode>>;

export type ValidationResult<T, F extends string> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationErrors<F> };

export const LIMITS = {
  displayName: 60,
  relationshipLabel: 40,
  milestoneTitle: 80,
  milestoneNote: 2000,
  memoryTitle: 100,
  memoryBody: 5000,
} as const;

/** Trims a free-text field and converts blank strings to null. */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Relationship profile

export interface ProfileDraft {
  displayName: string | null;
  relationshipLabel: string | null;
  startDate: string;
  startTime: string | null;
  /** Zone in which an exact start time was entered. */
  startTimeZoneId: string | null;
  calendarTimeZoneId: string;
}

export interface ValidProfile {
  displayName: string | null;
  relationshipLabel: string | null;
  startDate: IsoDate;
  startTime: LocalTime | null;
  startTimeZoneId: string | null;
  calendarTimeZoneId: string;
}

export type ProfileField = 'displayName' | 'relationshipLabel' | 'startDate' | 'startTime' | 'calendarTimeZoneId';

export function validateProfile(
  draft: ProfileDraft,
  today: Temporal.PlainDate,
): ValidationResult<ValidProfile, ProfileField> {
  const errors: ValidationErrors<ProfileField> = {};
  const displayName = normalizeOptionalText(draft.displayName);
  const relationshipLabel = normalizeOptionalText(draft.relationshipLabel);
  if (displayName && displayName.length > LIMITS.displayName) errors.displayName = 'tooLong';
  if (relationshipLabel && relationshipLabel.length > LIMITS.relationshipLabel) {
    errors.relationshipLabel = 'tooLong';
  }

  const startDate = (draft.startDate ?? '').trim();
  if (!startDate) errors.startDate = 'required';
  else if (!isValidIsoDate(startDate)) errors.startDate = 'invalidDate';
  else if (Temporal.PlainDate.compare(toPlainDate(startDate), today) > 0) errors.startDate = 'futureDate';

  const startTime = normalizeOptionalText(draft.startTime);
  if (startTime && !isValidLocalTime(startTime)) errors.startTime = 'invalidTime';
  if (!isValidTimeZoneId(draft.calendarTimeZoneId)) errors.calendarTimeZoneId = 'invalidTimeZone';
  const startTimeZoneId = startTime ? draft.startTimeZoneId : null;
  if (startTime && !isValidTimeZoneId(startTimeZoneId)) errors.startTime = 'invalidTimeZone';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      displayName,
      relationshipLabel,
      startDate,
      startTime,
      startTimeZoneId,
      calendarTimeZoneId: draft.calendarTimeZoneId,
    },
  };
}

// ---------------------------------------------------------------------------
// Milestones

export interface ReminderDraft {
  offsetDays: number;
  localTime: string;
  includeEventTitle: boolean;
}

export interface MilestoneDraft {
  title: string;
  category: string;
  eventDate: string;
  eventTime: string | null;
  recurrence: Recurrence;
  leapDayPolicy: LeapDayPolicy | null;
  note: string | null;
  isPinned: boolean;
  remindersEnabled: boolean;
  reminders: ReminderDraft[];
}

export interface ValidMilestone {
  title: string;
  category: MilestoneCategory;
  eventDate: IsoDate;
  eventTime: LocalTime | null;
  recurrence: Recurrence;
  leapDayPolicy: LeapDayPolicy | null;
  note: string | null;
  isPinned: boolean;
  remindersEnabled: boolean;
  reminders: ReminderDraft[];
}

export type MilestoneField = 'title' | 'category' | 'eventDate' | 'eventTime' | 'note' | 'reminders';

export function isValidReminderOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_OFFSET_DAYS;
}

export function validateMilestone(draft: MilestoneDraft): ValidationResult<ValidMilestone, MilestoneField> {
  const errors: ValidationErrors<MilestoneField> = {};
  const title = (draft.title ?? '').trim();
  if (!title) errors.title = 'required';
  else if (title.length > LIMITS.milestoneTitle) errors.title = 'tooLong';

  if (!(MILESTONE_CATEGORIES as readonly string[]).includes(draft.category)) errors.category = 'invalidCategory';

  const eventDate = (draft.eventDate ?? '').trim();
  if (!eventDate) errors.eventDate = 'required';
  else if (!isValidIsoDate(eventDate)) errors.eventDate = 'invalidDate';

  const eventTime = normalizeOptionalText(draft.eventTime);
  if (eventTime && !isValidLocalTime(eventTime)) errors.eventTime = 'invalidTime';

  const note = normalizeOptionalText(draft.note);
  if (note && note.length > LIMITS.milestoneNote) errors.note = 'tooLong';

  const reminders = draft.remindersEnabled ? draft.reminders : [];
  const seen = new Set<number>();
  for (const reminder of reminders) {
    if (!isValidReminderOffset(reminder.offsetDays) || !isValidLocalTime(reminder.localTime)) {
      errors.reminders = 'invalidOffset';
      break;
    }
    if (seen.has(reminder.offsetDays)) {
      errors.reminders = 'duplicateOffset';
      break;
    }
    seen.add(reminder.offsetDays);
  }
  if (draft.remindersEnabled && reminders.length === 0) errors.reminders = 'required';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      category: draft.category as MilestoneCategory,
      eventDate,
      eventTime,
      recurrence: draft.recurrence === 'yearly' ? 'yearly' : 'none',
      leapDayPolicy: draft.leapDayPolicy,
      note,
      isPinned: draft.isPinned,
      remindersEnabled: draft.remindersEnabled,
      reminders: [...reminders].sort((a, b) => b.offsetDays - a.offsetDays),
    },
  };
}

// ---------------------------------------------------------------------------
// Memories

export interface MemoryDraft {
  title: string | null;
  body: string | null;
  memoryDate: string;
  milestoneId: string | null;
  photoCount: number;
}

export interface ValidMemory {
  title: string | null;
  body: string | null;
  memoryDate: IsoDate;
  milestoneId: string | null;
}

export type MemoryField = 'title' | 'body' | 'memoryDate';

export function validateMemory(draft: MemoryDraft): ValidationResult<ValidMemory, MemoryField> {
  const errors: ValidationErrors<MemoryField> = {};
  const title = normalizeOptionalText(draft.title);
  const body = normalizeOptionalText(draft.body);
  if (title && title.length > LIMITS.memoryTitle) errors.title = 'tooLong';
  if (body && body.length > LIMITS.memoryBody) errors.body = 'tooLong';
  if (!body && draft.photoCount === 0) errors.body = 'bodyOrPhotoRequired';
  const memoryDate = (draft.memoryDate ?? '').trim();
  if (!memoryDate) errors.memoryDate = 'required';
  else if (!isValidIsoDate(memoryDate)) errors.memoryDate = 'invalidDate';
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { title, body, memoryDate, milestoneId: draft.milestoneId } };
}
