#!/usr/bin/env node
// Operator cleanup for shared photos (docs/PARTNER_SYNC.md §18). Deletes, through Storage,
// encrypted photo parts nothing accounts for any more (their space is gone, because leaving
// stopped halfway, or their reservation was released), then releases reservations that
// never got a part. Run it on a schedule with the service role, never from the app:
//
//   SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
//     node scripts/cleanup-photo-storage.mjs
//
// Prints counts only. Everything it touches is ciphertext.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(2);
}
const olderThan = process.env.CLEANUP_PARTS_OLDER_THAN ?? '1 hour';
const reservationsOlderThan = process.env.CLEANUP_RESERVATIONS_OLDER_THAN ?? '1 day';

const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const orphans = await client.rpc('orphan_photo_parts', { older_than: olderThan });
if (orphans.error) {
  console.error(`Listing orphan parts failed: ${orphans.error.message}`);
  process.exit(1);
}
const names = (orphans.data ?? []).map((row) => row.name);
let removed = 0;
for (let i = 0; i < names.length; i += 100) {
  const batch = names.slice(i, i + 100);
  const { error } = await client.storage.from('photos').remove(batch);
  if (error) {
    console.error(`Removing parts failed: ${error.message}`);
    process.exit(1);
  }
  removed += batch.length;
}

const stale = await client.rpc('release_stale_reservations', { older_than: reservationsOlderThan });
if (stale.error) {
  console.error(`Releasing reservations failed: ${stale.error.message}`);
  process.exit(1);
}
console.log(`Removed ${removed} orphan photo part(s); released ${stale.data} unused reservation(s).`);
