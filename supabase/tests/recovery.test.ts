import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, sha256, version } from './pglite-server';

/** The recovery key on the server (§8): hashed lookups, envelopes, recover(), replace. */
const users = {
  alex: '00000000-0000-4000-8000-0000000007a1',
  sam: '00000000-0000-4000-8000-0000000007b1',
  newAlex: '00000000-0000-4000-8000-0000000007a2',
  thief: '00000000-0000-4000-8000-0000000007c1',
  laterAlex: '00000000-0000-4000-8000-0000000007a3',
} as const;
const people = {
  alex: '00000000-0000-4000-8000-0000000008a1',
  sam: '00000000-0000-4000-8000-0000000008b1',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;
const device: Record<string, string> = {};
const lookup = bytes(31, 16);
const newLookup = bytes(32, 16);
const alexKey = bytes(41, 32);
const alexNewKey = bytes(42, 32);
const samKey = bytes(43, 32);
const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
const recoveryEnvelope = (person: string, epoch: number, seed: number, publicKey: Uint8Array) => ({
  person_id: person,
  epoch,
  sealed: b64(bytes(seed, 80)),
  signature: b64(bytes(seed, 64)),
  public_key_hash: b64(sha256(publicKey)),
});
const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const epochOf = async () =>
  (await server.q<{ epoch: number }>(`select epoch from spaces where id = $1`, [space]))[0].epoch;
const recoveryEnvelopes = (person: string) =>
  server.q<{ epoch: number }>(
    `select epoch from key_envelopes where recovery_person_id = $1 order by epoch`,
    [person],
  );

describe('recovery (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    for (const [i, [name, user]] of Object.entries(users).entries()) {
      device[name] = await server.register(user, i + 1);
    }
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

  it('is set up by a rotation, stored hashed, out of every member’s reach', async () => {
    const [{ rotate: next }] = await run<{ rotate: number }>(
      users.alex,
      `select rotate(null, 1, $1::jsonb, $2::jsonb, $3, $4)`,
      [
        JSON.stringify(
          [device['alex'], device['sam']].map((id) => ({
            device_id: id,
            sealed: b64(bytes(11, 80)),
            signature: b64(bytes(11, 64)),
          })),
        ),
        JSON.stringify([1, 2].map((e) => recoveryEnvelope(people.alex, e, e, alexKey))),
        sha256(lookup),
        sha256(alexKey),
      ],
    );
    expect(next).toBe(2);
    expect(await recoveryEnvelopes(people.alex)).toEqual([{ epoch: 1 }, { epoch: 2 }]);
    for (const user of [users.alex, users.sam]) {
      await expect(run(user, `select * from recovery_lookups`)).rejects.toThrow(
        /permission denied/,
      );
      expect(
        await run(user, `select * from key_envelopes where recovery_person_id is not null`),
      ).toEqual([]);
    }
    // A lookup without the matching public key hash (or the other way round) is refused.
    await expect(
      run(users.sam, `select rotate(null, 2, '[]'::jsonb, '[]'::jsonb, $1, null)`, [
        sha256(bytes(40, 16)),
      ]),
    ).rejects.toThrow(/not allowed/);
  });

  it('only stores envelopes sealed to the person’s current key, for its own person only', async () => {
    // Sam sets up a key; an envelope for Alex's own epochs from Sam is refused.
    await expect(
      run(users.sam, `select rotate(null, 2, '[]'::jsonb, $1::jsonb, $2, $3)`, [
        JSON.stringify([recoveryEnvelope(people.alex, 1, 5, alexKey)]),
        sha256(bytes(44, 16)),
        sha256(samKey),
      ]),
    ).rejects.toThrow(/epoch changed/);
    const [{ rotate: next }] = await run<{ rotate: number }>(
      users.sam,
      `select rotate(null, 2, '[]'::jsonb, $1::jsonb, $2, $3)`,
      [
        JSON.stringify([
          ...[1, 2, 3].map((e) => recoveryEnvelope(people.sam, e, 20 + e, samKey)),
          // For Alex: sealed to a key Alex doesn't have (skipped), then the right one.
          recoveryEnvelope(people.alex, 3, 30, bytes(99, 32)),
        ]),
        sha256(bytes(44, 16)),
        sha256(samKey),
      ],
    );
    expect(next).toBe(3);
    expect(await recoveryEnvelopes(people.sam)).toEqual([{ epoch: 1 }, { epoch: 2 }, { epoch: 3 }]);
    expect(await recoveryEnvelopes(people.alex)).toEqual([{ epoch: 1 }, { epoch: 2 }]);
    const missing = await run<{ person_id: string; public_key_hash: Uint8Array }>(
      users.sam,
      `select * from persons_missing_recovery_envelope()`,
    );
    expect(missing.map((m) => [m.person_id, b64(m.public_key_hash)])).toEqual([
      [people.alex, b64(sha256(alexKey))],
    ]);
    // Repair: a rotation that removes nothing, sealed to the right key.
    await run(users.sam, `select rotate(null, 3, '[]'::jsonb, $1::jsonb)`, [
      JSON.stringify([
        recoveryEnvelope(people.alex, 4, 31, alexKey),
        recoveryEnvelope(people.sam, 4, 32, samKey),
      ]),
    ]);
    expect(await run(users.sam, `select * from persons_missing_recovery_envelope()`)).toEqual([]);
  });

  it('admits a device holding the key as that person, with every epoch’s envelope', async () => {
    await expect(run(users.thief, `select * from recover($1)`, [bytes(99, 16)])).rejects.toThrow(
      /unknown recovery key/,
    );
    const ask = () =>
      run<{
        space_id: string;
        person_id: string;
        epoch: number;
        envelopes: { epoch: number; signer_device_id: string }[];
      }>(users.newAlex, `select * from recover($1)`, [lookup]);
    const [recovered] = await ask();
    expect(recovered).toMatchObject({ space_id: space, person_id: people.alex, epoch: 4 });
    expect(recovered.envelopes.map((e) => [e.epoch, e.signer_device_id])).toEqual([
      [1, device['alex']],
      [2, device['alex']],
      [4, device['sam']],
    ]);
    // Asked again after an interruption: the same answer.
    expect((await ask())[0]).toEqual(recovered);
    expect(
      (await run<{ space_id: string }>(users.newAlex, `select space_id from membership()`))[0]
        .space_id,
    ).toBe(space);
    // Sam's device is already in the space as Sam: not as Alex.
    await expect(run(users.sam, `select * from recover($1)`, [lookup])).rejects.toThrow(
      /already in a space/,
    );
  });

  it('replaces the key in a new epoch: the old key recovers nothing, the new one everything', async () => {
    const before = await epochOf();
    const [{ rotate: next }] = await run<{ rotate: number }>(
      users.alex,
      `select rotate(null, $1, '[]'::jsonb, $2::jsonb, $3, $4)`,
      [
        before,
        JSON.stringify(
          Array.from({ length: before + 1 }, (_, i) =>
            recoveryEnvelope(people.alex, i + 1, 50 + i, alexNewKey),
          ),
        ),
        sha256(newLookup),
        sha256(alexNewKey),
      ],
    );
    expect(next).toBe(before + 1);
    await expect(run(users.thief, `select * from recover($1)`, [lookup])).rejects.toThrow(
      /unknown recovery key/,
    );
    const [recovered] = await run<{ envelopes: { epoch: number }[] }>(
      users.laterAlex,
      `select * from recover($1)`,
      [newLookup],
    );
    expect(recovered.envelopes.map((e) => e.epoch)).toEqual([1, 2, 3, 4, 5]);
    // A rotation from a device that still has the old public key: skipped for Alex.
    await run(users.sam, `select rotate(null, 5, '[]'::jsonb, $1::jsonb)`, [
      JSON.stringify([recoveryEnvelope(people.alex, 6, 60, alexKey)]),
    ]);
    expect(
      (
        await run<{ person_id: string }>(
          users.sam,
          `select * from persons_missing_recovery_envelope()`,
        )
      )
        .map((m) => m.person_id)
        .sort(),
    ).toEqual([people.alex, people.sam].sort());
  });
  it('keeps a recovery record only from a device of that person', async () => {
    const epoch = await epochOf();
    const write = (user: string, person: string, ms: number) =>
      run(
        user,
        `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
         values ($1, 'recovery', $2, $3, $4, $5, $6)
         on conflict (space_id, record_type, record_id) do update
           set version = excluded.version, ciphertext = excluded.ciphertext`,
        [space, person, version(ms), epoch, bytes(1, 24), bytes(2, 64)],
      );
    const stored = () =>
      server.q<{ record_id: string; version: string }>(
        `select record_id, version from records where record_type = 'recovery' order by record_id`,
      );
    await write(users.alex, people.alex, 1_000);
    await write(users.sam, people.sam, 1_000);
    // Sam's device writing Alex's record, new or over Alex's: skipped.
    await write(users.sam, people.alex, 2_000);
    expect(await stored()).toEqual([
      { record_id: people.alex, version: version(1_000) },
      { record_id: people.sam, version: version(1_000) },
    ]);
    // Another of Alex's devices may.
    await write(users.laterAlex, people.alex, 3_000);
    expect((await stored())[0].version).toBe(version(3_000));
  });
});
