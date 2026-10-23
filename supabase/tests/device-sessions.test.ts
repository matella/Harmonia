import { beforeAll, describe, expect, it } from 'vitest';

import { bytes, openServer, sha256, version } from './pglite-server';

/** Device registration, re-attaching a lost session, and ordered change numbers (§17). */
const users = {
  phone: '00000000-0000-4000-8000-0000000000d1',
  phoneAfterReinstall: '00000000-0000-4000-8000-0000000000d2',
  partner: '00000000-0000-4000-8000-0000000000d3',
  thief: '00000000-0000-4000-8000-0000000000d4',
  partnerAgain: '00000000-0000-4000-8000-0000000000d5',
} as const;

let server: Awaited<ReturnType<typeof openServer>>;
let phone: string;
const secret = bytes(42);

const whoAmI = (user: string) =>
  server
    .as(user, () => server.q<{ id: string | null }>(`select current_device_id() as id`))
    .then((r) => r[0].id);
const rebind = (user: string, device: string, proof: Uint8Array, next: Uint8Array) =>
  server.as(user, () =>
    server.q(`select rebind_device($1, $2, $3)`, [device, proof, sha256(next)]),
  );

describe('device sessions (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    server = await openServer();
    phone = await server.register(users.phone, 1, secret);
  });

  it('registers once per user; a retry with the same keys returns the same device', async () => {
    expect(await whoAmI(users.phone)).toBe(phone);
    expect(await server.register(users.phone, 1, secret)).toBe(phone);
    await expect(server.register(users.phone, 2)).rejects.toThrow(/already registered/);
    await expect(
      server.as(users.thief, () =>
        server.q(`select register_device($1, $2, 'android', $3)`, [
          bytes(3),
          bytes(4),
          bytes(5, 16),
        ]),
      ),
    ).rejects.toThrow(/invalid credential/);
  });

  it('accepts devices only through register_device', async () => {
    await expect(
      server.as(users.thief, () =>
        server.q(
          `insert into devices (sign_public_key, box_public_key, platform) values ($1, $2, 'ios')`,
          [bytes(6), bytes(7)],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('never exposes credentials, not even to the device itself', async () => {
    await expect(
      server.as(users.phone, () => server.q(`select * from device_credentials`)),
    ).rejects.toThrow(/permission denied/);
    const columns = await server.q<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'devices'`,
    );
    expect(columns.map((c) => c.column_name)).not.toContain('rebind_hash');
  });

  it('re-attaches a device to a new session with its secret, and rotates the secret', async () => {
    await expect(rebind(users.thief, phone, bytes(99), bytes(1))).rejects.toThrow(/not allowed/);
    expect(await whoAmI(users.thief)).toBeNull();

    const next = bytes(43);
    await rebind(users.phoneAfterReinstall, phone, secret, next);
    expect(await whoAmI(users.phoneAfterReinstall)).toBe(phone);
    expect(await whoAmI(users.phone)).toBeNull(); // the old session no longer acts as the device

    // The old secret is spent; the new one works.
    await expect(rebind(users.thief, phone, secret, bytes(1))).rejects.toThrow(/not allowed/);
    await rebind(users.phoneAfterReinstall, phone, next, bytes(44));
    expect(await whoAmI(users.phoneAfterReinstall)).toBe(phone);
  });

  it('refuses to re-attach a revoked device or to give one user two devices', async () => {
    const partnerSecret = bytes(60);
    const partner = await server.register(users.partner, 10, partnerSecret);
    await expect(
      rebind(users.phoneAfterReinstall, partner, partnerSecret, bytes(61)),
    ).rejects.toThrow(/already registered/);

    await server.as(users.partner, () =>
      server.q(`select create_space($1, gen_random_uuid())`, [bytes(9, 80)]),
    );
    await server.as(users.partner, () => server.q(`select revoke_device($1)`, [partner]));
    await expect(rebind(users.partnerAgain, partner, partnerSecret, bytes(62))).rejects.toThrow(
      /not allowed/,
    );
  });

  it('still numbers records in write order with the per-space lock', async () => {
    const [{ space_id: space }] = await server.as(users.phoneAfterReinstall, () =>
      server.q<{ space_id: string }>(`select * from create_space($1, gen_random_uuid())`, [
        bytes(9, 80),
      ]),
    );
    const insert = (id: string, ms: number) =>
      server.as(users.phoneAfterReinstall, () =>
        server.q(
          `insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext)
           values ($1, 'milestone', $2, $3, 1, $4, $5)
           on conflict (space_id, record_type, record_id) do update
             set version = excluded.version, ciphertext = excluded.ciphertext`,
          [space, id, version(ms), bytes(1, 24), bytes(2, 64)],
        ),
      );
    const a = '33333333-3333-4333-8333-333333333333';
    const b = '44444444-4444-4444-8444-444444444444';
    await insert(a, 1000);
    await insert(b, 1000);
    await insert(a, 2000); // an upsert that updates: renumbered after b
    await insert(b, 500); // stale: skipped, keeps its number
    const rows = await server.as(users.phoneAfterReinstall, () =>
      server.q<{ record_id: string; version: string }>(
        `select record_id, version from records order by seq`,
      ),
    );
    expect(rows).toEqual([
      { record_id: b, version: version(1000) },
      { record_id: a, version: version(2000) },
    ]);
  });
});
