import { describe, expect, it } from 'vitest';

import { FakeNotificationPort } from '../../../testing/fake-notification-port';
import { makeMilestone, makeRule, settings, translator } from '../../../testing/fixtures';
import { createReminderCopy } from '../i18n/reminder-copy';
import type { Milestone, ReminderRule } from './models';
import { MAX_PENDING_NOTIFICATIONS, planReminders } from './reminder-planner';
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
