import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';

/**
 * The real migrations on Postgres (PGlite/WASM) behind a Supabase auth shim, so schema,
 * functions and row-level security are tested without Docker.
 */
const root = resolve(__dirname, '..');

export const bytes = (seed: number, length = 32) => new Uint8Array(length).fill(seed);
export const sha256 = (data: Uint8Array) =>
  new Uint8Array(createHash('sha256').update(data).digest());
export const version = (ms: number) => `${String(ms).padStart(13, '0')}-000000-0000abcd`;

export async function openServer() {
  const db = new PGlite();
  await db.exec(readFileSync(resolve(root, 'tests/supabase-shim.sql'), 'utf-8'));
  for (const file of readdirSync(resolve(root, 'migrations')).sort()) {
    await db.exec(readFileSync(resolve(root, 'migrations', file), 'utf-8'));
  }

  const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
    db.query<R>(sql, params).then((r) => r.rows);

  /** Runs `fn` as the given Supabase user, like a request carrying that user's JWT. */
  async function as<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${userId}';`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role; reset request.jwt.claim.sub;`);
    }
  }

  /** Registers `userId` as a device whose keys are filled with `seed`; returns its id. */
  async function register(userId: string, seed: number, secret = bytes(seed + 200)) {
    const [row] = await as(userId, () =>
      q<{ id: string }>(`select register_device($1, $2, 'android', $3) as id`, [
        bytes(seed),
        bytes(seed + 100),
        sha256(secret),
      ]),
    );
    return row.id;
  }

  return { db, q, as, register };
}
