import { describe, expect, it } from 'vitest';

import { formatRecoveryKey, loadSodium, parseRecoveryKey } from './sync-crypto';
import { runSyncSelfTest } from './sync-self-test';

describe('sync crypto (phase 0 spike)', () => {
  it('passes every round-trip and tamper check', async () => {
    const report = await runSyncSelfTest();
    const failed = Object.entries(report.checks).filter(([, ok]) => !ok).map(([name]) => name);
    expect(failed).toEqual([]);
    expect(report.ok).toBe(true);
  });

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
