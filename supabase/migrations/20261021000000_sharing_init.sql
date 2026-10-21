-- Harmonia partner sharing: encrypted store (docs/PARTNER_SYNC.md §4).
-- PHASE 0 SPIKE — validated with PGlite in supabase/tests; not deployed anywhere yet.
--
-- The server only ever holds ciphertext, public keys and the metadata listed in §10.
-- Every table has row-level security; state-changing operations that cross devices
-- (create a space, invites, approval, revocation) go through SECURITY DEFINER functions
-- that check membership themselves.

create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  epoch integer not null default 1 check (epoch >= 1),
  created_at timestamptz not null default now()
);

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  -- The Supabase (anonymous) user this device signed in as. Identity itself rests on
  -- the device's signing key; the auth user is only the transport credential.
  auth_user_id uuid not null unique default auth.uid(),
  sign_public_key bytea not null unique check (length(sign_public_key) = 32),
  box_public_key bytea not null check (length(box_public_key) = 32),
  platform text not null check (platform in ('android', 'ios')),
  space_id uuid references public.spaces (id) on delete set null,
  person_id uuid references public.persons (id) on delete set null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.key_envelopes (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  epoch integer not null,
  device_id uuid references public.devices (id) on delete cascade,
  recovery_lookup_id text,
  sealed bytea not null,
  created_at timestamptz not null default now(),
  check ((device_id is null) <> (recovery_lookup_id is null))
);
create unique index key_envelopes_device on public.key_envelopes (space_id, epoch, device_id) where device_id is not null;
create unique index key_envelopes_recovery on public.key_envelopes (space_id, epoch, recovery_lookup_id) where recovery_lookup_id is not null;

create table public.records (
  space_id uuid not null references public.spaces (id) on delete cascade,
  record_type text not null check (record_type in ('profile', 'person', 'milestone', 'memory', 'memory_media')),
  record_id uuid not null,
  -- Hybrid logical clock, fixed-width so text order equals causal order.
  version text not null check (version ~ '^[0-9]{13}-[0-9]{6}-[0-9a-f]{8}$'),
  deleted boolean not null default false,
  epoch integer not null,
  nonce bytea not null,
  ciphertext bytea not null,
  -- Monotonic change cursor for incremental pulls.
  seq bigserial not null,
  primary key (space_id, record_type, record_id)
);
create index records_cursor on public.records (space_id, seq);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  inviter_device_id uuid not null references public.devices (id) on delete cascade,
  -- Space key wrapped with a key derived from the invite secret, which stays in the link.
  envelope bytea not null,
  expires_at timestamptz not null default now() + interval '24 hours',
  joiner_device_id uuid references public.devices (id) on delete set null,
  claimed_at timestamptz,
  approved_at timestamptz
);

-- ---------------------------------------------------------------------------------
-- Helpers

create function public.current_device_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from devices where auth_user_id = auth.uid() and revoked_at is null
$$;

create function public.is_space_member(target uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from devices
    where auth_user_id = auth.uid() and revoked_at is null and space_id = target
  )
$$;

-- An older version never overwrites a newer one (last writer wins by HLC).
create function public.records_keep_newest() returns trigger
language plpgsql as $$
begin
  if new.version <= old.version then
    return null; -- skip this update
  end if;
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;
create trigger records_keep_newest before update on public.records
  for each row execute function public.records_keep_newest();

-- ---------------------------------------------------------------------------------
-- Row-level security

alter table public.spaces enable row level security;
alter table public.persons enable row level security;
alter table public.devices enable row level security;
alter table public.key_envelopes enable row level security;
alter table public.records enable row level security;
alter table public.invites enable row level security;

create policy spaces_member_read on public.spaces for select to authenticated
  using (public.is_space_member(id));

create policy persons_member_all on public.persons for all to authenticated
  using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

-- A device sees itself and the devices of its own space (to seal keys to them).
create policy devices_read on public.devices for select to authenticated
  using (auth_user_id = auth.uid() or public.is_space_member(space_id));
create policy devices_register on public.devices for insert to authenticated
  with check (auth_user_id = auth.uid() and space_id is null and person_id is null and revoked_at is null);
-- Joining, leaving and revoking happen through the functions below, never by direct update.

-- A device reads only the envelopes sealed to it; members may add envelopes for the
-- devices of their own space (after rotation, approval or recovery-key replacement).
create policy envelopes_read_own on public.key_envelopes for select to authenticated
  using (device_id = public.current_device_id());
create policy envelopes_member_insert on public.key_envelopes for insert to authenticated
  with check (public.is_space_member(space_id));

create policy records_member_read on public.records for select to authenticated
  using (public.is_space_member(space_id));
create policy records_member_insert on public.records for insert to authenticated
  with check (public.is_space_member(space_id));
create policy records_member_update on public.records for update to authenticated
  using (public.is_space_member(space_id)) with check (public.is_space_member(space_id));

create policy invites_member_read on public.invites for select to authenticated
  using (public.is_space_member(space_id));

-- ---------------------------------------------------------------------------------
-- Operations

/** Creates a space and its first person, and makes the calling device a member. */
create function public.create_space(sealed_key bytea) returns table (space_id uuid, person_id uuid)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  new_space uuid;
  new_person uuid;
begin
  if device is null then raise exception 'unknown device'; end if;
  if (select d.space_id from devices d where d.id = device) is not null then raise exception 'already in a space'; end if;
  insert into spaces default values returning id into new_space;
  insert into persons (space_id) values (new_space) returning id into new_person;
  update devices set space_id = new_space, person_id = new_person where id = device;
  insert into key_envelopes (space_id, epoch, device_id, sealed) values (new_space, 1, device, sealed_key);
  return query select new_space, new_person;
end
$$;

create function public.create_invite(wrapped_key bytea) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
  invite uuid;
begin
  if space is null then raise exception 'not a member'; end if;
  insert into invites (space_id, inviter_device_id, envelope) values (space, device, wrapped_key) returning id into invite;
  return invite;
end
$$;

/**
 * The joiner claims an invite with its registered device: single use, before expiry.
 * Returns the wrapped key (useless without the secret in the link) and the inviter's
 * signing key for the safety code. Membership only starts after approve_invite.
 */
create function public.claim_invite(invite uuid) returns table (envelope bytea, inviter_sign_public_key bytea)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  row invites%rowtype;
begin
  if device is null then raise exception 'unknown device'; end if;
  select * into row from invites i where i.id = invite for update;
  if not found or row.claimed_at is not null or row.expires_at <= now() then raise exception 'invite unavailable'; end if;
  update invites set joiner_device_id = device, claimed_at = now() where id = invite;
  return query select row.envelope, d.sign_public_key from devices d where d.id = row.inviter_device_id;
end
$$;

/** The inviter approves the claimed device, as a new person or as another device of `as_person`. */
create function public.approve_invite(invite uuid, sealed_key bytea, as_person uuid default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  row invites%rowtype;
  person uuid := as_person;
begin
  select * into row from invites i where i.id = invite for update;
  if not found or not is_space_member(row.space_id) then raise exception 'not allowed'; end if;
  if row.joiner_device_id is null or row.approved_at is not null or row.expires_at <= now() then raise exception 'invite not ready'; end if;
  if person is null then
    insert into persons (space_id) values (row.space_id) returning id into person;
  elsif not exists (select 1 from persons p where p.id = person and p.space_id = row.space_id) then
    raise exception 'unknown person';
  end if;
  update devices set space_id = row.space_id, person_id = person where id = row.joiner_device_id and space_id is null;
  insert into key_envelopes (space_id, epoch, device_id, sealed)
    values (row.space_id, (select epoch from spaces where id = row.space_id), row.joiner_device_id, sealed_key);
  update invites set approved_at = now() where id = invite;
  return person;
end
$$;

/**
 * Revokes a device of the caller's space and starts a new epoch. The caller must then
 * seal the new key to every remaining device and recovery envelope (§7).
 */
create function public.revoke_device(target uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = target);
  next_epoch integer;
begin
  if space is null or not is_space_member(space) then raise exception 'not allowed'; end if;
  update devices set revoked_at = now() where id = target;
  update spaces set epoch = epoch + 1 where id = space returning epoch into next_epoch;
  return next_epoch;
end
$$;

/** Leaving dissolves the space for everyone; devices keep their local copies (§6.5). */
create function public.dissolve_space() returns void
language plpgsql security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if space is null then raise exception 'not a member'; end if;
  delete from spaces where id = space; -- cascades to persons, envelopes, records, invites
end
$$;

revoke all on function public.records_keep_newest() from public;
grant execute on function public.create_space(bytea), public.create_invite(bytea), public.claim_invite(uuid),
  public.approve_invite(uuid, bytea, uuid), public.revoke_device(uuid), public.dissolve_space()
  to authenticated;
