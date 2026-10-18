import { Injectable, computed, inject, signal } from '@angular/core';

import { fixedClock } from '../domain/clock';
import { todayIn } from '../domain/local-date';
import { sortedPast, sortedUpcoming } from '../domain/milestone-occurrence';
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type Memory,
  type Milestone,
  type RelationshipProfile,
  type ReminderRule,
} from '../domain/models';
import { computeRelationshipCounter } from '../domain/relationship-duration';
import type { Temporal } from '../domain/temporal';
import { CLOCK } from '../services/tokens';

export type AppStatus = 'loading' | 'ready' | 'error';

export interface StartupFailure {
  kind: 'migration' | 'too-new' | 'unknown';
  detail: string;
}

/**
 * Single source of UI state, held in signals and refreshed from the repositories after
 * every write. Derived values (counter, upcoming dates) are computed from persisted
 * data and the `now` signal — they are never stored.
 */
@Injectable({ providedIn: 'root' })
export class AppStore {
  private readonly clock = inject(CLOCK);

  readonly status = signal<AppStatus>('loading');
  readonly failure = signal<StartupFailure | null>(null);

  readonly profile = signal<RelationshipProfile | null>(null);
  readonly milestones = signal<Milestone[]>([]);
  readonly rules = signal<ReminderRule[]>([]);
  readonly memories = signal<Memory[]>([]);
  readonly settings = signal<AppSettings>({ ...DEFAULT_SETTINGS, defaultReminderOffsets: [...DEFAULT_SETTINGS.defaultReminderOffsets] });

  /** Current instant, refreshed on resume and at minute boundaries while foregrounded. */
  readonly now = signal<Temporal.Instant>(this.clock.now());
  readonly deviceTimeZone = signal<string>(this.clock.timeZoneId());

  readonly hasProfile = computed(() => this.profile() !== null);

  /** "Today" in the profile's calendar zone (device zone before onboarding). */
  readonly today = computed(() => {
    const zone = this.profile()?.calendarTimeZoneId ?? this.deviceTimeZone();
    return todayIn(fixedClock(this.now().toString(), this.deviceTimeZone()), zone);
  });

  readonly counter = computed(() => {
    const profile = this.profile();
    if (!profile) return null;
    return computeRelationshipCounter(profile, fixedClock(this.now().toString(), this.deviceTimeZone()));
  });

  readonly upcoming = computed(() => sortedUpcoming(this.milestones(), this.today(), this.settings().leapDayPolicy));
  readonly past = computed(() => sortedPast(this.milestones(), this.today()));
  readonly nextUpcoming = computed(() => this.upcoming()[0] ?? null);

  readonly rulesByMilestone = computed(() => {
    const map = new Map<string, ReminderRule[]>();
    for (const rule of this.rules()) {
      const list = map.get(rule.milestoneId) ?? [];
      list.push(rule);
      map.set(rule.milestoneId, list);
    }
    return map;
  });

  readonly memoriesByMilestone = computed(() => {
    const map = new Map<string, Memory[]>();
    for (const memory of this.memories()) {
      if (!memory.milestoneId) continue;
      const list = map.get(memory.milestoneId) ?? [];
      list.push(memory);
      map.set(memory.milestoneId, list);
    }
    return map;
  });

  milestoneById(id: string): Milestone | null {
    return this.milestones().find((m) => m.id === id) ?? null;
  }

  memoryById(id: string): Memory | null {
    return this.memories().find((m) => m.id === id) ?? null;
  }

  tick(): void {
    this.now.set(this.clock.now());
    const zone = this.clock.timeZoneId();
    if (zone !== this.deviceTimeZone()) this.deviceTimeZone.set(zone);
  }
}
