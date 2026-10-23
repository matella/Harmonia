import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer } from './pglite-server';

/** Versions far ahead of the server clock are skipped, never stored or raised (§17). */
const user = '00000000-0000-4000-8000-0000000000e1';
const DAY = 86_400_000;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;

const at = (ms: number) => `${String(ms).padStart(13, '0')}-000000-0000abcd`;
const upsert = (rows: { id: string; version: string }[]) =>
  server.as(user, () =>
    server.q(
      `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
       select $1, 'milestone', r.id::uuid, r.version, 1, '\\x00', '\\x00'
       from jsonb_to_recordset($2::jsonb) as r(id text, version text)
       on conflict (space_id, record_type, record_id) do update set version = excluded.version`,
      [space, JSON.stringify(rows)],
    ),
  );
const stored = () =>
  server.as(user, () =>
    server.q<{ record_id: string; version: string }>(
      `select record_id, version from records order by record_id`,
    ),
  );

describe('record versions and the server clock', () => {
  beforeAll(async () => {
    server = await openServer();
    await server.register(user, 1);
    [{ space_id: space }] = await server.as(user, () =>
      server.q<{ space_id: string }>(`select * from create_space($1, gen_random_uuid())`, [
        bytes(9, 80),
      ]),
    );
  });

  it('skips a far-future write without failing the rest of the batch', async () => {
    const now = Date.now();
    const a = '77777777-7777-4777-8777-777777777777';
    const b = '88888888-8888-4888-8888-888888888888';
    await upsert([
      { id: a, version: at(now + 2 * DAY) },
      { id: b, version: at(now + 60_000) }, // a minute of skew is fine
    ]);
    expect(await stored()).toEqual([{ record_id: b, version: at(now + 60_000) }]);

    await upsert([{ id: b, version: at(now + 3 * DAY) }]);
    expect((await stored())[0].version).toBe(at(now + 60_000));
    await upsert([{ id: b, version: at(now + 120_000) }]);
    expect((await stored())[0].version).toBe(at(now + 120_000));
  });
});
