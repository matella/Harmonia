import { describe, expect, it } from 'vitest';

import { formatRecoveryKey, loadSodium, parseRecoveryKey } from './sync-crypto';
import { runSyncSelfTest } from './sync-self-test';

/**
 * The self-test encrypts and decrypts a 1.5 MB photo and runs every tamper check. It takes
 * about 2.5 s on the Windows dev machine but 4.8–6.8 s on the Intel Mac, which exceeded
 * Vitest's 5 s default there.
 */
const SELF_TEST_TIMEOUT_MS = 30_000;

describe('sync crypto (phase 0 spike)', () => {
  it(
    'passes every round-trip and tamper check',
    async () => {
      const report = await runSyncSelfTest();
      const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
      expect(failed).toEqual([]);
      expect(report.ok).toBe(true);
    },
    SELF_TEST_TIMEOUT_MS,
  );

  it('formats recovery keys deterministically and rejects malformed input', async () => {
    const s = await loadSodium();
    const raw = new Uint8Array(23).map((_, i) => i * 11);
    const display = formatRecoveryKey(s, raw);
    expect(display).toMatch(/^([0-9A-Z]{5}-){7}[0-9A-Z]{5}$/);
    expect(display).toBe(formatRecoveryKey(s, raw));
    expect(parseRecoveryKey(s, display)).toEqual(raw);
    expect(parseRecoveryKey(s, display.replace(/-/g, ' '))).toEqual(raw);
    expect(parseRecoveryKey(s, display.slice(0, -1))).toBeNull();
    expect(parseRecoveryKey(s, display.replace(/^./, 'U'))).toBeNull();
  });
});
