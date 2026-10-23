import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, version } from './pglite-server';

/** Removing a device: rotate(), repair and old-epoch writes (§7.4). */
const users = {
  phone: '00000000-0000-4000-8000-0000000005a1',
  tablet: '00000000-0000-4000-8000-0000000005a2',
  sam: '00000000-0000-4000-8000-0000000005b1',
  eve: '00000000-0000-4000-8000-0000000005c1',
} as const;
const people = {
  alex: '00000000-0000-4000-8000-0000000006a1',
  sam: '00000000-0000-4000-8000-0000000006b1',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const device: Record<string, string> = {};
const b64 = (seed: number, length: number) => Buffer.from(bytes(seed, length)).toString('base64');
const envelope = (deviceId: string, seed: number) => ({
  device_id: deviceId,
  sealed: b64(seed, 80),
  signature: b64(seed, 64),
});
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const epoch = async () =>
  (await server.q<{ epoch: number }>(`select epoch from spaces where id = $1`, [space]))[0].epoch;

async function admit(user: string, person: string, asPerson: string | null, by: string) {
  const [{ id }] = await run<{ id: string }>(by, `select create_invite($1) as id`, [bytes(7, 72)]);
  await run(user, `select * from claim_invite($1, $2)`, [id, person]);
  await run(by, `select approve_invite($1, $2)`, [id, asPerson]);
}

describe('rotation (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    for (const [i, user] of Object.entries(users).entries()) {
      device[user[0]] = await server.register(user[1], i + 1);
    }
    [{ space_id: space }] = await run<{ space_id: string }>(
      users.phone,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), people.alex],
    );
    await admit(users.tablet, '00000000-0000-4000-8000-0000000006a2', people.alex, users.phone);
    await admit(users.sam, people.sam, null, users.phone);
  });

  it('lets only my own devices be approved as me', async () => {
    const [{ id }] = await run<{ id: string }>(users.sam, `select create_invite($1) as id`, [
      bytes(7, 72),
    ]);
    await run(users.eve, `select * from claim_invite($1, $2)`, [
      id,
      '00000000-0000-4000-8000-0000000006c1',
    ]);
    await expect(
      run(users.sam, `select approve_invite($1, $2)`, [id, people.alex]),
    ).rejects.toThrow(/not allowed/);
    await run(users.sam, `select decline_invite($1)`, [id]);
  });

  it('changes nothing when one envelope is refused', async () => {
    await expect(
      run(users.phone, `select rotate($1, 1, $2::jsonb)`, [
        device['tablet'],
        JSON.stringify([envelope(device['phone'], 1), envelope(device['eve'], 2)]), // Eve is not in the space
      ]),
    ).rejects.toThrow(/unknown recipient/);
    expect(await epoch()).toBe(1);
    expect(
      (await run<{ revoked: boolean }>(users.tablet, `select revoked from membership()`))[0]
        .revoked,
    ).toBe(false);
  });

  it('removes a device, starts the next epoch and stores the new envelopes in one step', async () => {
    const [{ rotate: next }] = await run<{ rotate: number }>(
      users.phone,
      `select rotate($1, 1, $2::jsonb)`,
      [
        device['tablet'],
        JSON.stringify([envelope(device['phone'], 3)]), // Sam's is left out on purpose (repair below)
      ],
    );
    expect(next).toBe(2);
    expect(
      (await run<{ revoked: boolean }>(users.tablet, `select revoked from membership()`))[0]
        .revoked,
    ).toBe(true);
    const stored = await server.q<{ device_id: string; signer_device_id: string }>(
      `select device_id, signer_device_id from key_envelopes where space_id = $1 and epoch = 2`,
      [space],
    );
    expect(stored).toEqual([{ device_id: device['phone'], signer_device_id: device['phone'] }]);

    // Removing it again: the server says the target is no longer in the space.
    await expect(
      run(users.phone, `select rotate($1, 2, '[]'::jsonb)`, [device['tablet']]),
    ).rejects.toThrow(/target not in space/);

    // Someone who saw epoch 1 can't rotate again on top of it.
    await expect(
      run(users.sam, `select rotate($1, 1, '[]'::jsonb)`, [device['phone']]),
    ).rejects.toThrow(/epoch changed/);
  });

  it('skips writes under an old epoch', async () => {
    const write = (epochNo: number, id: string) =>
      run(
        users.sam,
        `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext) values ($1, 'milestone', $2, $3, $4, $5, $6)`,
        [space, id, version(Date.now()), epochNo, bytes(1, 24), bytes(2, 64)],
      );
    await write(1, '99999999-9999-4999-8999-999999999991');
    await write(2, '99999999-9999-4999-8999-999999999992');
    const ids = await server.q<{ record_id: string }>(
      `select record_id from records where space_id = $1`,
      [space],
    );
    expect(ids.map((r) => r.record_id)).toEqual(['99999999-9999-4999-8999-999999999992']);
  });

  it('lets any member fill in a missing envelope, never replace one', async () => {
    const missing = async () =>
      (
        await run<{ device_id: string }>(users.phone, `select * from devices_missing_envelope()`)
      ).map((r) => r.device_id);
    expect(await missing()).toEqual([device['sam']]);
    await run(users.phone, `select seal_missing(2, $1::jsonb)`, [
      JSON.stringify([envelope(device['sam'], 4)]),
    ]);
    expect(await missing()).toEqual([]);
    await run(users.phone, `select seal_missing(2, $1::jsonb)`, [
      JSON.stringify([envelope(device['sam'], 5)]),
    ]);
    const [{ sealed }] = await server.q<{ sealed: Uint8Array }>(
      `select sealed from key_envelopes where device_id = $1 and epoch = 2`,
      [device['sam']],
    );
    expect(sealed[0]).toBe(4);
    await expect(
      run(users.phone, `select seal_missing(1, $1::jsonb)`, [
        JSON.stringify([envelope(device['sam'], 6)]),
      ]),
    ).rejects.toThrow(/epoch changed/);
    await expect(run(users.eve, `select * from devices_missing_envelope()`)).rejects.toThrow(
      /not a member/,
    );
  });

  it('turns a removed device away from every key function', async () => {
    for (const [sql, params] of [
      [`select rotate($1, 2, '[]'::jsonb)`, [device['sam']]],
      [`select * from devices_missing_envelope()`, []],
      [`select seal_missing(2, '[]'::jsonb)`, []],
      [`select store_own_envelopes('[]'::jsonb)`, []],
    ] as const) {
      await expect(run(users.tablet, sql, [...params])).rejects.toThrow(/not a member/);
    }
  });
});
