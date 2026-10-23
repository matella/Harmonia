import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer } from './pglite-server';

/** Invites v2 (§17 slice 3): own person IDs, key only after approval, retries. */
const users = {
  alex: '00000000-0000-4000-8000-0000000001a1',
  sam: '00000000-0000-4000-8000-0000000001b1',
  eve: '00000000-0000-4000-8000-0000000001c1',
  kim: '00000000-0000-4000-8000-0000000001d1',
  lou: '00000000-0000-4000-8000-0000000001e1',
} as const;
const people = {
  alex: '00000000-0000-4000-8000-0000000002a1',
  sam: '00000000-0000-4000-8000-0000000002b1',
  eve: '00000000-0000-4000-8000-0000000002c1',
  kim: '00000000-0000-4000-8000-0000000002d1',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let space: string;

const run = <R = Record<string, unknown>>(user: string, sql: string, params: unknown[] = []) =>
  server.as(user, () => server.q<R>(sql, params));
const newInvite = async () =>
  (await run<{ id: string }>(users.alex, `select create_invite($1) as id`, [bytes(7, 72)]))[0].id;

describe('invites v2 (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    for (const [i, user] of Object.values(users).entries()) await server.register(user, i + 1);
  });

  it('creates a space with the caller’s own person ID, and a retry returns it again', async () => {
    const [created] = await run<{ space_id: string; person_id: string; epoch: number }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), people.alex],
    );
    space = created.space_id;
    expect(created).toMatchObject({ person_id: people.alex, epoch: 1 });
    const [again] = await run<{ space_id: string }>(
      users.alex,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), people.alex],
    );
    expect(again.space_id).toBe(space);
    await expect(
      run(users.alex, `select * from create_space($1, $2)`, [bytes(9, 80), people.eve]),
    ).rejects.toThrow(/already in a space/);
    // Person IDs are unique per space: knowing Alex's does not block anyone.
    const [elsewhere] = await run<{ space_id: string }>(
      users.lou,
      `select * from create_space($1, $2)`,
      [bytes(9, 80), people.alex],
    );
    expect(elsewhere.space_id).not.toBe(space);
    // But nobody can join Alex's space under an ID it already has.
    const invite = await newInvite();
    await expect(
      run(users.eve, `select * from claim_invite($1, $2)`, [invite, people.alex]),
    ).rejects.toThrow(/person exists/);
    await run(users.alex, `select decline_invite($1)`, [invite]);
  });

  it('shows the claim to members only, with both of the joiner’s keys', async () => {
    const invite = await newInvite();
    expect(await run(users.alex, `select * from invite_claim($1)`, [invite])).toEqual([]);

    const claim = () =>
      run<{ inviter_sign_public_key: Uint8Array; inviter_box_public_key: Uint8Array }>(
        users.sam,
        `select * from claim_invite($1, $2)`,
        [invite, people.sam],
      );
    const [first] = await claim();
    expect([first.inviter_sign_public_key[0], first.inviter_box_public_key[0]]).toEqual([1, 101]);
    expect((await claim())[0].inviter_box_public_key[0]).toBe(101); // a retry is fine
    await expect(
      run(users.eve, `select * from claim_invite($1, $2)`, [invite, people.eve]),
    ).rejects.toThrow(/invite unavailable/);

    const [seen] = await run<{
      joiner_sign_public_key: Uint8Array;
      joiner_box_public_key: Uint8Array;
      approved: boolean;
    }>(users.alex, `select * from invite_claim($1)`, [invite]);
    expect([seen.joiner_sign_public_key[0], seen.joiner_box_public_key[0], seen.approved]).toEqual([
      2,
      102,
      false,
    ]);
    await expect(run(users.eve, `select * from invite_claim($1)`, [invite])).rejects.toThrow(
      /not allowed/,
    );

    // The key only comes after approval, and only to the claimed device.
    await expect(run(users.sam, `select * from accept_invite($1)`, [invite])).rejects.toThrow(
      /not approved yet/,
    );
    const approve = () =>
      run<{ person: string }>(users.alex, `select approve_invite($1) as person`, [invite]);
    expect((await approve())[0].person).toBe(people.sam);
    expect((await approve())[0].person).toBe(people.sam); // twice is a no-op
    await expect(run(users.eve, `select * from accept_invite($1)`, [invite])).rejects.toThrow(
      /invite unavailable/,
    );
    const [accepted] = await run<{
      envelope: Uint8Array;
      space_id: string;
      person_id: string;
      epoch: number;
    }>(users.sam, `select * from accept_invite($1)`, [invite]);
    expect(accepted).toMatchObject({ space_id: space, person_id: people.sam, epoch: 1 });
    expect(accepted.envelope[0]).toBe(7);

    await run(users.sam, `select finish_join($1, $2)`, [invite, bytes(8, 80)]);
    await run(users.sam, `select finish_join($1, $2)`, [invite, bytes(8, 80)]); // retry
    expect(await run(users.sam, `select sealed from key_envelopes`)).toHaveLength(1);
    await expect(run(users.sam, `select * from accept_invite($1)`, [invite])).rejects.toThrow(
      /invite unavailable/,
    );
    expect(await server.q(`select envelope from invites where id = $1`, [invite])).toEqual([
      { envelope: null },
    ]);
    // Server person IDs are the devices' own.
    expect(
      (
        await server.q<{ id: string }>(`select id from persons where space_id = $1 order by id`, [
          space,
        ])
      ).map((p) => p.id),
    ).toEqual([people.alex, people.sam]);
  });

  it('lets the inviter decline a claim, which ends the invite', async () => {
    const invite = await newInvite();
    await run(users.eve, `select * from claim_invite($1, $2)`, [invite, people.eve]);
    await expect(run(users.eve, `select decline_invite($1)`, [invite])).rejects.toThrow(
      /not allowed/,
    );
    await run(users.alex, `select decline_invite($1)`, [invite]);
    await expect(run(users.eve, `select * from accept_invite($1)`, [invite])).rejects.toThrow(
      /invite unavailable/,
    );
    await expect(
      run(users.kim, `select * from claim_invite($1, $2)`, [invite, people.kim]),
    ).rejects.toThrow(/invite unavailable/);
    expect(
      await server.q(`select count(*)::int as n from persons where id = $1`, [people.eve]),
    ).toEqual([{ n: 0 }]);
  });

  it('refuses to decline an approved invite or to claim from a device already in a space', async () => {
    const invite = await newInvite();
    await expect(
      run(users.sam, `select * from claim_invite($1, gen_random_uuid())`, [invite]),
    ).rejects.toThrow(/already in a space/);
    await run(users.kim, `select * from claim_invite($1, $2)`, [invite, people.kim]);
    await run(users.alex, `select approve_invite($1)`, [invite]);
    await expect(run(users.alex, `select decline_invite($1)`, [invite])).rejects.toThrow(
      /already approved/,
    );
  });

  it('lets a device file a key envelope only for itself', async () => {
    const [{ id: samDevice }] = await run<{ id: string }>(
      users.sam,
      `select current_device_id() as id`,
    );
    await expect(
      run(
        users.alex,
        `insert into key_envelopes (space_id, epoch, device_id, sealed) values ($1, 1, $2, $3)`,
        [space, samDevice, bytes(3, 80)],
      ),
    ).rejects.toThrow(/row-level security/);
    // Its own filing, through finish_join, kept the signature it sent.
    expect(
      await server.q(`select length(signature) as n from key_envelopes where device_id = $1`, [
        samDevice,
      ]),
    ).toEqual([{ n: null }]);
  });
});
