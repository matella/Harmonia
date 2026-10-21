import { execSync } from 'node:child_process';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Opt-in end-to-end check against a running local Supabase stack (`bunx supabase start`):
 * real anonymous sign-in (GoTrue), PostgREST and Postgres row-level security.
 * Run with: SUPABASE_LIVE=1 bunx vitest run supabase/tests/sharing-live.test.ts
 */
const live = process.env['SUPABASE_LIVE'] === '1';

function localStack(): { url: string; key: string } {
  const status = JSON.parse(execSync('bunx supabase status -o json', { encoding: 'utf-8' })) as Record<string, string>;
  return { url: status['API_URL'], key: status['PUBLISHABLE_KEY'] ?? status['ANON_KEY'] };
}

const hex = (bytes: Uint8Array) => '\\x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const version = (ms: number) => `${String(ms).padStart(13, '0')}-000000-0000abcd`;

async function device(url: string, key: string): Promise<SupabaseClient> {
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: authError } = await client.auth.signInAnonymously();
  if (authError) throw authError;
  const { error } = await client.from('devices').insert({ sign_public_key: hex(random(32)), box_public_key: hex(random(32)), platform: 'android' });
  if (error) throw error;
  return client;
}

describe.skipIf(!live)('sharing on a live local Supabase', () => {
  let inviter: SupabaseClient;
  let partner: SupabaseClient;
  let stranger: SupabaseClient;
  let space: string;
  const recordId = crypto.randomUUID();

  beforeAll(async () => {
    const { url, key } = localStack();
    [inviter, partner, stranger] = await Promise.all([device(url, key), device(url, key), device(url, key)]);
  });

  it('creates a space and stores an encrypted record only members can read', async () => {
    const created = await inviter.rpc('create_space', { sealed_key: hex(random(80)) });
    expect(created.error).toBeNull();
    space = (created.data as { space_id: string }[])[0].space_id;
    const insert = await inviter.from('records').insert({
      space_id: space,
      record_type: 'milestone',
      record_id: recordId,
      version: version(1000),
      epoch: 1,
      nonce: hex(random(24)),
      ciphertext: hex(random(64)),
    });
    expect(insert.error).toBeNull();
    expect((await inviter.from('records').select('record_id')).data).toHaveLength(1);
    expect((await stranger.from('records').select('record_id')).data).toEqual([]);
    const intrude = await stranger.from('records').insert({
      space_id: space,
      record_type: 'milestone',
      record_id: crypto.randomUUID(),
      version: version(2000),
      epoch: 1,
      nonce: hex(random(24)),
      ciphertext: hex(random(64)),
    });
    expect(intrude.error?.message).toMatch(/row-level security/);
  });

  it('runs the invite, claim and approve flow with single-use invites', async () => {
    const invite = await inviter.rpc('create_invite', { wrapped_key: hex(random(72)) });
    expect(invite.error).toBeNull();
    const id = invite.data as string;
    expect((await partner.rpc('claim_invite', { invite: id })).error).toBeNull();
    expect((await stranger.rpc('claim_invite', { invite: id })).error?.message).toMatch(/invite unavailable/);
    expect((await partner.from('records').select('record_id')).data).toEqual([]);
    expect((await stranger.rpc('approve_invite', { invite: id, sealed_key: hex(random(80)) })).error?.message).toMatch(/not allowed/);
    expect((await inviter.rpc('approve_invite', { invite: id, sealed_key: hex(random(80)) })).error).toBeNull();
    expect((await partner.from('records').select('record_id')).data).toEqual([{ record_id: recordId }]);
    expect((await partner.from('key_envelopes').select('id')).data).toHaveLength(1);
  });

  it('ignores an older version and dissolves the space for everyone', async () => {
    await partner.from('records').update({ version: version(500), ciphertext: hex(random(64)) }).eq('record_id', recordId);
    const row = await partner.from('records').select('version').eq('record_id', recordId).single();
    expect(row.data?.version).toBe(version(1000));
    expect((await partner.rpc('dissolve_space')).error).toBeNull();
    expect((await inviter.from('records').select('record_id')).data).toEqual([]);
    expect((await inviter.from('spaces').select('id')).data).toEqual([]);
  });

  it('exposes nothing to the anonymous (signed-out) role', async () => {
    const { url, key } = localStack();
    const anon = createClient(url, key, { auth: { persistSession: false } });
    expect((await anon.from('devices').select('id')).data ?? []).toEqual([]);
    expect((await anon.from('records').select('record_id')).data ?? []).toEqual([]);
  });
});
