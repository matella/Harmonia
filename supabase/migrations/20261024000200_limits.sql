-- Partner sharing, hardening (docs/PARTNER_SYNC.md §19): limits a member's own app can't
-- get around.
--  * Rate limits per device and hour on the calls that create something: spaces, invites,
--    claims, key changes, photo reservations, record writes. A call refused by its limit
--    leaves the counter as it was, so a device stays refused until the hour turns.
--    Calls that fail anyway (an unknown recovery key or invite) aren't counted: a counter
--    bumped by a failing call is rolled back with it. Those can't be guessed (a 128-bit
--    lookup, a random invite ID), and the platform limits requests per address.
--  * Size caps: an encrypted record at most 64 KiB with a 24-byte nonce, a space's records
--    at most 200 MiB in all (a setting, like the photo limit), an invite bundle 16 KiB.

create table public.rate_counters (
  device_id uuid not null,
  action text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (device_id, action, window_start)
);
alter table public.rate_counters enable row level security;
revoke all on public.rate_counters from anon, authenticated;

/** Counts one `what` for the calling device; refuses past `max_hits` in the window. */
create function public.take_rate(what text, max_hits integer, window_seconds integer)
returns void
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  bucket timestamptz := to_timestamp(floor(extract(epoch from now()) / window_seconds) * window_seconds);
  used integer;
begin
  if device is null then return; end if; -- not a device (the operator): other checks apply
  insert into rate_counters (device_id, action, window_start, hits)
    values (device, what, bucket, 1)
    on conflict (device_id, action, window_start) do update set hits = rate_counters.hits + 1
    returning hits into used;
  if used > max_hits then raise exception 'rate limited'; end if;
  delete from rate_counters r
    where r.device_id = device and r.window_start < now() - interval '2 days';
end
$$;
revoke all on function public.take_rate(text, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------
-- The limited calls: each original is kept under another name, out of members' reach,
-- and a function with the same name and arguments counts first.

alter function public.create_space(bytea, uuid, uuid, bytea) rename to create_space_unlimited;
revoke all on function public.create_space_unlimited(bytea, uuid, uuid, bytea) from public, anon, authenticated;
create function public.create_space(
  sealed_key bytea, self_person uuid, space uuid default null, signature bytea default null
) returns table (space_id uuid, person_id uuid, epoch integer)
language plpgsql security definer set search_path = public as $$
begin
  perform take_rate('create_space', 10, 3600);
  return query select * from create_space_unlimited(sealed_key, self_person, space, signature);
end
$$;

alter function public.create_invite(bytea) rename to create_invite_unlimited;
revoke all on function public.create_invite_unlimited(bytea) from public, anon, authenticated;
create function public.create_invite(wrapped_key bytea) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  perform take_rate('create_invite', 30, 3600);
  if length(wrapped_key) > 16384 then raise exception 'too large'; end if;
  return create_invite_unlimited(wrapped_key);
end
$$;

alter function public.claim_invite(uuid, uuid) rename to claim_invite_unlimited;
revoke all on function public.claim_invite_unlimited(uuid, uuid) from public, anon, authenticated;
create function public.claim_invite(invite uuid, person uuid)
returns table (inviter_sign_public_key bytea, inviter_box_public_key bytea)
language plpgsql security definer set search_path = public as $$
begin
  perform take_rate('claim_invite', 30, 3600);
  return query select * from claim_invite_unlimited(invite, person);
end
$$;

alter function public.rotate(uuid, integer, jsonb, jsonb, bytea, bytea) rename to rotate_unlimited;
revoke all on function public.rotate_unlimited(uuid, integer, jsonb, jsonb, bytea, bytea) from public, anon, authenticated;
create function public.rotate(
  target uuid,
  expected_epoch integer,
  envelopes jsonb,
  recovery_envelopes jsonb default '[]'::jsonb,
  new_lookup_hash bytea default null,
  new_public_key_hash bytea default null
) returns integer
language plpgsql security definer set search_path = public as $$
begin
  perform take_rate('rotate', 60, 3600);
  return rotate_unlimited(target, expected_epoch, envelopes, recovery_envelopes, new_lookup_hash, new_public_key_hash);
end
$$;

alter function public.reserve_blob(uuid, bigint) rename to reserve_blob_unlimited;
revoke all on function public.reserve_blob_unlimited(uuid, bigint) from public, anon, authenticated;
create function public.reserve_blob(blob uuid, size bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform take_rate('reserve_blob', 3000, 3600);
  perform reserve_blob_unlimited(blob, size);
end
$$;

revoke all on function
  public.create_space(bytea, uuid, uuid, bytea),
  public.create_invite(bytea),
  public.claim_invite(uuid, uuid),
  public.rotate(uuid, integer, jsonb, jsonb, bytea, bytea),
  public.reserve_blob(uuid, bigint)
from public;
grant execute on function
  public.create_space(bytea, uuid, uuid, bytea),
  public.create_invite(bytea),
  public.claim_invite(uuid, uuid),
  public.rotate(uuid, integer, jsonb, jsonb, bytea, bytea),
  public.reserve_blob(uuid, bigint)
to authenticated;

-- ---------------------------------------------------------------------------------
-- Records: size, total per space, writes per hour

alter table public.spaces add column record_bytes bigint not null default 0;
update public.spaces s
  set record_bytes = coalesce((select sum(length(r.ciphertext)) from public.records r where r.space_id = s.id), 0);
alter table public.storage_settings add column record_bytes_per_space bigint not null default 209715200
  check (record_bytes_per_space > 0);

create function public.records_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stored bigint;
  added bigint;
begin
  if length(new.nonce) <> 24 or length(new.ciphertext) > 65536 then
    raise exception 'record too large';
  end if;
  -- A push is an upsert: the insert trigger runs on the proposed row even when it turns
  -- into an update of a stored one, so what is stored counts as replaced either way (and
  -- the write is counted once, by the update trigger, in that case).
  if tg_op = 'UPDATE' then
    stored := length(old.ciphertext);
  else
    select length(r.ciphertext) into stored from records r
      where r.space_id = new.space_id and r.record_type = new.record_type and r.record_id = new.record_id;
  end if;
  if tg_op = 'UPDATE' or stored is null then perform take_rate('record', 20000, 3600); end if;
  added := length(new.ciphertext) - coalesce(stored, 0);
  -- What frees room must always get through, even in a full space: a purge (tiny, and it
  -- deletes the item's records) and a move to the trash (a tombstone barely grows).
  if new.record_type = 'purge' or (new.deleted and added <= 1024) then
    return new;
  end if;
  if added > 0 and (select s.record_bytes from spaces s where s.id = new.space_id) + added
       > (select st.record_bytes_per_space from storage_settings st where st.id = 1) then
    raise exception 'space full';
  end if;
  return new;
end
$$;
revoke all on function public.records_limits() from public;
-- Named to run before the other before-triggers (they run in name order).
create trigger records_a_limits before insert or update on public.records
  for each row execute function public.records_limits();

/** Keeps each space's total of record bytes, for the check above. */
create function public.records_bytes() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    update spaces set record_bytes = record_bytes - length(old.ciphertext) where id = old.space_id;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    update spaces set record_bytes = record_bytes + length(new.ciphertext) where id = new.space_id;
  end if;
  return null;
end
$$;
revoke all on function public.records_bytes() from public;
create trigger records_bytes after insert or update or delete on public.records
  for each row execute function public.records_bytes();
