import { describe, expect, it } from 'vitest';

import {
  compareHlc,
  formatHlc,
  HLC_PATTERN,
  isTooFarAhead,
  MAX_FUTURE_DRIFT_MS,
  newHlcNode,
  observeHlc,
  parseHlc,
  tickHlc,
  ZERO_HLC,
} from './hlc';

const NODE = '0000abcd';
// The server's own check (supabase/migrations/…_sharing_init.sql).
const SERVER_PATTERN = /^[0-9]{13}-[0-9]{6}-[0-9a-f]{8}$/;

describe('hybrid logical clock', () => {
  it('formats exactly like the server expects and round-trips', () => {
    const v = formatHlc({ ms: 1_792_317_600_000, counter: 7, node: NODE });
    expect(v).toBe('1792317600000-000007-0000abcd');
    expect(v).toMatch(SERVER_PATTERN);
    expect(HLC_PATTERN.source).toBe(SERVER_PATTERN.source);
    expect(parseHlc(v)).toEqual({ ms: 1_792_317_600_000, counter: 7, node: NODE });
    expect(ZERO_HLC).toMatch(SERVER_PATTERN);
  });

  it('increases strictly, within and across milliseconds', () => {
    const a = tickHlc(null, 1000, NODE);
    const b = tickHlc(a, 1000, NODE);
    const c = tickHlc(b, 2000, NODE);
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, c)).toBe(-1);
    expect(parseHlc(b).counter).toBe(1);
    expect(parseHlc(c)).toMatchObject({ ms: 2000, counter: 0 });
  });

  it('never goes backwards when the device clock does', () => {
    const late = tickHlc(null, 5_000_000, NODE);
    const afterJumpBack = tickHlc(late, 1_000, NODE);
    expect(compareHlc(afterJumpBack, late)).toBe(1);
    expect(parseHlc(afterJumpBack).ms).toBe(5_000_000);
  });

  it('carries a full counter into the next millisecond', () => {
    const full = formatHlc({ ms: 1000, counter: 999_999, node: NODE });
    const next = tickHlc(full, 1000, NODE);
    expect(parseHlc(next)).toMatchObject({ ms: 1001, counter: 0 });
    expect(compareHlc(next, full)).toBe(1);
  });

  it('moves past versions observed from other devices', () => {
    const remote = formatHlc({ ms: 9_000, counter: 4, node: 'ffffffff' });
    const local = tickHlc(null, 1_000, NODE);
    const merged = observeHlc(local, remote, 1_000, NODE);
    expect(compareHlc(merged, remote)).toBe(1);
    expect(parseHlc(merged).node).toBe(NODE);
  });

  it('orders by text exactly as by time', () => {
    const versions = [
      tickHlc(null, 999, NODE),
      tickHlc(null, 1000, NODE),
      tickHlc(null, 10_000, NODE),
    ];
    expect([...versions].reverse().sort()).toEqual(versions);
  });

  it('rejects malformed input and makes valid node IDs', () => {
    expect(() => parseHlc('2026-10-21')).toThrow(RangeError);
    expect(() => formatHlc({ ms: 1, counter: 1, node: 'XYZ' })).toThrow(RangeError);
    expect(newHlcNode()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('ignores a remote version too far ahead of this device clock', () => {
    const now = 1_800_000_000_000;
    const local = formatHlc({ ms: now, counter: 0, node: NODE });
    const year2099 = formatHlc({ ms: 4_070_908_800_000, counter: 0, node: 'ffffffff' });
    expect(isTooFarAhead(year2099, now)).toBe(true);
    expect(parseHlc(observeHlc(local, year2099, now, NODE)).ms).toBe(now);
    const withinDrift = formatHlc({ ms: now + MAX_FUTURE_DRIFT_MS, counter: 0, node: 'ffffffff' });
    expect(isTooFarAhead(withinDrift, now)).toBe(false);
    expect(parseHlc(observeHlc(local, withinDrift, now, NODE)).ms).toBe(now + MAX_FUTURE_DRIFT_MS);
  });
});
