import { describe, expect, it } from 'vitest';

import { toPlainDate } from './local-date';
import {
  validateMemory,
  validateMilestone,
  validateProfile,
  type MilestoneDraft,
  type ProfileDraft,
} from './validation';

const today = toPlainDate('2026-10-18');

const profileDraft = (overrides: Partial<ProfileDraft> = {}): ProfileDraft => ({
  displayName: null,
  relationshipLabel: null,
  startDate: '2024-06-14',
  startTime: null,
  startTimeZoneId: null,
  calendarTimeZoneId: 'Europe/Brussels',
  ...overrides,
});

const milestoneDraft = (overrides: Partial<MilestoneDraft> = {}): MilestoneDraft => ({
  title: 'First trip',
  category: 'first_trip',
  eventDate: '2025-05-01',
  eventTime: null,
  recurrence: 'none',
  leapDayPolicy: null,
  note: null,
  isPinned: false,
  remindersEnabled: false,
  reminders: [],
  ...overrides,
});

describe('validateProfile', () => {
  it('accepts a minimal date-only profile and normalizes blanks to null', () => {
    const result = validateProfile(profileDraft({ displayName: '   ', startTime: '' }), today);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ displayName: null, startTime: null, startTimeZoneId: null }),
    });
  });

  it('accepts today as a start date but rejects the future', () => {
    expect(validateProfile(profileDraft({ startDate: '2026-10-18' }), today).ok).toBe(true);
    expect(validateProfile(profileDraft({ startDate: '2026-10-19' }), today)).toEqual({
      ok: false,
      errors: { startDate: 'futureDate' },
    });
  });

  it('rejects impossible dates and missing dates', () => {
    expect(validateProfile(profileDraft({ startDate: '2023-02-29' }), today)).toMatchObject({
      errors: { startDate: 'invalidDate' },
    });
    expect(validateProfile(profileDraft({ startDate: '' }), today)).toMatchObject({ errors: { startDate: 'required' } });
  });

  it('keeps the start zone only when an exact time is present', () => {
    const timed = validateProfile(profileDraft({ startTime: '20:15', startTimeZoneId: 'Europe/Brussels' }), today);
    expect(timed.ok && timed.value.startTimeZoneId).toBe('Europe/Brussels');
    const untimed = validateProfile(profileDraft({ startTimeZoneId: 'Europe/Brussels' }), today);
    expect(untimed.ok && untimed.value.startTimeZoneId).toBeNull();
    expect(validateProfile(profileDraft({ startTime: '25:00', startTimeZoneId: 'UTC' }), today)).toMatchObject({
      errors: { startTime: 'invalidTime' },
    });
  });

  it('limits name length', () => {
    expect(validateProfile(profileDraft({ displayName: 'x'.repeat(61) }), today)).toMatchObject({
      errors: { displayName: 'tooLong' },
    });
  });
});

describe('validateMilestone', () => {
  it('rejects blank and whitespace-only titles', () => {
    expect(validateMilestone(milestoneDraft({ title: '   ' }))).toMatchObject({ errors: { title: 'required' } });
  });

  it('allows past and future dates but not impossible ones', () => {
    expect(validateMilestone(milestoneDraft({ eventDate: '2030-01-01' })).ok).toBe(true);
    expect(validateMilestone(milestoneDraft({ eventDate: '2025-02-30' }))).toMatchObject({
      errors: { eventDate: 'invalidDate' },
    });
  });

  it('validates the optional time', () => {
    expect(validateMilestone(milestoneDraft({ eventTime: '7pm' }))).toMatchObject({ errors: { eventTime: 'invalidTime' } });
  });

  it('rejects duplicate and out-of-range reminder offsets', () => {
    const r = (offsetDays: number) => ({ offsetDays, localTime: '09:00', includeEventTitle: false });
    expect(validateMilestone(milestoneDraft({ remindersEnabled: true, reminders: [r(1), r(1)] }))).toMatchObject({
      errors: { reminders: 'duplicateOffset' },
    });
    expect(validateMilestone(milestoneDraft({ remindersEnabled: true, reminders: [r(-1)] }))).toMatchObject({
      errors: { reminders: 'invalidOffset' },
    });
    expect(validateMilestone(milestoneDraft({ remindersEnabled: true, reminders: [r(1.5)] }))).toMatchObject({
      errors: { reminders: 'invalidOffset' },
    });
    expect(validateMilestone(milestoneDraft({ remindersEnabled: true, reminders: [] }))).toMatchObject({
      errors: { reminders: 'required' },
    });
  });

  it('drops reminder drafts when reminders are disabled', () => {
    const result = validateMilestone(
      milestoneDraft({ remindersEnabled: false, reminders: [{ offsetDays: 1, localTime: '09:00', includeEventTitle: false }] }),
    );
    expect(result.ok && result.value.reminders).toEqual([]);
  });

  it('rejects unknown categories', () => {
    expect(validateMilestone(milestoneDraft({ category: 'promotion' }))).toMatchObject({
      errors: { category: 'invalidCategory' },
    });
  });
});

describe('validateMemory', () => {
  it('requires a note or at least one photo', () => {
    const base = { title: 'Lisbon', body: null, memoryDate: '2025-05-01', milestoneId: null };
    expect(validateMemory({ ...base, photoCount: 0 })).toMatchObject({ errors: { body: 'bodyOrPhotoRequired' } });
    expect(validateMemory({ ...base, photoCount: 2 }).ok).toBe(true);
    expect(validateMemory({ ...base, body: 'Sunset on the river', photoCount: 0 }).ok).toBe(true);
  });
});
