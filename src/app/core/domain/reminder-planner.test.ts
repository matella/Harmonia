import { describe, expect, it } from 'vitest';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { makeMilestone, makeRule, settings, translator } from '../../../testing/fixtures';
import { createReminderCopy } from '../i18n/reminder-copy';
import type { Memory, Milestone, ReminderRule } from './models';
import {
  MAX_PENDING_NOTIFICATIONS,
  MEMORY_NOTIFICATION_ID_BASE,
  memoryNotificationId,
  planReminders,
  TOGETHER_NOTIFICATION_ID_BASE,
  togetherNotificationId,
} from './reminder-planner';
import { MAX_TOGETHER_DAYS } from './together-milestones';
import { reconcileReminders } from './reminder-reconciler';
import { Temporal } from './temporal';

const copy = createReminderCopy(translator);

function plan(
  milestones: Milestone[],
  rules: ReminderRule[],
  now: string,
  zone = 'Europe/Brussels',
  overrides: Parameters<typeof settings>[0] = {},
) {
  return planReminders({
    milestones,
    rules,
    settings: settings(overrides),
    now: Temporal.Instant.from(now),
    deviceTimeZoneId: zone,
    copy,
  });
}

describe('planReminders', () => {
  it('schedules an offset reminder at the local wall-clock time', () => {
    const m = makeMilestone({ eventDate: '2026-11-01' });
    const result = plan([m], [makeRule(m.id, { offsetDays: 1, localTime: '09:00' })], '2026-10-18T10:00:00Z');
    expect(result).toHaveLength(1);
    // 31 Oct 09:00 in Brussels is CET (+01:00) after the 25 Oct DST change.
    expect(result[0].fireAt.toString()).toBe('2026-10-31T08:00:00Z');
    expect(result[0].occurrenceDate).toBe('2026-11-01');
    expect(result[0].route).toBe(`/milestone/${m.id}`);
  });

  it('never schedules disabled reminders or anything when reminders are globally off', () => {
    const m = makeMilestone({ eventDate: '2026-11-01' });
    expect(plan([m], [makeRule(m.id, { isEnabled: false })], '2026-10-18T10:00:00Z')).toEqual([]);
    expect(plan([m], [makeRule(m.id)], '2026-10-18T10:00:00Z', 'Europe/Brussels', { remindersEnabled: false })).toEqual([]);
  });

  it('moves a yearly reminder to next year once today’s time has passed', () => {
    const m = makeMilestone({ eventDate: '2020-10-18', recurrence: 'yearly' });
    const result = plan([m], [makeRule(m.id, { localTime: '09:00' })], '2026-10-18T08:00:00Z'); // 10:00 local
    expect(result[0].occurrenceDate).toBe('2027-10-18');
  });

  it('still fires later today if the reminder time has not passed', () => {
    const m = makeMilestone({ eventDate: '2020-10-18', recurrence: 'yearly' });
    const result = plan([m], [makeRule(m.id, { localTime: '18:00' })], '2026-10-18T08:00:00Z');
    expect(result[0].occurrenceDate).toBe('2026-10-18');
    expect(result[0].body).toBe('A special date is today.');
  });

  it('skips to the following year when the offset already passed, and drops passed one-offs', () => {
    const yearly = makeMilestone({ eventDate: '2020-10-20', recurrence: 'yearly' });
    const oneOff = makeMilestone({ eventDate: '2026-10-20' });
    const result = plan(
      [yearly, oneOff],
      [makeRule(yearly.id, { offsetDays: 7 }), makeRule(oneOff.id, { offsetDays: 7 })],
      '2026-10-18T10:00:00Z',
    );
    expect(result).toHaveLength(1);
    expect(result[0].milestoneId).toBe(yearly.id);
    expect(result[0].occurrenceDate).toBe('2027-10-20');
  });

  it('handles offsets longer than the distance to the next occurrence', () => {
    const m = makeMilestone({ eventDate: '2020-11-01', recurrence: 'yearly' });
    const result = plan([m], [makeRule(m.id, { offsetDays: 365 })], '2026-10-18T10:00:00Z');
    expect(result[0].occurrenceDate).toBe('2027-11-01');
    expect(result[0].fireAt.toZonedDateTimeISO('Europe/Brussels').toPlainDate().toString()).toBe('2026-11-01');
  });

  it('applies the leap-day policy to scheduling', () => {
    const m = makeMilestone({ eventDate: '2024-02-29', recurrence: 'yearly' });
    const rule = makeRule(m.id);
    expect(plan([m], [rule], '2026-10-18T10:00:00Z')[0].occurrenceDate).toBe('2027-02-28');
    expect(plan([m], [rule], '2026-10-18T10:00:00Z', 'Europe/Brussels', { leapDayPolicy: 'mar1' })[0].occurrenceDate).toBe(
      '2027-03-01',
    );
  });

  it('keeps notifications discreet unless the title is allowed', () => {
    const m = makeMilestone({ eventDate: '2026-11-01', title: 'Our anniversary' });
    const [discreet] = plan([m], [makeRule(m.id, { offsetDays: 1 })], '2026-10-18T10:00:00Z');
    const [named] = plan([m], [makeRule(m.id, { offsetDays: 3, includeEventTitle: true })], '2026-10-18T10:00:00Z');
    expect(discreet.body).toBe('A special date is tomorrow.');
    expect(discreet.body).not.toContain('anniversary');
    expect(named.body).toBe('Our anniversary is in 3 days.');
    expect(discreet.title).toBe('Harmonia');
  });

  it('resolves a reminder time inside a DST gap to the shifted local time', () => {
    const m = makeMilestone({ eventDate: '2027-03-28' }); // EU clocks jump 02:00 → 03:00
    const [n] = plan([m], [makeRule(m.id, { localTime: '02:30' })], '2026-10-18T10:00:00Z');
    expect(n.fireAt.toZonedDateTimeISO('Europe/Brussels').toPlainTime().toString()).toBe('03:30:00');
  });

  it('ignores rules whose milestone no longer exists', () => {
    expect(plan([], [makeRule('deleted')], '2026-10-18T10:00:00Z')).toEqual([]);
  });

  it('caps the plan below the iOS pending-notification limit, keeping the soonest', () => {
    const milestones = Array.from({ length: 80 }, (_, i) =>
      makeMilestone({ eventDate: Temporal.PlainDate.from('2026-11-01').add({ days: i }).toString() }),
    );
    const result = plan(milestones, milestones.map((m) => makeRule(m.id)), '2026-10-18T10:00:00Z');
    expect(result).toHaveLength(MAX_PENDING_NOTIFICATIONS);
    expect(result[0].occurrenceDate).toBe('2026-11-01');
    const times = result.map((n) => n.fireAt.epochMilliseconds);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('reconcileReminders', () => {
  it('produces no duplicates when the same plan is reconciled repeatedly', async () => {
    const port = new FakeNotificationPort();
    const m = makeMilestone({ eventDate: '2026-11-01' });
    const rules = [makeRule(m.id, { offsetDays: 0 }), makeRule(m.id, { offsetDays: 1 })];
    const p = plan([m], rules, '2026-10-18T10:00:00Z');
    await reconcileReminders(port, p);
    const report = await reconcileReminders(port, p);
    expect(port.pending.size).toBe(2);
    expect(report).toMatchObject({ planned: 2, stale: 0, missing: 0 });
  });

  it('replaces rather than duplicates when a milestone is edited across time zones', async () => {
    const port = new FakeNotificationPort();
    const m = makeMilestone({ eventDate: '2026-11-01' });
    const rule = makeRule(m.id, { offsetDays: 1, localTime: '09:00' });
    await reconcileReminders(port, plan([m], [rule], '2026-10-18T10:00:00Z', 'Europe/Brussels'));
    // The user flies to New York and moves the date; the rule keeps its notification ID.
    const edited = { ...m, eventDate: '2026-11-05' };
    await reconcileReminders(port, plan([edited], [rule], '2026-10-19T15:00:00Z', 'America/New_York'));
    expect(port.pending.size).toBe(1);
    const n = port.pending.get(rule.notificationId)!;
    expect(n.occurrenceDate).toBe('2026-11-05');
    expect(n.fireAt.toZonedDateTimeISO('America/New_York').toPlainDateTime().toString()).toBe('2026-11-04T09:00:00');
  });

  it('cancels reminders of deleted milestones and removed offsets', async () => {
    const port = new FakeNotificationPort();
    const a = makeMilestone({ eventDate: '2026-11-01' });
    const b = makeMilestone({ eventDate: '2026-12-01' });
    const ruleA = makeRule(a.id);
    const ruleB0 = makeRule(b.id, { offsetDays: 0 });
    const ruleB1 = makeRule(b.id, { offsetDays: 1 });
    await reconcileReminders(port, plan([a, b], [ruleA, ruleB0, ruleB1], '2026-10-18T10:00:00Z'));
    expect(port.pending.size).toBe(3);
    const report = await reconcileReminders(port, plan([b], [ruleB0], '2026-10-18T10:00:00Z'));
    expect([...port.pending.keys()]).toEqual([ruleB0.notificationId]);
    expect(report.cancelled).toBe(2);
  });

  it('clears pending requests and reports when permission is denied', async () => {
    const port = new FakeNotificationPort();
    const m = makeMilestone({ eventDate: '2026-11-01' });
    await reconcileReminders(port, plan([m], [makeRule(m.id)], '2026-10-18T10:00:00Z'));
    port.permission = 'denied';
    const report = await reconcileReminders(port, plan([m], [makeRule(m.id)], '2026-10-18T10:00:00Z'));
    expect(report.permission).toBe('denied');
    expect(report.scheduled).toBe(0);
    expect(port.pending.size).toBe(0);
  });

  it('restores missing notifications after an OS reset (e.g. reboot or reinstall)', async () => {
    const port = new FakeNotificationPort();
    const m = makeMilestone({ eventDate: '2026-11-01' });
    const p = plan([m], [makeRule(m.id)], '2026-10-18T10:00:00Z');
    await reconcileReminders(port, p);
    port.pending.clear();
    const report = await reconcileReminders(port, p);
    expect(report.missing).toBe(1);
    expect(port.pending.size).toBe(1);
  });
});

describe('together-milestone reminders', () => {
  const together = (revealTitle: boolean) => ({
    startDate: '2024-06-14',
    options: { months: 'key', days: true, skipWholeYears: false } as const,
    offsets: [1, 0],
    localTime: '09:00',
    revealTitle,
  });
  const run = (revealTitle: boolean, now = '2026-10-18T10:00:00Z') =>
    planReminders({
      milestones: [],
      rules: [],
      settings: settings(),
      now: Temporal.Instant.from(now),
      deviceTimeZoneId: 'Europe/Brussels',
      copy,
      together: together(revealTitle),
    });

  it('plans nothing unless together reminders are passed in', () => {
    expect(plan([], [], '2026-10-18T10:00:00Z')).toEqual([]);
  });

  it('schedules the next month and day milestone for each default offset', () => {
    const result = run(false);
    expect(result.map((n) => `${n.ruleId}@${n.fireAt.toString()}`)).toEqual([
      'together:months:30:1@2026-12-13T08:00:00Z',
      'together:months:30:0@2026-12-14T08:00:00Z',
      'together:days:1000:1@2027-03-10T08:00:00Z',
      'together:days:1000:0@2027-03-11T08:00:00Z',
    ]);
    expect(result.every((n) => n.route === '/counter' && n.milestoneId === null)).toBe(true);
    expect(result.every((n) => n.notificationId >= TOGETHER_NOTIFICATION_ID_BASE)).toBe(true);
    expect(new Set(result.map((n) => n.notificationId)).size).toBe(4);
  });

  it('stays discreet unless titles may be shown', () => {
    expect(run(false)[0].body).toBe('A special date is tomorrow.');
    expect(run(true)[0].body).toBe('Tomorrow you’ll have been together for 2 years, 6 months.');
    expect(run(true)[3].body).toBe('Today you’ve been together for 1,000 days.');
  });

  it('is idempotent and moves on once a milestone has passed', () => {
    expect(run(false).map((n) => n.notificationId)).toEqual(run(false).map((n) => n.notificationId));
    const later = run(false, '2026-12-14T09:00:00Z');
    expect(later.map((n) => n.ruleId)).toEqual([
      'together:days:1000:1',
      'together:days:1000:0',
      'together:months:36:1',
      'together:months:36:0',
    ]);
  });

  it('derives IDs inside the reserved 32-bit range', () => {
    expect(togetherNotificationId('months', 1, 0)).toBeGreaterThanOrEqual(TOGETHER_NOTIFICATION_ID_BASE);
    expect(togetherNotificationId('days', MAX_TOGETHER_DAYS, 365)).toBeLessThan(2 ** 31);
    expect(togetherNotificationId('months', 6, 1)).not.toBe(togetherNotificationId('days', 6, 1));
    expect(() => togetherNotificationId('days', MAX_TOGETHER_DAYS + 1, 0)).toThrow(RangeError);
  });
});

describe('memory reminders ("on this day")', () => {
  const memory = (id: string, memoryDate: string, title: string | null = id): Memory => ({
    id,
    milestoneId: null,
    title,
    body: null,
    memoryDate,
    media: [],
    createdAt: '2025-01-01T10:00:00Z',
    updatedAt: '2025-01-01T10:00:00Z',
  });
  const run = (memories: Memory[], now: string, revealTitle = false, overrides = {}) =>
    planReminders({
      milestones: [],
      rules: [],
      settings: settings(overrides),
      now: Temporal.Instant.from(now),
      deviceTimeZoneId: 'Europe/Brussels',
      copy,
      memoryReminders: { memories, localTime: '09:00', revealTitle },
    });

  it('plans one reminder on the anniversary, discreet unless titles are allowed', () => {
    const [discreet] = run([memory('lisbon', '2024-11-01', 'Lisbon')], '2026-10-25T10:00:00Z');
    expect(discreet).toMatchObject({
      ruleId: 'memory:2026-11-01',
      route: '/memory/lisbon',
      milestoneId: null,
      occurrenceDate: '2026-11-01',
      body: 'A memory from 2 years ago today.',
    });
    expect(discreet.fireAt.toString()).toBe('2026-11-01T08:00:00Z');
    const [named] = run([memory('lisbon', '2024-11-01', 'Lisbon')], '2026-10-25T10:00:00Z', true);
    expect(named.body).toBe('“Lisbon”, 2 years ago today.');
    // An untitled memory stays discreet even when titles are allowed… it has no title to show.
    expect(run([memory('x', '2025-11-01', null)], '2026-10-25T10:00:00Z', true)[0].body).toBe(
      'A memory from 1 year ago today.',
    );
  });

  it('skips today when its time has passed, keeps at most a weekly rhythm, and obeys the master switch', () => {
    const memories = [memory('today', '2025-10-25'), memory('soon', '2025-10-28'), memory('later', '2025-11-05')];
    const planned = run(memories, '2026-10-25T10:00:00Z'); // 11:00 local: today's 09:00 has passed
    expect(planned.map((n) => n.occurrenceDate)).toEqual(['2026-11-05']); // "soon" fell inside the gap of "today"
    expect(run(memories, '2026-10-25T10:00:00Z', false, { remindersEnabled: false })).toEqual([]);
  });

  it('derives IDs from the day, inside the 32-bit range and apart from together reminders', () => {
    const id = memoryNotificationId(Temporal.PlainDate.from('2026-11-01'));
    expect(id).toBeGreaterThan(MEMORY_NOTIFICATION_ID_BASE);
    expect(id).toBeLessThan(2 ** 31);
    expect(id).toBeGreaterThan(togetherNotificationId('days', MAX_TOGETHER_DAYS, 365));
  });
});
