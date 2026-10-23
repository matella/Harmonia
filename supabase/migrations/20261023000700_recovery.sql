-- Partner sharing phase 4 (docs/PARTNER_SYNC.md §8): the recovery key.
--  * per person, only the SHA-256 of the recovery lookup ID and of the recovery public key,
--    in a table no member can read or change (like device_credentials);
--  * recovery envelopes: each epoch's key sealed to the person's recovery public key and
--    signed by the sealing device, stored per person;
--  * recover(), and rotate() re-sealing every recovery envelope in the same all-or-nothing
--    call. A rotation that removes no device also sets up or replaces a recovery key, and
--    repairs missing recovery envelopes: so the newest key a recovering device receives
--    is always signed by a device listed under an older key (§8, step 3).

create table public.recovery_lookups (
  space_id uuid not null,
  person_id uuid not null,
  lookup_hash bytea not null unique check (length(lookup_hash) = 32),
  -- Which public key the envelopes must be sealed to. The server can't check a sealed box,
  -- so each envelope names the key's hash, and one for an older key is skipped.
  public_key_hash bytea not null check (length(public_key_hash) = 32),
  updated_at timestamptz not null default now(),
  primary key (space_id, person_id),
  foreign key (space_id, person_id) references public.persons (space_id, id) on delete cascade
);
alter table public.recovery_lookups enable row level security;
revoke all on public.recovery_lookups from anon, authenticated;

-- Recovery envelopes are keyed by person, not by a lookup the server could hand out.
drop index public.key_envelopes_recovery;
alter table public.key_envelopes drop constraint key_envelopes_check;
alter table public.key_envelopes drop column recovery_lookup_id;
alter table public.key_envelopes add column recovery_person_id uuid;
alter table public.key_envelopes add constraint key_envelopes_target_check
  check ((device_id is null) <> (recovery_person_id is null));
create unique index key_envelopes_recovery on public.key_envelopes (space_id, epoch, recovery_person_id)
  where recovery_person_id is not null;

alter table public.records drop constraint records_record_type_check;
alter table public.records add constraint records_record_type_check
  check (record_type in ('profile', 'person', 'milestone', 'memory', 'memory_media', 'device', 'recovery'));

-- ---------------------------------------------------------------------------------
-- Helpers

/**
 * Stores recovery envelopes ({person_id, epoch, sealed, signature, public_key_hash}) signed
 * by `caller`. An envelope for a person without a recovery key, or sealed to another key
 * than the person's current one, is skipped: sealing to fewer persons can't leak anything,
 * and a stale view must never make a whole rotation fail.
 */
create function public.store_recovery_envelopes(
  space uuid, caller uuid, items jsonb, min_epoch integer, max_epoch integer, only_person uuid
) returns void
language plpgsql security definer set search_path = public as $$
declare
  item jsonb;
  epoch_no integer;
  person uuid;
begin
  for item in select * from jsonb_array_elements(coalesce(items, '[]'::jsonb)) loop
    person := (item->>'person_id')::uuid;
    epoch_no := (item->>'epoch')::integer;
    if epoch_no < min_epoch or epoch_no > max_epoch then raise exception 'epoch changed'; end if;
    if only_person is not null and person <> only_person then raise exception 'unknown recipient'; end if;
    if not exists (
      select 1 from recovery_lookups r
      where r.space_id = space and r.person_id = person
        and r.public_key_hash = decode(item->>'public_key_hash', 'base64')
    ) then
      continue;
    end if;
    insert into key_envelopes (space_id, epoch, recovery_person_id, sealed, signature, signer_device_id)
      values (space, epoch_no, person, decode(item->>'sealed', 'base64'), decode(item->>'signature', 'base64'), caller)
      on conflict (space_id, epoch, recovery_person_id) where recovery_person_id is not null do nothing;
  end loop;
end
$$;
revoke all on function public.store_recovery_envelopes(uuid, uuid, jsonb, integer, integer, uuid) from public;

-- ---------------------------------------------------------------------------------
-- Recovering, repair

/**
 * Recovery (§8): the calling device, registered and in no space, presents the lookup ID
 * derived from a recovery key. It is admitted as a device of that person and receives the
 * person's recovery envelopes for every epoch (useless without the recovery key's private
 * half). No other device approves: holding the key is the proof. Asking again from the
 * same device (after an interruption) returns the same answer.
 */
create function public.recover(lookup bytea)
returns table (space_id uuid, person_id uuid, epoch integer, envelopes jsonb)
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := current_device_id();
  found_row recovery_lookups%rowtype;
begin
  if caller is null then raise exception 'unknown device'; end if;
  select * into found_row from recovery_lookups r where r.lookup_hash = sha256(recover.lookup);
  if not found then raise exception 'unknown recovery key'; end if;
  if exists (
    select 1 from devices d
    where d.id = caller and d.space_id is not null
      and (d.space_id <> found_row.space_id or d.person_id is distinct from found_row.person_id)
  ) then
    raise exception 'already in a space';
  end if;
  update devices set space_id = found_row.space_id, person_id = found_row.person_id where id = caller;
  return query
    select s.id, found_row.person_id, s.epoch,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'epoch', e.epoch,
          'sealed', encode(e.sealed, 'base64'),
          'signature', encode(e.signature, 'base64'),
          'signer_device_id', e.signer_device_id
        ) order by e.epoch)
        from key_envelopes e
        where e.space_id = found_row.space_id and e.recovery_person_id = found_row.person_id
      ), '[]'::jsonb)
    from spaces s where s.id = found_row.space_id;
end
$$;

/**
 * For members: persons of the space with a recovery key but no envelope for the current
 * epoch, with the hash of the public key to seal to. A device that knows a matching key
 * repairs this with a rotation that removes no device.
 */
create function public.persons_missing_recovery_envelope()
returns table (person_id uuid, public_key_hash bytea)
language plpgsql stable security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if space is null then raise exception 'not a member'; end if;
  return query
    select r.person_id, r.public_key_hash from recovery_lookups r join spaces s on s.id = r.space_id
    where r.space_id = space
      and not exists (
        select 1 from key_envelopes e
        where e.space_id = space and e.epoch = s.epoch and e.recovery_person_id = r.person_id
      );
end
$$;

-- ---------------------------------------------------------------------------------
-- Rotation, now also for recovery

drop function public.rotate(uuid, integer, jsonb);

/**
 * Starts the next epoch, all or nothing: removes `target` (null: no device is removed),
 * stores the device envelopes and the recovery envelopes (for the new epoch). With
 * `new_lookup_hash`, the caller's person gets a new recovery key: set up for the first
 * time or replaced. Its old envelopes go, and its new ones may cover every epoch.
 */
create function public.rotate(
  target uuid,
  expected_epoch integer,
  envelopes jsonb,
  recovery_envelopes jsonb default '[]'::jsonb,
  new_lookup_hash bytea default null,
  new_public_key_hash bytea default null
)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := current_device_id();
  me devices%rowtype;
  space uuid;
  current_epoch integer;
  next_epoch integer;
  item jsonb;
begin
  select * into me from devices d where d.id = caller;
  space := me.space_id;
  if caller is null or space is null then raise exception 'not a member'; end if;
  if (new_lookup_hash is null) <> (new_public_key_hash is null) then raise exception 'not allowed'; end if;
  if target is not null and not exists (
    select 1 from devices d where d.id = target and d.space_id = space and d.revoked_at is null
  ) then
    raise exception 'target not in space';
  end if;
  select s.epoch into current_epoch from spaces s where s.id = space for update;
  if current_epoch <> expected_epoch then raise exception 'epoch changed'; end if;

  if target is not null then update devices set revoked_at = now() where id = target; end if;
  next_epoch := current_epoch + 1;
  update spaces set epoch = next_epoch where id = space;

  for item in select * from jsonb_array_elements(coalesce(envelopes, '[]'::jsonb)) loop
    if not exists (
      select 1 from devices d
      where d.id = (item->>'device_id')::uuid and d.space_id = space and d.revoked_at is null
    ) then
      raise exception 'unknown recipient';
    end if;
    insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values (space, next_epoch, (item->>'device_id')::uuid, decode(item->>'sealed', 'base64'),
              decode(item->>'signature', 'base64'), caller);
  end loop;

  if new_lookup_hash is not null then
    insert into recovery_lookups (space_id, person_id, lookup_hash, public_key_hash)
      values (space, me.person_id, new_lookup_hash, new_public_key_hash)
      on conflict (space_id, person_id) do update
        set lookup_hash = excluded.lookup_hash, public_key_hash = excluded.public_key_hash, updated_at = now();
    delete from key_envelopes e where e.space_id = space and e.recovery_person_id = me.person_id;
    -- The caller's own person: any epoch up to the new one. Others: the new epoch only.
    perform store_recovery_envelopes(
      space, caller,
      (select coalesce(jsonb_agg(i), '[]'::jsonb) from jsonb_array_elements(recovery_envelopes) i
        where (i->>'person_id')::uuid = me.person_id),
      1, next_epoch, me.person_id);
    perform store_recovery_envelopes(
      space, caller,
      (select coalesce(jsonb_agg(i), '[]'::jsonb) from jsonb_array_elements(recovery_envelopes) i
        where (i->>'person_id')::uuid <> me.person_id),
      next_epoch, next_epoch, null);
  else
    perform store_recovery_envelopes(space, caller, recovery_envelopes, next_epoch, next_epoch, null);
  end if;
  return next_epoch;
end
$$;

revoke all on function
  public.recover(bytea),
  public.persons_missing_recovery_envelope(),
  public.rotate(uuid, integer, jsonb, jsonb, bytea, bytea)
from public;
grant execute on function
  public.recover(bytea),
  public.persons_missing_recovery_envelope(),
  public.rotate(uuid, integer, jsonb, jsonb, bytea, bytea)
to authenticated;
