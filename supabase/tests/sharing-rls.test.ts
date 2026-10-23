import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Phase 0 spike: the sharing schema and its row-level security, run against real
 * Postgres (PGlite/WASM) with a Supabase auth shim. docs/PARTNER_SYNC.md §4, §15.
 */
const root = resolve(__dirname, '..');
const users = {
  matthieuPhone: '00000000-0000-4000-8000-0000000000a1',
  matthieuTablet: '00000000-0000-4000-8000-0000000000a2',
  samPhone: '00000000-0000-4000-8000-0000000000b1',
  stranger: '00000000-0000-4000-8000-0000000000c1',
} as const;
type User = keyof typeof users;

const bytes = (seed: number, length = 32) => new Uint8Array(length).fill(seed);
const version = (ms: number) => `${String(ms).padStart(13, '0')}-000000-0000abcd`;

let db: PGlite;

/** Runs `fn` as the given device's Supabase user, like a request with its JWT. */
async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${users[user]}';`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; reset request.jwt.claim.sub;`);
  }
}

const q = <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<R>(sql, params).then((r) => r.rows);

async function register(user: User, seed: number) {
  await as(user, () =>
    q(`select register_device($1, $2, 'android', $3)`, [bytes(seed), bytes(seed + 100), bytes(seed + 200)]),
  );
}

const people = {
  matthieu: '00000000-0000-4000-8000-00000000f0a1',
  sam: '00000000-0000-4000-8000-00000000f0b1',
  stranger: '00000000-0000-4000-8000-00000000f0c1',
} as const;

let space: string;
let matthieu: string;
let firstRecordId: string;

describe('sharing schema (PGlite + Supabase shim)', () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(readFileSync(resolve(root, 'tests/supabase-shim.sql'), 'utf-8'));
    for (const file of readdirSync(resolve(root, 'migrations')).sort()) {
      await db.exec(readFileSync(resolve(root, 'migrations', file), 'utf-8'));
    }
    await register('matthieuPhone', 1);
    await register('matthieuTablet', 2);
    await register('samPhone', 3);
    await register('stranger', 4);
  });

  it('creates a space with its first person, and only members see it', async () => {
    const [created] = await as('matthieuPhone', () => q<{ space_id: string; person_id: string }>(`select * from create_space($1, $2)`, [bytes(9, 80), people.matthieu]));
    space = created.space_id;
    matthieu = created.person_id;
    expect(await as('matthieuPhone', () => q(`select id from spaces`))).toHaveLength(1);
    expect(await as('stranger', () => q(`select id from spaces`))).toHaveLength(0);
  });

  it('keeps records to members: strangers can neither read nor write them', async () => {
    firstRecordId = '11111111-1111-4111-8111-111111111111';
    await as('matthieuPhone', () =>
      q(`insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext) values ($1, 'milestone', $2, $3, 1, $4, $5)`, [
        space,
        firstRecordId,
        version(1000),
        bytes(5, 24),
        bytes(6, 64),
      ]),
    );
    expect(await as('stranger', () => q(`select * from records`))).toHaveLength(0);
    await expect(
      as('stranger', () =>
        q(`insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext) values ($1, 'milestone', gen_random_uuid(), $2, 1, $3, $4)`, [
          space,
          version(2000),
          bytes(5, 24),
          bytes(6, 64),
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('invites are single use, need approval, and reveal only the wrapped key', async () => {
    const [{ create_invite: invite }] = await as('matthieuPhone', () => q<{ create_invite: string }>(`select create_invite($1)`, [bytes(7, 72)]));
    const [claim] = await as('samPhone', () =>
      q<{ inviter_sign_public_key: Uint8Array; inviter_box_public_key: Uint8Array }>(`select * from claim_invite($1, $2)`, [invite, people.sam]),
    );
    expect([...claim.inviter_sign_public_key]).toEqual([...bytes(1)]);
    expect([...claim.inviter_box_public_key]).toEqual([...bytes(101)]);
    await expect(as('stranger', () => q(`select * from claim_invite($1, $2)`, [invite, people.stranger]))).rejects.toThrow(/invite unavailable/);

    // Claimed but not approved: still not a member.
    expect(await as('samPhone', () => q(`select * from records`))).toHaveLength(0);
    await expect(as('stranger', () => q(`select approve_invite($1)`, [invite]))).rejects.toThrow(/not allowed/);

    await as('matthieuPhone', () => q(`select approve_invite($1)`, [invite]));
    expect(await as('samPhone', () => q(`select record_id from records`))).toHaveLength(1);
    // The joiner takes the key from the invite envelope, then files its own sealed copy.
    const [accepted] = await as('samPhone', () => q<{ envelope: Uint8Array }>(`select * from accept_invite($1)`, [invite]));
    expect(accepted.envelope[0]).toBe(7);
    await as('samPhone', () => q(`select finish_join($1, $2)`, [invite, bytes(8, 80)]));
    // Each device reads only the key envelope sealed to it.
    const envelopes = await as('samPhone', () => q<{ sealed: Uint8Array }>(`select sealed from key_envelopes`));
    expect(envelopes.map((e) => e.sealed[0])).toEqual([8]);
  });

  it('rejects expired invites', async () => {
    const [{ create_invite: invite }] = await as('matthieuPhone', () => q<{ create_invite: string }>(`select create_invite($1)`, [bytes(7, 72)]));
    await q(`update invites set expires_at = now() - interval '1 minute' where id = $1`, [invite]);
    await expect(as('stranger', () => q(`select * from claim_invite($1, $2)`, [invite, people.stranger]))).rejects.toThrow(/invite unavailable/);
  });

  it('never lets an older version overwrite a newer one', async () => {
    const update = (user: User, ms: number, seed: number) =>
      as(user, () => q(`update records set version = $1, ciphertext = $2 where record_id = $3`, [version(ms), bytes(seed, 64), firstRecordId]));
    const read = () => as('samPhone', () => q<{ version: string; seq: string }>(`select version, seq from records where record_id = $1`, [firstRecordId]));
    const before = (await read())[0];
    await update('samPhone', 500, 40); // older than 1000: ignored
    expect((await read())[0].version).toBe(version(1000));
    await update('samPhone', 3000, 41);
    const after = (await read())[0];
    expect(after.version).toBe(version(3000));
    expect(Number(after.seq)).toBeGreaterThan(Number(before.seq));
  });

  it('assigns the change cursor itself and keeps record identity immutable', async () => {
    const forged = '22222222-2222-4222-8222-222222222222';
    await as('samPhone', () =>
      q(`insert into records (space_id, record_type, record_id, version, epoch, nonce, ciphertext, seq) values ($1, 'memory', $2, $3, 1, $4, $5, 1)`, [
        space,
        forged,
        version(4000),
        bytes(5, 24),
        bytes(6, 64),
      ]),
    );
    const rows = await as('samPhone', () => q<{ record_id: string; seq: string }>(`select record_id, seq from records order by seq`));
    // A client-supplied low seq is ignored: the new record sorts after the existing one.
    expect(rows.map((r) => r.record_id)).toEqual([firstRecordId, forged]);
    await expect(
      as('samPhone', () => q(`update records set record_id = gen_random_uuid(), version = $1 where record_id = $2`, [version(5000), forged])),
    ).rejects.toThrow(/immutable/);
  });

  it('adds a second device for the same person, then revokes it with a new epoch', async () => {
    const [{ create_invite: invite }] = await as('matthieuPhone', () => q<{ create_invite: string }>(`select create_invite($1)`, [bytes(7, 72)]));
    await as('matthieuTablet', () => q(`select * from claim_invite($1, gen_random_uuid())`, [invite]));
    const [{ approve_invite: person }] = await as('matthieuPhone', () =>
      q<{ approve_invite: string }>(`select approve_invite($1, $2)`, [invite, matthieu]),
    );
    await as('matthieuTablet', () => q(`select finish_join($1, $2)`, [invite, bytes(10, 80)]));
    expect(person).toBe(matthieu);
    expect(await as('matthieuTablet', () => q(`select * from records`))).toHaveLength(2);

    const tablet = (await as('matthieuTablet', () => q<{ id: string }>(`select current_device_id() as id`)))[0].id;
    const [{ revoke_device: epoch }] = await as('samPhone', () => q<{ revoke_device: number }>(`select revoke_device($1)`, [tablet]));
    expect(epoch).toBe(2);
    expect(await as('matthieuTablet', () => q(`select * from records`))).toHaveLength(0);
    expect(await as('matthieuTablet', () => q(`select * from key_envelopes`))).toHaveLength(0);
  });

  it('dissolving deletes the whole space from the server for everyone', async () => {
    await as('samPhone', () => q(`select dissolve_space()`));
    expect(await q(`select count(*)::int as n from records`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from key_envelopes`)).toEqual([{ n: 0 }]);
    expect(await q(`select count(*)::int as n from spaces`)).toEqual([{ n: 0 }]);
    expect(await as('matthieuPhone', () => q(`select space_id from devices where auth_user_id = auth.uid()`))).toEqual([{ space_id: null }]);
  });

  it('gives the anonymous role nothing', async () => {
    await db.exec(`set role anon;`);
    try {
      expect(await q(`select * from devices`)).toHaveLength(0);
      expect(await q(`select * from records`)).toHaveLength(0);
    } finally {
      await db.exec(`reset role;`);
    }
  });
});
