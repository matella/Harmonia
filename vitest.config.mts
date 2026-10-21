import { defineConfig } from 'vitest/config';

/**
 * Framework-free test suite: domain rules, persistence (real SQLite via sql.js),
 * reminder planning/reconciliation, widget snapshots and export mapping, plus the
 * sharing server schema and its row-level security (supabase/, on PGlite).
 * These run in plain Node without booting Angular or Ionic.
 * Angular component specs (*.spec.ts) run separately through `ng test`.
 */
export default defineConfig({
  test: {
    include: ['src/app/core/**/*.test.ts', 'supabase/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
});
