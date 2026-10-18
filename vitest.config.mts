import { defineConfig } from 'vitest/config';

/**
 * Framework-free test suite: domain rules, persistence (real SQLite via sql.js),
 * reminder planning/reconciliation, widget snapshots and export mapping.
 * These run in plain Node without booting Angular or Ionic.
 * Angular component specs (*.spec.ts) run separately through `ng test`.
 */
export default defineConfig({
  test: {
    include: ['src/app/core/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
});
