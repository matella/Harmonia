-- Partner sharing phase 2, slice 2 (docs/PARTNER_SYNC.md §17):
--  * devices register through a function that also stores a re-attach credential;
--  * a device whose Supabase session was lost (expired, cleared, reinstalled with its
--    keys intact) re-attaches to its device row with that credential;
--  * writes to one space's records are serialised, so change numbers become visible in
--    order and an incremental pull can never step over a slow transaction.

-- The device keeps a random 32-byte secret in its secure store; the server keeps only its
-- SHA-256. No policies: only the functions below can read or change it.
create table public.device_credentials (
  device_id uuid primary key references public.devices (id) on delete cascade,
  rebind_hash bytea not null check (length(rebind_hash) = 32),
  updated_at timestamptz not null default now()
);
alter table public.device_credentials enable row level security;
revoke all on public.device_credentials from anon, authenticated;

-- Registration now always goes through register_device, so every device has a credential.
drop policy devices_register on public.devices;

/** Registers the calling (anonymous) user as a device. Retrying with the same keys is safe. */
create function public.register_device(sign_key bytea, box_key bytea, device_platform text, credential bytea)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  existing devices%rowtype;
  device uuid;
begin
  if caller is null then raise exception 'not signed in'; end if;
  if credential is null or length(credential) <> 32 then raise exception 'invalid credential'; end if;
  select * into existing from devices d where d.auth_user_id = caller;
  if found then
    -- The reply to an earlier registration was lost: same keys only.
    if existing.sign_public_key <> sign_key or existing.revoked_at is not null then
      raise exception 'already registered';
    end if;
    update device_credentials set rebind_hash = credential, updated_at = now() where device_id = existing.id;
    return existing.id;
  end if;
  insert into devices (auth_user_id, sign_public_key, box_public_key, platform)
    values (caller, sign_key, box_key, device_platform)
    returning id into device;
  insert into device_credentials (device_id, rebind_hash) values (device, credential);
  return device;
end
$$;

/**
 * Moves a device to the calling (new) anonymous user when the device proves it holds the
 * current credential, and replaces the credential. A revoked device cannot come back.
 */
create function public.rebind_device(device uuid, secret bytea, next_credential bytea)
returns void
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'not signed in'; end if;
  if next_credential is null or length(next_credential) <> 32 then raise exception 'invalid credential'; end if;
  if secret is null or not exists (
    select 1 from device_credentials c join devices d on d.id = c.device_id
    where c.device_id = rebind_device.device and c.rebind_hash = sha256(secret) and d.revoked_at is null
  ) then
    raise exception 'not allowed';
  end if;
  if exists (select 1 from devices d where d.auth_user_id = caller and d.id <> rebind_device.device) then
    raise exception 'already registered';
  end if;
  update devices set auth_user_id = caller, last_seen_at = now() where id = rebind_device.device;
  update device_credentials set rebind_hash = next_credential, updated_at = now()
    where device_id = rebind_device.device;
end
$$;

-- One writer per space at a time: the lock is taken before a change number is drawn and
-- held until commit, so within a space numbers become visible in increasing order.
create or replace function public.records_assign_seq() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('harmonia.records:' || new.space_id::text, 0));
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;

create or replace function public.records_keep_newest() returns trigger
language plpgsql as $$
begin
  if new.space_id <> old.space_id or new.record_type <> old.record_type or new.record_id <> old.record_id then
    raise exception 'record identity is immutable';
  end if;
  if new.version <= old.version then
    return null; -- skip this update
  end if;
  perform pg_advisory_xact_lock(hashtextextended('harmonia.records:' || new.space_id::text, 0));
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;

revoke all on function public.register_device(bytea, bytea, text, bytea), public.rebind_device(uuid, bytea, bytea)
  from public;
grant execute on function public.register_device(bytea, bytea, text, bytea), public.rebind_device(uuid, bytea, bytea)
  to authenticated;
