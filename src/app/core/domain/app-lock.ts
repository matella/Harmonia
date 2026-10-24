/** How long Harmonia may stay in the background before it locks (minutes; 0 = right away). */
export const APP_LOCK_DELAYS = [0, 1, 5, 15] as const;
export type AppLockDelay = (typeof APP_LOCK_DELAYS)[number];

/**
 * Whether the app should be locked when it comes back to the foreground (docs/APP_LOCK.md).
 * A clock that went backwards locks too: that is the safe answer.
 */
export function shouldLockOnResume(
  enabled: boolean,
  delayMinutes: AppLockDelay,
  backgroundSinceMs: number | null,
  nowMs: number,
): boolean {
  if (!enabled) return false;
  if (backgroundSinceMs === null) return false;
  const away = nowMs - backgroundSinceMs;
  return away < 0 || away >= delayMinutes * 60_000;
}
