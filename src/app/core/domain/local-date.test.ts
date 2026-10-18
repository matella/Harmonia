import { describe, expect, it } from 'vitest';

import {
  isValidIsoDate,
  isValidLocalTime,
  isValidTimeZoneId,
  resolveLocalDateTime,
  toPlainDate,
  toPlainTime,
} from './local-date';

describe('ISO date validation', () => {
  it('accepts real calendar dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-12-31')).toBe(true);
  });

  it('rejects impossible or malformed dates', () => {
    for (const bad of ['2023-02-29', '2024-13-01', '2024-04-31', '2024-1-01', '24-01-01', '', '2024-06-14T00:00', 'x']) {
      expect(isValidIsoDate(bad), bad).toBe(false);
    }
    expect(isValidIsoDate(undefined)).toBe(false);
    expect(isValidIsoDate('1850-01-01')).toBe(false);
  });

  it('round-trips date-only values without shifting a day, in any zone', () => {
    for (const iso of ['2024-01-01', '2024-02-29', '2024-03-31', '2024-10-27', '2024-12-31']) {
      const json = JSON.stringify({ date: toPlainDate(iso).toString() });
      expect(toPlainDate((JSON.parse(json) as { date: string }).date).toString()).toBe(iso);
    }
  });
});

describe('time validation', () => {
  it('accepts HH:mm 24h times only', () => {
    expect(isValidLocalTime('00:00')).toBe(true);
    expect(isValidLocalTime('23:59')).toBe(true);
    expect(isValidLocalTime('24:00')).toBe(false);
    expect(isValidLocalTime('9:00')).toBe(false);
    expect(isValidLocalTime('09:60')).toBe(false);
  });

  it('validates IANA zone identifiers', () => {
    expect(isValidTimeZoneId('Europe/Brussels')).toBe(true);
    expect(isValidTimeZoneId('UTC')).toBe(true);
    expect(isValidTimeZoneId('Mars/Olympus')).toBe(false);
    expect(isValidTimeZoneId('')).toBe(false);
  });
});

describe('DST policy (resolveLocalDateTime)', () => {
  it('moves a time inside a spring-forward gap forward by the gap length', () => {
    const zdt = resolveLocalDateTime(toPlainDate('2026-03-29'), toPlainTime('02:30'), 'Europe/Brussels');
    expect(zdt.toPlainTime().toString()).toBe('03:30:00');
    expect(zdt.toInstant().toString()).toBe('2026-03-29T01:30:00Z');
  });

  it('chooses the first occurrence of an ambiguous fall-back time', () => {
    const zdt = resolveLocalDateTime(toPlainDate('2026-10-25'), toPlainTime('02:30'), 'Europe/Brussels');
    expect(zdt.offset).toBe('+02:00');
    expect(zdt.toInstant().toString()).toBe('2026-10-25T00:30:00Z');
  });
});
