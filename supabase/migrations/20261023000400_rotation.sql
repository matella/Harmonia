-- Partner sharing phase 3, slice 4 (docs/PARTNER_SYNC.md §7.3–7.5): removing a device.
--  * rotate(): revoke a device, start the next epoch and store the new key's envelopes in
--    one transaction, only if the space is still at the epoch the caller saw;
--  * envelopes record which device sealed and signed them;
--  * any member can fill in envelopes missing for the current epoch (repair);
--  * record writes under any epoch but the current one are skipped silently.

alter table public.key_envelopes
  add column signer_device_id uuid references public.devices (id) on delete set null;

-- Revoking on its own started an epoch with no envelopes, leaving every device without
-- the new key. Removal is now only possible through rotate().
drop function public.revoke_device(uuid);

/**
 * Removes `target` from the caller's space and starts the next epoch, storing the new
 * key's envelopes: a JSON array of {device_id, sealed, signature} (base64), sealed and
 * signed by the caller. Refused if the space is no longer at `expected_epoch` (someone
 * else rotated first) or if an envelope targets a device outside the space or removed.
 * Returns the new epoch.
 */
create function public.rotate(target uuid, expected_epoch integer, envelopes jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := current_device_id();
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
  current_epoch integer;
  next_epoch integer;
  item jsonb;
begin
  if caller is null or space is null then raise exception 'not a member'; end if;
  if not exists (select 1 from devices d where d.id = target and d.space_id = space and d.revoked_at is null) then
    raise exception 'unknown device';
  end if;
  select s.epoch into current_epoch from spaces s where s.id = space for update;
  if current_epoch <> expected_epoch then raise exception 'epoch changed'; end if;

  update devices set revoked_at = now() where id = target;
  next_epoch := current_epoch + 1;
  update spaces set epoch = next_epoch where id = space;

  for item in select * from jsonb_array_elements(coalesce(envelopes, '[]'::jsonb)) loop
    if not exists (
      select 1 from devices d
      where d.id = (item->>'device_id')::uuid and d.space_id = space and d.revoked_at is null
    ) then
      raise exception 'unknown device';
    end if;
    insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values (space, next_epoch, (item->>'device_id')::uuid, decode(item->>'sealed', 'base64'),
              decode(item->>'signature', 'base64'), caller);
  end loop;
  return next_epoch;
end
$$;

/** For members: the space's devices (not removed) that have no envelope for the current epoch. */
create function public.devices_missing_envelope()
returns table (device_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if space is null then raise exception 'not a member'; end if;
  return query
    select d.id from devices d join spaces s on s.id = d.space_id
    where d.space_id = space and d.revoked_at is null
      and not exists (
        select 1 from key_envelopes e
        where e.space_id = space and e.epoch = s.epoch and e.device_id = d.id
      );
end
$$;

/**
 * Repair: stores envelopes of the current epoch for devices of the space that have none
 * yet, sealed and signed by the caller. An existing envelope is never replaced.
 */
create function public.seal_missing(target_epoch integer, envelopes jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := current_device_id();
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
  item jsonb;
begin
  if caller is null or space is null then raise exception 'not a member'; end if;
  if (select s.epoch from spaces s where s.id = space) <> target_epoch then raise exception 'epoch changed'; end if;
  for item in select * from jsonb_array_elements(coalesce(envelopes, '[]'::jsonb)) loop
    if not exists (
      select 1 from devices d
      where d.id = (item->>'device_id')::uuid and d.space_id = space and d.revoked_at is null
    ) then
      raise exception 'unknown device';
    end if;
    insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values (space, target_epoch, (item->>'device_id')::uuid, decode(item->>'sealed', 'base64'),
              decode(item->>'signature', 'base64'), caller)
      on conflict (space_id, epoch, device_id) where device_id is not null do nothing;
  end loop;
end
$$;

-- Writes under any epoch but the space's current one are skipped, like stale ones: a
-- device that missed a rotation must take the new key before its changes can land.
create or replace function public.records_assign_seq() returns trigger
language plpgsql as $$
begin
  if public.records_version_too_far_ahead(new.version)
     or new.epoch is distinct from (select s.epoch from public.spaces s where s.id = new.space_id) then
    return null; -- skip this write
  end if;
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
  if new.version <= old.version or public.records_version_too_far_ahead(new.version)
     or new.epoch is distinct from (select s.epoch from public.spaces s where s.id = new.space_id) then
    return null; -- skip this write
  end if;
  perform pg_advisory_xact_lock(hashtextextended('harmonia.records:' || new.space_id::text, 0));
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;

revoke all on function public.rotate(uuid, integer, jsonb), public.devices_missing_envelope(),
  public.seal_missing(integer, jsonb) from public;
grant execute on function public.rotate(uuid, integer, jsonb), public.devices_missing_envelope(),
  public.seal_missing(integer, jsonb) to authenticated;

-- Security review of slice 3: a device may be approved as another device of a person
-- only by a device of that same person ("add one of my devices"), never as somebody
-- else. The joining device also checks the person against the invite envelope.
create or replace function public.approve_invite(invite uuid, as_person uuid default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  row invites%rowtype;
  person uuid;
begin
  select * into row from invites i where i.id = invite for update;
  if not found or not is_space_member(row.space_id) then raise exception 'not allowed'; end if;
  if row.approved_at is not null then
    return (select d.person_id from devices d where d.id = row.joiner_device_id);
  end if;
  if row.joiner_device_id is null or row.expires_at <= now() then raise exception 'invite not ready'; end if;
  if as_person is not null then
    if as_person is distinct from (select d.person_id from devices d where d.id = current_device_id()) then
      raise exception 'not allowed';
    end if;
    person := as_person;
  else
    person := row.joiner_person_id;
    insert into persons (id, space_id) values (person, row.space_id);
  end if;
  update devices set space_id = row.space_id, person_id = person
    where id = row.joiner_device_id and space_id is null;
  if not found then raise exception 'invite not ready'; end if;
  update invites set approved_at = now() where id = invite;
  return person;
end
$$;
