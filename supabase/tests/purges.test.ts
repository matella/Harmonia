import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, version } from './pglite-server';

/** Deleting for good on the server (§18, slice 3): purge records, releases, cleanup. */
const users = {
  alex: '00000000-0000-4000-8000-00000000aaa1',
} as const;
const person = '00000000-0000-4000-8000-00000000bbb1';
const date = '00000000-0000-4000-8000-00000000ccc1';
const blob = '00000000-0000-4000-8000-00000000ddd1';

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const write = (type: string, id: string, ms: number) =>
  run(
    users.alex,
    `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
     values ($1, $2, $3, $4, 1, $5, $6)
     on conflict (space_id, record_type, record_id) do update
       set version = excluded.version, ciphertext = excluded.ciphertext`,
    [space, type, id, version(ms), bytes(1, 24), bytes(2, 64)],
  );
const stored = () =>
  server.q<{ record_type: string; record_id: string }>(
    `select record_type, record_id from records where space_id = $1 order by record_type, record_id`,
    [space],
  );

describe('deleting for good (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    await server.register(users.alex, 1);
    [{ space_id: space }] = await run<{ space_id: string }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), person],
    );
  });

  it('removes a date for good, and keeps it removed', async () => {
    await write('milestone', date, 1000);
    await write('purge', date, 2000);
    expect(await stored()).toEqual([{ record_type: 'purge', record_id: date }]);
    // A device that still had it, writing a newer version: skipped.
    await write('milestone', date, 3000);
    expect(await stored()).toEqual([{ record_type: 'purge', record_id: date }]);
  });

  it('never touches other kinds of record through a purge with their ID', async () => {
    await write('person', person, 1000);
    await write('recovery', person, 1000);
    await write('purge', person, 2000);
    expect((await stored()).filter((r) => r.record_id === person)).toEqual([
      { record_type: 'person', record_id: person },
      { record_type: 'purge', record_id: person },
      { record_type: 'recovery', record_id: person },
    ]);
    // And they can still be written.
    await write('person', person, 3000);
    expect(
      await server.q(
        `select version from records where record_type = 'person' and record_id = $1`,
        [person],
      ),
    ).toEqual([{ version: version(3000) }]);
  });

  it('frees a photo’s reservation only once its parts are gone', async () => {
    await run(users.alex, `select reserve_blob($1, 100)`, [blob]);
    await run(
      users.alex,
      `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, $2)`,
      [`${space}/${blob}/0`, JSON.stringify({ size: 117 })],
    );
    await expect(run(users.alex, `select release_blob($1)`, [blob])).rejects.toThrow(
      /parts remain/,
    );
    await run(users.alex, `delete from storage.objects where name = $1`, [`${space}/${blob}/0`]);
    await run(users.alex, `select release_blob($1)`, [blob]);
    expect(await server.q(`select count(*)::int as n from blobs`)).toEqual([{ n: 0 }]);
  });

  it('leaves the cleanup functions to the operator', async () => {
    await expect(run(users.alex, `select * from orphan_photo_parts()`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(run(users.alex, `select release_stale_reservations()`)).rejects.toThrow(
      /permission denied/,
    );
    // A part whose reservation is gone, and a reservation that never got a part, both old.
    const lost = '00000000-0000-4000-8000-00000000ddd2';
    const never = '00000000-0000-4000-8000-00000000ddd3';
    await run(users.alex, `select reserve_blob($1, 100)`, [lost]);
    await run(users.alex, `select reserve_blob($1, 100)`, [never]);
    await run(
      users.alex,
      `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, $2)`,
      [`${space}/${lost}/0`, JSON.stringify({ size: 117 })],
    );
    await server.q(`delete from blobs where id = $1`, [lost]);
    await server.q(`update storage.objects set created_at = now() - interval '2 hours'`);
    await server.q(`update blobs set created_at = now() - interval '2 days'`);
    const asOperator = async <R>(sql: string) => {
      await server.db.exec('set role service_role');
      try {
        return await server.q<R>(sql);
      } finally {
        await server.db.exec('reset role');
      }
    };
    expect(await asOperator(`select * from orphan_photo_parts()`)).toEqual([
      { name: `${space}/${lost}/0` },
    ]);
    expect(await asOperator(`select release_stale_reservations() as n`)).toEqual([{ n: 1 }]);
    expect(await server.q(`select id from blobs`)).toEqual([]);
  });
});
