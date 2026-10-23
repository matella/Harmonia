import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer } from './pglite-server';

/** membership(): how a device learns that its space ended or that it was removed (§17). */
const users = {
  alex: '00000000-0000-4000-8000-0000000003a1',
  sam: '00000000-0000-4000-8000-0000000003b1',
  nobody: '00000000-0000-4000-8000-0000000003c1',
} as const;
const people = {
  alex: '00000000-0000-4000-8000-0000000004a1',
  sam: '00000000-0000-4000-8000-0000000004b1',
} as const;

interface Membership {
  device_id: string;
  revoked: boolean;
  space_id: string | null;
  person_id: string | null;
  epoch: number | null;
}

let server: Awaited<ReturnType<typeof openServer>>;
const membership = (user: string) =>
  server.as(user, () => server.q<Membership>(`select * from membership()`));

describe('membership()', () => {
  beforeAll(async () => {
    server = await openServer();
    await server.register(users.alex, 1);
    await server.register(users.sam, 2);
  });

  it('follows a device through sharing, dissolving and sharing again', async () => {
    const [solo] = await membership(users.alex);
    expect(solo).toMatchObject({ revoked: false, space_id: null, person_id: null, epoch: null });

    const [{ space_id: first }] = await server.as(users.alex, () =>
      server.q<{ space_id: string }>(`select * from create_space($1, $2)`, [
        bytes(9, 80),
        people.alex,
      ]),
    );
    expect((await membership(users.alex))[0]).toMatchObject({
      space_id: first,
      person_id: people.alex,
      epoch: 1,
    });

    const [{ id: invite }] = await server.as(users.alex, () =>
      server.q<{ id: string }>(`select create_invite($1) as id`, [bytes(7, 72)]),
    );
    await server.as(users.sam, () =>
      server.q(`select * from claim_invite($1, $2)`, [invite, people.sam]),
    );
    await server.as(users.alex, () => server.q(`select approve_invite($1)`, [invite]));
    expect((await membership(users.sam))[0]).toMatchObject({
      space_id: first,
      person_id: people.sam,
    });

    // Alex leaves: the space is gone for both, and each device can tell.
    await server.as(users.alex, () => server.q(`select dissolve_space()`));
    for (const user of [users.alex, users.sam]) {
      expect((await membership(user))[0]).toMatchObject({
        revoked: false,
        space_id: null,
        person_id: null,
      });
    }

    // Sharing again later creates a new space instead of finding the old one.
    const [{ space_id: second }] = await server.as(users.alex, () =>
      server.q<{ space_id: string }>(`select * from create_space($1, $2)`, [
        bytes(9, 80),
        people.alex,
      ]),
    );
    expect(second).not.toBe(first);
  });

  it('reports a revoked device, and nothing for a user without a device', async () => {
    const [{ device_id: alexDevice }] = await membership(users.alex);
    await server.as(users.alex, () => server.q(`select revoke_device($1)`, [alexDevice]));
    expect((await membership(users.alex))[0].revoked).toBe(true);
    expect(await membership(users.nobody)).toEqual([]);
  });
});
