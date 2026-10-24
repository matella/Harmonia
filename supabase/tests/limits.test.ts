import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, version } from './pglite-server';

/** Hardening (§19): rate limits and size caps a member's own app can't get around. */
const users = {
  alex: '00000000-0000-4000-8000-00000000eee1',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const write = (id: string, ciphertext: Uint8Array, nonce = bytes(1, 24)) =>
  run(
    users.alex,
    `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
     values ($1, 'milestone', $2, $3, 1, $4, $5)
     on conflict (space_id, record_type, record_id) do update
       set version = excluded.version, ciphertext = excluded.ciphertext`,
    [space, id, version(Date.now()), nonce, ciphertext],
  );
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('limits (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    await server.register(users.alex, 1);
    [{ space_id: space }] = await run<{ space_id: string }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), uuid(1)],
    );
  });

  it('refuses invites past 30 an hour per device, and keeps refusing until the hour turns', async () => {
    for (let i = 0; i < 30; i++) await run(users.alex, `select create_invite($1)`, [bytes(7, 72)]);
    await expect(run(users.alex, `select create_invite($1)`, [bytes(7, 72)])).rejects.toThrow(
      /rate limited/,
    );
    await expect(run(users.alex, `select create_invite($1)`, [bytes(7, 72)])).rejects.toThrow(
      /rate limited/,
    );
    // The hour turns.
    await server.q(`update rate_counters set window_start = window_start - interval '2 hours'`);
    await run(users.alex, `select create_invite($1)`, [bytes(7, 72)]);
  });

  it('refuses an invite bundle over 16 KiB', async () => {
    await expect(run(users.alex, `select create_invite($1)`, [bytes(7, 16385)])).rejects.toThrow(
      /too large/,
    );
  });

  it('keeps the counters and the unlimited originals out of members’ reach', async () => {
    await expect(run(users.alex, `select * from rate_counters`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(run(users.alex, `select take_rate('x', 1, 60)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      run(users.alex, `select create_invite_unlimited($1)`, [bytes(7, 72)]),
    ).rejects.toThrow(/permission denied/);
  });

  it('caps a record’s size and nonce, and a space’s total', async () => {
    await expect(write(uuid(100), bytes(2, 65537))).rejects.toThrow(/record too large/);
    await expect(write(uuid(101), bytes(2, 10), bytes(1, 12))).rejects.toThrow(/record too large/);
    await write(uuid(102), bytes(2, 65536));
    const total = async () =>
      Number(
        (
          await server.q<{ n: string }>(`select record_bytes as n from spaces where id = $1`, [
            space,
          ])
        )[0].n,
      );
    expect(await total()).toBe(65536);
    await server.q(`update storage_settings set record_bytes_per_space = $1`, [100000]);
    try {
      await expect(write(uuid(103), bytes(2, 40000))).rejects.toThrow(/space full/);
      // Shrinking a record is always allowed, and frees room.
      await write(uuid(102), bytes(3, 1000));
      expect(await total()).toBe(1000);
      await write(uuid(103), bytes(2, 40000));
      expect(await total()).toBe(41000);
    } finally {
      await server.q(`update storage_settings set record_bytes_per_space = 209715200`);
    }
    // A purge deletes the record, and its bytes.
    await run(
      users.alex,
      `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
       values ($1, 'purge', $2, $3, 1, $4, $5)`,
      [space, uuid(103), version(Date.now() + 1), bytes(1, 24), bytes(4, 50)],
    );
    expect(await total()).toBe(1050);
  });

  it('lets members only read person rows, and gives the signed-out role nothing', async () => {
    const people = await run<{ id: string }>(users.alex, `select id from persons`);
    expect(people.map((p) => p.id)).toEqual([uuid(1)]);
    expect(await run(users.alex, `delete from persons returning id`)).toEqual([]);
    expect(await run(users.alex, `update persons set space_id = space_id returning id`)).toEqual(
      [],
    );
    await expect(
      run(users.alex, `insert into persons (id, space_id) values ($1, $2)`, [uuid(2), space]),
    ).rejects.toThrow(/row-level security/);
    // An internal helper that trusts its arguments: never callable from outside.
    await expect(
      run(users.alex, `select store_recovery_envelopes($1, $2, '[]'::jsonb, 1, 99, null)`, [
        space,
        uuid(9),
      ]),
    ).rejects.toThrow(/permission denied/);
    await server.db.exec('set role anon');
    try {
      await expect(server.q(`select * from records`)).rejects.toThrow(/permission denied/);
      for (const fn of ['membership()', 'current_device_id()', 'dissolve_space()']) {
        await expect(server.q(`select ${fn}`), fn).rejects.toThrow(/permission denied/);
      }
    } finally {
      await server.db.exec('reset role');
    }
  });

  it('lets a full space free itself: trash, purge, then new records fit again', async () => {
    const at = (type: string, id: string, ms: number, deleted: boolean, ciphertext: Uint8Array) =>
      run(
        users.alex,
        `insert into records (space_id, record_type, record_id, version, epoch, deleted, nonce, ciphertext)
         values ($1, $2, $3, $4, 1, $5, $6, $7)
         on conflict (space_id, record_type, record_id) do update
           set version = excluded.version, deleted = excluded.deleted, ciphertext = excluded.ciphertext`,
        [space, type, id, version(ms), deleted, bytes(1, 24), ciphertext],
      );
    const used = Number(
      (
        await server.q<{ n: string }>(`select record_bytes as n from spaces where id = $1`, [space])
      )[0].n,
    );
    await server.q(`update storage_settings set record_bytes_per_space = $1`, [used + 5000]);
    try {
      await at('memory', uuid(200), Date.now(), false, bytes(5, 5000)); // now exactly full
      await expect(at('memory', uuid(201), Date.now(), false, bytes(5, 10))).rejects.toThrow(
        /space full/,
      );
      // To the trash: the tombstone grows a little, and still goes through.
      await at('memory', uuid(200), Date.now() + 10, true, bytes(5, 5100));
      // Deleted for good: the purge goes through and takes the memory's bytes with it.
      await at('purge', uuid(200), Date.now() + 20, false, bytes(6, 60));
      await at('memory', uuid(201), Date.now() + 30, false, bytes(5, 3000));
      // An existing record rewritten at the same size, in a full space: an upsert, still fine.
      await server.q(`update storage_settings set record_bytes_per_space = 1`);
      await at('memory', uuid(201), Date.now() + 40, false, bytes(7, 3000));
    } finally {
      await server.q(`update storage_settings set record_bytes_per_space = 209715200`);
    }
  });
});
