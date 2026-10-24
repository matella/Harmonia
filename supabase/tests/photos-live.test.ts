import { execSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * What the local Supabase stack enforces for photos (docs/PARTNER_SYNC.md §18), tried
 * the way a hostile member would: straight against Storage with their own session, not
 * through the app. Run with: SUPABASE_LIVE=1 bunx vitest run supabase/tests/photos-live.test.ts
 */
const live = process.env['SUPABASE_LIVE'] === '1';

const MiB = 1024 * 1024;
const PART_LIMIT = 16 * (65536 + 17);

function localStack(): { url: string; key: string } {
  const status = JSON.parse(
    execSync('bunx supabase status -o json', { encoding: 'utf-8' }),
  ) as Record<string, string>;
  return { url: status['API_URL'], key: status['PUBLISHABLE_KEY'] ?? status['ANON_KEY'] };
}

function psql(sql: string): string {
  return execSync('docker exec -i supabase_db_Harmonia psql -U postgres -At -v ON_ERROR_STOP=1', {
    input: sql,
    encoding: 'utf-8',
  }).trim();
}

const hex = (bytes: Uint8Array) =>
  '\\x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const random = (n: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536)
    crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
};

async function device(url: string, key: string): Promise<SupabaseClient> {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: authError } = await client.auth.signInAnonymously();
  if (authError) throw authError;
  const { error } = await client.rpc('register_device', {
    sign_key: hex(random(32)),
    box_key: hex(random(32)),
    device_platform: 'android',
    credential: hex(random(32)),
  });
  if (error) throw error;
  return client;
}

describe.skipIf(!live)('photo storage on a live local Supabase', () => {
  let member: SupabaseClient;
  let stranger: SupabaseClient;
  let space: string;
  const blob = crypto.randomUUID();
  const upload = (client: SupabaseClient, path: string, bytes: Uint8Array, upsert = false) =>
    client.storage.from('photos').upload(path, bytes, {
      contentType: 'application/octet-stream',
      upsert,
    });

  let stackUrl = '';
  let stackKey = '';
  /** A resumable (TUS) upload, as a member could send it without the app. Returns the final status. */
  const tus = async (client: SupabaseClient, path: string, bytes: Uint8Array) => {
    const token = (await client.auth.getSession()).data.session!.access_token;
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const headers = {
      Authorization: `Bearer ${token}`,
      apikey: stackKey,
      'Tus-Resumable': '1.0.0',
    };
    const created = await fetch(`${stackUrl}/storage/v1/upload/resumable`, {
      method: 'POST',
      headers: {
        ...headers,
        'Upload-Length': String(bytes.length),
        'Upload-Metadata': `bucketName ${b64('photos')},objectName ${b64(path)},contentType ${b64('application/octet-stream')}`,
      },
    });
    if (created.status !== 201) return created.status;
    const location = created.headers.get('location')!;
    const sent = await fetch(location.startsWith('http') ? location : `${stackUrl}${location}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream',
      },
      body: bytes as unknown as BodyInit,
    });
    return sent.status;
  };

  beforeAll(async () => {
    const { url, key } = localStack();
    stackUrl = url;
    stackKey = key;
    [member, stranger] = await Promise.all([device(url, key), device(url, key)]);
    const created = await member.rpc('create_space', {
      sealed_key: hex(random(80)),
      self_person: crypto.randomUUID(),
    });
    if (created.error) throw created.error;
    space = (created.data as { space_id: string }[])[0].space_id;
  });

  afterAll(async () => {
    await member?.rpc('dissolve_space');
  });

  it('stores parts only for a photo reserved in my space, within its size', async () => {
    // Nothing reserved yet: refused.
    expect((await upload(member, `${space}/${blob}/0`, random(1000))).error).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });

    expect(
      (await member.rpc('reserve_blob', { blob, size: Math.round(1.5 * MiB) })).error,
    ).toBeNull();
    // Asking again with the same size is a no-op; another size is refused.
    expect(
      (await member.rpc('reserve_blob', { blob, size: Math.round(1.5 * MiB) })).error,
    ).toBeNull();
    expect((await member.rpc('reserve_blob', { blob, size: 10 })).error?.message).toMatch(
      /not allowed/,
    );

    const part0 = random(PART_LIMIT);
    expect((await upload(member, `${space}/${blob}/0`, part0)).error).toBeNull();
    // The last part is exactly what half a MiB becomes: 8 chunks of 64 KiB plus 17 bytes each.
    expect((await upload(member, `${space}/${blob}/1`, random(1000))).error).toMatchObject({
      message: expect.stringMatching(/database error/),
    });
    expect((await upload(member, `${space}/${blob}/1`, random(524288 + 8 * 17))).error).toBeNull();
    // 1.5 MiB has two parts: a third is refused, and so are odd names.
    for (const name of [
      `${blob}/2`,
      `${blob}/01`,
      `${blob}/1/x`,
      `${blob}/-1`,
      `${crypto.randomUUID()}/0`,
    ]) {
      expect((await upload(member, `${space}/${name}`, random(100))).error, name).toMatchObject({
        message: expect.stringMatching(/row-level security/),
      });
    }
    // Over one part's size: the bucket refuses it, even at an allowed name.
    const big = crypto.randomUUID();
    expect((await member.rpc('reserve_blob', { blob: big, size: 3 * MiB })).error).toBeNull();
    expect((await upload(member, `${space}/${big}/0`, random(PART_LIMIT + 1))).error).toMatchObject(
      { message: expect.stringMatching(/exceeded the maximum allowed size/) },
    );
    // A stored part can't be replaced, with or without upsert.
    expect((await upload(member, `${space}/${blob}/0`, random(PART_LIMIT))).error).toMatchObject({
      message: expect.stringMatching(/already exists/),
    });
    expect((await upload(member, `${space}/${blob}/0`, random(100), true)).error).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });

    // Read back as stored.
    const { data, error } = await member.storage.from('photos').download(`${space}/${blob}/0`);
    expect(error).toBeNull();
    expect(new Uint8Array(await data!.arrayBuffer())).toEqual(part0);
    expect(
      psql(
        `select count(*) from storage.objects where bucket_id = 'photos' and name like '${space}/%'`,
      ),
    ).toBe('2');
  });

  it('never stores more than the space was charged for', async () => {
    // A tiny reservation must not buy a full part.
    const tiny = crypto.randomUUID();
    expect((await member.rpc('reserve_blob', { blob: tiny, size: 1 })).error).toBeNull();
    expect((await upload(member, `${space}/${tiny}/0`, random(PART_LIMIT))).error).toMatchObject({
      message: expect.stringMatching(/database error/),
    });
    // And a refused part leaves nothing behind in Storage.
    expect(psql(`select count(*) from storage.objects where name = '${space}/${tiny}/0'`)).toBe(
      '0',
    );
    // Exactly its encrypted size (1 byte + 17) is what it may store.
    expect((await upload(member, `${space}/${tiny}/0`, random(18))).error).toBeNull();
  });

  it('applies the same rules to resumable (TUS) uploads', async () => {
    const tiny = crypto.randomUUID();
    expect((await member.rpc('reserve_blob', { blob: tiny, size: 1 })).error).toBeNull();
    const count = (name: string) =>
      psql(`select count(*) from storage.objects where name = '${space}/${name}'`);
    // Unreserved, too big for the bucket, or not the reserved size: refused.
    expect(await tus(member, `${space}/${crypto.randomUUID()}/0`, random(18))).not.toBe(204);
    expect(await tus(member, `${space}/${tiny}/0`, random(PART_LIMIT + 1))).not.toBe(204);
    expect(await tus(member, `${space}/${tiny}/0`, random(PART_LIMIT))).not.toBe(204);
    expect(count(`${tiny}/0`)).toBe('0');
    expect(await tus(stranger, `${space}/${tiny}/0`, random(18))).not.toBe(204);
    // The exact size goes through, once.
    expect(await tus(member, `${space}/${tiny}/0`, random(18))).toBe(204);
    expect(count(`${tiny}/0`)).toBe('1');
  });

  it('keeps strangers out, and offers no way around Storage', async () => {
    const other = crypto.randomUUID();
    expect((await stranger.rpc('reserve_blob', { blob: other, size: 100 })).error?.message).toMatch(
      /not a member/,
    );
    expect((await upload(stranger, `${space}/${blob}/1`, random(100))).error).toMatchObject({
      message: expect.stringMatching(/row-level security/),
    });
    expect(
      (await stranger.storage.from('photos').download(`${space}/${blob}/0`)).error,
    ).not.toBeNull();
    expect((await stranger.storage.from('photos').list(space)).data ?? []).toEqual([]);
    expect(
      (await stranger.storage.from('photos').remove([`${space}/${blob}/0`])).data ?? [],
    ).toEqual([]);
    expect(
      psql(
        `select count(*) from storage.objects where bucket_id = 'photos' and name = '${space}/${blob}/0'`,
      ),
    ).toBe('1');
    // The storage tables and the reservations aren't reachable through the data API.
    expect((await member.schema('storage').from('objects').select('name')).error).not.toBeNull();
    expect((await member.from('blobs').select('*')).error).not.toBeNull();
    expect(
      (
        await member
          .from('blobs')
          .insert({ space_id: space, id: other, size: 1, parts: 9999, created_by: other })
      ).error,
    ).not.toBeNull();
    // Nor is the bucket's limit something a member can change.
    expect(
      (await member.storage.updateBucket('photos', { public: true, fileSizeLimit: 999999999 }))
        .error,
    ).not.toBeNull();
    expect(
      psql(
        `select public::text || ' ' || file_size_limit from storage.buckets where id = 'photos'`,
      ),
    ).toBe(`false ${PART_LIMIT}`);
  });

  it('refuses reservations past the space’s limit, which the operator can change', async () => {
    const before = await member.rpc('space_storage');
    expect(before.error).toBeNull();
    const used = Number((before.data as { used: number }[])[0].used);
    expect(used).toBe(Math.round(1.5 * MiB) + 3 * MiB + 2);
    psql(`update storage_settings set photo_bytes_per_space = ${used + 2 * MiB}`);
    try {
      expect(
        (await member.rpc('reserve_blob', { blob: crypto.randomUUID(), size: 2 * MiB })).error,
      ).toBeNull();
      const full = await member.rpc('reserve_blob', { blob: crypto.randomUUID(), size: 1 });
      expect(full.error?.message).toMatch(/storage full/);
      // Many at once can't slip past it either.
      const many = await Promise.all(
        Array.from({ length: 5 }, () =>
          member.rpc('reserve_blob', { blob: crypto.randomUUID(), size: 1 }),
        ),
      );
      expect(many.every((r) => /storage full/.test(r.error?.message ?? ''))).toBe(true);
    } finally {
      psql(`update storage_settings set photo_bytes_per_space = 2147483648`);
    }
  });
});
