import { describe, expect, it } from 'vitest';

import { makeMilestone, makeProfile, settings } from '../../../testing/fixtures';
import { fixedClock } from './clock';
import { buildWidgetSnapshot, snapshotFingerprint, WIDGET_SNAPSHOT_SCHEMA_VERSION } from './widget-snapshot';

const clock = fixedClock('2026-10-18T10:00:00Z', 'Europe/Brussels');
const profile = makeProfile({ displayName: 'Sam', startDate: '2024-06-14' });
const milestones = [
  makeMilestone({ title: 'Our anniversary', eventDate: '2024-06-14', recurrence: 'yearly', note: 'secret note' }),
  makeMilestone({ title: 'Concert', eventDate: '2026-11-02' }),
  makeMilestone({ title: 'Long ago', eventDate: '2020-01-01' }),
];

describe('buildWidgetSnapshot', () => {
  it('includes names and upcoming titles only in normal mode', () => {
    const snapshot = buildWidgetSnapshot({ profile, milestones, settings: settings({ widgetPrivacy: 'normal' }), clock });
    expect(snapshot).toMatchObject({
      schemaVersion: WIDGET_SNAPSHOT_SCHEMA_VERSION,
      state: 'ready',
      displayName: 'Sam',
      startDate: '2024-06-14',
      calendarTimeZoneId: 'Europe/Brussels',
    });
    expect(snapshot.upcoming).toEqual([
      { title: 'Concert', date: '2026-11-02' },
      { title: 'Our anniversary', date: '2027-06-14' },
    ]);
  });

  it('hides names and milestone details in discreet mode', () => {
    const snapshot = buildWidgetSnapshot({ profile, milestones, settings: settings({ widgetPrivacy: 'discreet' }), clock });
    expect(snapshot.displayName).toBeNull();
    expect(snapshot.upcoming).toEqual([]);
    expect(snapshot.startDate).toBe('2024-06-14');
  });

  it('forces a plain day count in minimal mode', () => {
    const snapshot = buildWidgetSnapshot({
      profile,
      milestones,
      settings: settings({ widgetPrivacy: 'minimal', widgetCounterMode: 'calendar' }),
      clock,
    });
    expect(snapshot.counterMode).toBe('days');
    expect(snapshot.displayName).toBeNull();
  });

  it('never leaks notes, photos or record IDs', () => {
    const snapshot = buildWidgetSnapshot({
      profile: { ...profile, photoPath: 'media/profile.jpg' },
      milestones: milestones.map((m) => ({ ...m, photoPath: 'media/x.jpg' })),
      settings: settings({ widgetPrivacy: 'normal' }),
      clock,
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain('secret note');
    expect(json).not.toContain('media/');
    for (const m of milestones) expect(json).not.toContain(m.id);
  });

  it('produces a privacy-safe placeholder without a profile', () => {
    const snapshot = buildWidgetSnapshot({ profile: null, milestones, settings: settings({ widgetPrivacy: 'normal' }), clock });
    expect(snapshot).toMatchObject({ state: 'empty', startDate: null, displayName: null, upcoming: [] });
  });

  it('fingerprints content independently of the generation time', () => {
    const later = fixedClock('2026-10-18T11:00:00Z', 'Europe/Brussels');
    const a = buildWidgetSnapshot({ profile, milestones, settings: settings(), clock });
    const b = buildWidgetSnapshot({ profile, milestones, settings: settings(), clock: later });
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
    const c = buildWidgetSnapshot({ profile, milestones, settings: settings({ widgetPrivacy: 'normal' }), clock });
    expect(snapshotFingerprint(c)).not.toBe(snapshotFingerprint(a));
  });
});
