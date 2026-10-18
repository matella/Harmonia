import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Milestone, RelationshipProfile, ReminderRule } from '../app/core/domain/models';
import { DEFAULT_SETTINGS, type AppSettings } from '../app/core/domain/models';
import { EN } from '../app/core/i18n/messages.en';
import { Translator } from '../app/core/i18n/translator';

export interface DateVectors {
  calendarDuration: {
    name: string;
    start: string;
    end: string;
    years: number;
    months: number;
    days: number;
    totalDays: number;
  }[];
  annualOccurrence: {
    name: string;
    eventDate: string;
    today: string;
    policy: 'feb28' | 'mar1';
    next: string;
    daysUntil: number;
    occurrenceNumber: number;
  }[];
}

export function loadDateVectors(): DateVectors {
  const path = resolve(__dirname, '../../shared/test-vectors/date-vectors.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as DateVectors;
}

export const translator = new Translator(EN, 'en');

const STAMP = '2026-01-01T00:00:00Z';

export function makeProfile(overrides: Partial<RelationshipProfile> = {}): RelationshipProfile {
  return {
    displayName: null,
    relationshipLabel: null,
    startDate: '2024-06-14',
    startTime: null,
    startTimeZoneId: null,
    calendarTimeZoneId: 'Europe/Brussels',
    photoPath: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

let counter = 0;
export function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  counter += 1;
  return {
    id: `m-${counter}`,
    title: `Milestone ${counter}`,
    category: 'custom',
    eventDate: '2024-06-14',
    eventTime: null,
    eventTimeZoneId: null,
    recurrence: 'none',
    leapDayPolicy: null,
    note: null,
    photoPath: null,
    isPinned: false,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

export function makeRule(milestoneId: string, overrides: Partial<ReminderRule> = {}): ReminderRule {
  counter += 1;
  return {
    id: `r-${counter}`,
    milestoneId,
    offsetDays: 0,
    localTime: '09:00',
    isEnabled: true,
    includeEventTitle: false,
    notificationId: 1000 + counter,
    createdAt: STAMP,
    updatedAt: STAMP,
    ...overrides,
  };
}

export function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, defaultReminderOffsets: [...DEFAULT_SETTINGS.defaultReminderOffsets], ...overrides };
}
