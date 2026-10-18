import { Temporal } from './temporal';

/**
 * The only source of "now" for domain logic. Never call Date.now() or Temporal.Now
 * outside an implementation of this interface: injecting a clock keeps every date
 * rule deterministic and testable.
 */
export interface Clock {
  now(): Temporal.Instant;
  /** The device's current IANA time zone. */
  timeZoneId(): string;
}

export const systemClock: Clock = {
  now: () => Temporal.Now.instant(),
  timeZoneId: () => Temporal.Now.timeZoneId(),
};

/** A clock frozen at a given instant and zone, for tests and previews. */
export function fixedClock(instant: string, timeZoneId: string): Clock {
  const fixed = Temporal.Instant.from(instant);
  return { now: () => fixed, timeZoneId: () => timeZoneId };
}

/** A clock whose time can be moved in tests. */
export class MutableClock implements Clock {
  private current: Temporal.Instant;

  constructor(
    instant: string,
    private zone: string,
  ) {
    this.current = Temporal.Instant.from(instant);
  }

  now(): Temporal.Instant {
    return this.current;
  }

  timeZoneId(): string {
    return this.zone;
  }

  set(instant: string): void {
    this.current = Temporal.Instant.from(instant);
  }

  setTimeZone(zone: string): void {
    this.zone = zone;
  }
}
