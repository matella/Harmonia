import { describe, expect, it } from 'vitest';

import { shouldLockOnResume } from './app-lock';

describe('shouldLockOnResume', () => {
  const left = 1_000_000;
  it('never locks when the lock is off, or when the app never went to the background', () => {
    expect(shouldLockOnResume(false, 0, left, left + 60 * 60_000)).toBe(false);
    expect(shouldLockOnResume(true, 0, null, left)).toBe(false);
  });

  it('locks once the chosen time has passed, and right away for 0', () => {
    expect(shouldLockOnResume(true, 0, left, left)).toBe(true);
    expect(shouldLockOnResume(true, 1, left, left + 59_999)).toBe(false);
    expect(shouldLockOnResume(true, 1, left, left + 60_000)).toBe(true);
    expect(shouldLockOnResume(true, 15, left, left + 14 * 60_000)).toBe(false);
  });

  it('locks when the clock went backwards', () => {
    expect(shouldLockOnResume(true, 15, left, left - 1)).toBe(true);
  });
});
