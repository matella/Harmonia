import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer } from './pglite-server';

/** Photo reservations and the Storage policies (§18); the service itself is tested live. */
const users = {
  alex: '00000000-0000-4000-8000-0000000009a1',
  stranger: '00000000-0000-4000-8000-0000000009c1',
} as const;
const MiB = 1024 * 1024;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
/** A part as Storage inserts it; `size` defaults to what part 0..2 of a 2 MiB + 1 photo is. */
const put = (user: string, name: string, size = sizeOf(name)) =>
  run(user, `insert into storage.objects (bucket_id, name, metadata) values ('photos', $1, $2)`, [
    name,
    JSON.stringify({ size }),
  ]);
const sizeOf = (name: string) => (name.endsWith('/2') ? 1 + 17 : 16 * (65536 + 17));

describe('photo storage rules (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    await server.register(users.alex, 1);
    await server.register(users.stranger, 2);
    [{ space_id: space }] = await run<{ space_id: string }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), '00000000-0000-4000-8000-0000000009b1'],
    );
  });

  it('reserves parts by size and lets Storage accept only those', async () => {
    const blob = '11111111-1111-4111-8111-111111111111';
    await run(users.alex, `select reserve_blob($1, $2)`, [blob, 2 * MiB + 1]);
    expect(await server.q(`select parts from blobs where id = $1`, [blob])).toEqual([{ parts: 3 }]);
    // Not one byte more or less than the encrypted part. (Storage's own permission check
    // inserts a row without a size and rolls it back; the stored row always has one.)
    await expect(put(users.alex, `${space}/${blob}/2`, 19)).rejects.toThrow(/part size/);
    await expect(put(users.alex, `${space}/${blob}/0`, 1000)).rejects.toThrow(/part size/);
    for (const part of [0, 1, 2]) await put(users.alex, `${space}/${blob}/${part}`);
    for (const name of [
      `${space}/${blob}/3`,
      `${space}/${blob}/00`,
      `${space}/${blob}`,
      `${space}/22222222-2222-4222-8222-222222222222/0`,
      `00000000-0000-4000-8000-000000000000/${blob}/0`,
    ]) {
      // Refused by the size check (it runs first) or by the policy.
      await expect(put(users.alex, name), name).rejects.toThrow(/row-level security|part size/);
    }
    await expect(put(users.stranger, `${space}/${blob}/1`)).rejects.toThrow(/row-level security/);
    expect(await run(users.stranger, `select name from storage.objects`)).toEqual([]);
    expect(await run(users.alex, `select count(*)::int as n from storage.objects`)).toEqual([
      { n: 3 },
    ]);
  });

  it('keeps the space under its limit, and the settings out of members’ reach', async () => {
    await expect(run(users.alex, `select * from storage_settings`)).rejects.toThrow(
      /permission denied/,
    );
    await server.q(`update storage_settings set photo_bytes_per_space = $1`, [3 * MiB]);
    await run(users.alex, `select reserve_blob($1, $2)`, [
      '33333333-3333-4333-8333-333333333333',
      MiB - 1,
    ]);
    await expect(
      run(users.alex, `select reserve_blob($1, 1)`, ['44444444-4444-4444-8444-444444444444']),
    ).rejects.toThrow(/storage full/);
    expect(await run(users.alex, `select * from space_storage()`)).toEqual([
      { used: 3 * MiB, limit_bytes: 3 * MiB },
    ]);
    await expect(
      run(users.alex, `select reserve_blob($1, $2)`, [
        '55555555-5555-4555-8555-555555555555',
        21 * MiB,
      ]),
    ).rejects.toThrow(/not allowed/);
  });
});
