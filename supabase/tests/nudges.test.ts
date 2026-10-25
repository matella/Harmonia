import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, version } from './pglite-server';

/** "Thinking of you" on the server (§22): own key only, overwritten, rate limited. */
const users = {
  alex: '00000000-0000-4000-8000-0000000009a1',
  sam: '00000000-0000-4000-8000-0000000009b1',
} as const;
const people = {
  alex: '00000000-0000-4000-8000-0000000010a1',
  sam: '00000000-0000-4000-8000-0000000010b1',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const send = (user: string, personId: string, ms: number) =>
  run(
    user,
    `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
     values ($1, 'nudge', $2, $3, 1, $4, $5)
     on conflict (space_id, record_type, record_id) do update
       set version = excluded.version, ciphertext = excluded.ciphertext, nonce = excluded.nonce`,
    [space, personId, version(ms), bytes(1, 24), bytes(2, 48)],
  );
const nudges = () =>
  server.q<{ record_id: string; version: string }>(
    `select record_id, version from records where space_id = $1 and record_type = 'nudge' order by record_id`,
    [space],
  );

describe('nudges (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    for (const [i, user] of Object.values(users).entries()) await server.register(user, i + 1);
    [{ space_id: space }] = await run<{ space_id: string }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), people.alex],
    );
    const [{ id }] = await run<{ id: string }>(users.alex, `select create_invite($1) as id`, [
      bytes(7, 72),
    ]);
    await run(users.sam, `select * from claim_invite($1, $2)`, [id, people.sam]);
    await run(users.alex, `select approve_invite($1)`, [id]);
    await run(users.sam, `select finish_join($1, $2, $3)`, [id, bytes(8, 80), bytes(8, 64)]);
  });

  it('stores one record per sender and overwrites it with the newest', async () => {
    await send(users.alex, people.alex, 1000);
    await send(users.alex, people.alex, 3000);
    await send(users.alex, people.alex, 2000); // an older one never replaces a newer one
    expect(await nudges()).toEqual([{ record_id: people.alex, version: version(3000) }]);
  });

  it('refuses to send in a partner’s name, without an error', async () => {
    await send(users.sam, people.alex, 9000);
    await send(users.alex, people.sam, 9000);
    expect((await nudges()).map((n) => n.record_id)).toEqual([people.alex]);
    expect((await nudges())[0].version).toBe(version(3000));
    await send(users.sam, people.sam, 4000);
    expect((await nudges()).map((n) => n.record_id).sort()).toEqual(
      [people.alex, people.sam].sort(),
    );
  });

  it('limits sends to 30 an hour per device', async () => {
    // Two are counted already for Alex (first send, the newer overwrite).
    let failed: unknown = null;
    for (let i = 0; i < 40 && !failed; i++) {
      await send(users.alex, people.alex, 10_000 + i).catch((error) => (failed = error));
    }
    expect(String(failed)).toMatch(/rate limited/);
    // Sam, with his own count, is not affected.
    await send(users.sam, people.sam, 20_000);
  });
});
