import { describe, expect, it } from 'vitest';

import { backupDue, type BackupReminderInput } from './backup-reminder';

const NOW = Date.parse('2026-10-25T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const item = (createdDaysAgo: number, updatedDaysAgo = createdDaysAgo) => ({
  createdAt: daysAgo(createdDaysAgo),
  updatedAt: daysAgo(updatedDaysAgo),
});
const input = (overrides: Partial<BackupReminderInput> = {}): BackupReminderInput => ({
  nowMs: NOW,
  lastBackupAt: null,
  dismissedAt: null,
  milestones: [],
  memories: [],
  ...overrides,
});

describe('backupDue', () => {
  it('waits for something to save, then two weeks, before the first offer', () => {
    expect(backupDue(input())).toBe(false);
    expect(backupDue(input({ memories: [item(3)] }))).toBe(false);
    expect(backupDue(input({ memories: [item(13)] }))).toBe(false);
    expect(backupDue(input({ memories: [item(14)] }))).toBe(true);
    // The oldest item counts, a date as much as a memory.
    expect(backupDue(input({ milestones: [item(40)], memories: [item(2)] }))).toBe(true);
  });

  it('stays quiet for 30 days after "Not now"', () => {
    const memories = [item(60)];
    expect(backupDue(input({ memories, dismissedAt: daysAgo(10) }))).toBe(false);
    expect(backupDue(input({ memories, dismissedAt: daysAgo(31) }))).toBe(true);
  });

  it('after an export, asks again only for a quarter with changes, or for many new memories', () => {
    // Nothing changed since the export, however old it is.
    expect(backupDue(input({ lastBackupAt: daysAgo(200), memories: [item(300)] }))).toBe(false);
    // A change since, and the export is 90 days old.
    expect(backupDue(input({ lastBackupAt: daysAgo(100), memories: [item(300, 50)] }))).toBe(true);
    expect(backupDue(input({ lastBackupAt: daysAgo(80), memories: [item(300, 50)] }))).toBe(false);
    // Ten new memories and two weeks.
    const many = Array.from({ length: 10 }, () => item(5));
    expect(backupDue(input({ lastBackupAt: daysAgo(20), memories: many }))).toBe(true);
    expect(backupDue(input({ lastBackupAt: daysAgo(10), memories: many }))).toBe(false);
    expect(backupDue(input({ lastBackupAt: daysAgo(20), memories: many.slice(0, 9) }))).toBe(false);
  });
});
