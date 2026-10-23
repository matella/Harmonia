-- Security review of slice 3a (docs/PARTNER_SYNC.md §17):
--  1. A device trusts a key envelope only if it carries that device's own signature over
--     (space, epoch, device, sealed key). The server, which can write any row, can no
--     longer plant a key it knows for a device that lost its local copy. Members may file
--     envelopes only for their own device (rotation in phase 3 adds a checked function).
--  2. Person IDs are unique per space, not across the server, so knowing someone's ID
--     does not let anyone block them from creating or joining a space.

-- 1. Signed envelopes ----------------------------------------------------------------

alter table public.key_envelopes add column signature bytea check (signature is null or length(signature) = 64);

drop policy envelopes_member_insert on public.key_envelopes;
create policy envelopes_own_insert on public.key_envelopes for insert to authenticated
  with check (device_id = public.current_device_id() and public.is_space_member(space_id));

-- 2. Person IDs per space ------------------------------------------------------------

alter table public.devices drop constraint devices_person_id_fkey;
alter table public.persons drop constraint persons_pkey;
alter table public.persons add primary key (space_id, id);
alter table public.devices add constraint devices_person_fkey
  foreign key (space_id, person_id) references public.persons (space_id, id) on delete set null (person_id);

-- Functions ---------------------------------------------------------------------------

drop function public.create_space(bytea, uuid);

/**
 * Creates the space `space` (chosen by the device, so it can sign its envelope first)
 * whose first person is `self_person`. If the caller already belongs to a space under
 * that person (a retry, or sharing again after going solo on the device), returns it.
 */
create function public.create_space(
  sealed_key bytea,
  self_person uuid,
  space uuid default null,
  signature bytea default null
)
returns table (space_id uuid, person_id uuid, epoch integer)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  mine devices%rowtype;
  new_space uuid := coalesce(space, gen_random_uuid());
begin
  if device is null then raise exception 'unknown device'; end if;
  if self_person is null then raise exception 'person required'; end if;
  select * into mine from devices d where d.id = device;
  if mine.space_id is not null then
    if mine.person_id = self_person then
      return query select s.id, mine.person_id, s.epoch from spaces s where s.id = mine.space_id;
      return;
    end if;
    raise exception 'already in a space';
  end if;
  insert into spaces (id) values (new_space);
  insert into persons (id, space_id) values (self_person, new_space);
  update devices set space_id = new_space, person_id = self_person where id = device;
  insert into key_envelopes (space_id, epoch, device_id, sealed, signature)
    values (new_space, 1, device, sealed_key, signature);
  return query select new_space, self_person, 1;
end
$$;

create or replace function public.claim_invite(invite uuid, person uuid)
returns table (inviter_sign_public_key bytea, inviter_box_public_key bytea)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  row invites%rowtype;
begin
  if device is null then raise exception 'unknown device'; end if;
  if person is null then raise exception 'person required'; end if;
  select * into row from invites i where i.id = invite for update;
  if not found or row.expires_at <= now() or row.envelope is null then raise exception 'invite unavailable'; end if;
  if row.claimed_at is not null and (row.joiner_device_id is distinct from device or row.joiner_person_id <> person) then
    raise exception 'invite unavailable';
  end if;
  if exists (select 1 from devices d where d.id = device and d.space_id is not null) then
    raise exception 'already in a space';
  end if;
  if exists (select 1 from persons p where p.space_id = row.space_id and p.id = person) then
    raise exception 'person exists';
  end if;
  update invites set joiner_device_id = device, joiner_person_id = person, claimed_at = coalesce(claimed_at, now())
    where id = invite;
  return query select d.sign_public_key, d.box_public_key from devices d where d.id = row.inviter_device_id;
end
$$;

drop function public.finish_join(uuid, bytea);

/**
 * The joiner files the space key sealed to its own device, with its signature, and the
 * invite envelope is cleared. A retry replaces the row with the same values.
 */
create function public.finish_join(invite uuid, sealed_key bytea, signature bytea default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  row invites%rowtype;
  target uuid;
  current_epoch integer;
begin
  select * into row from invites i where i.id = invite for update;
  if not found or row.joiner_device_id is distinct from device or row.approved_at is null then
    raise exception 'invite unavailable';
  end if;
  select s.id, s.epoch into target, current_epoch from spaces s where s.id = row.space_id;
  insert into key_envelopes (space_id, epoch, device_id, sealed, signature)
    values (target, current_epoch, device, sealed_key, finish_join.signature)
    on conflict (space_id, epoch, device_id) where device_id is not null
    do update set sealed = excluded.sealed, signature = excluded.signature;
  update invites set envelope = null where id = invite;
end
$$;

revoke all on function public.create_space(bytea, uuid, uuid, bytea), public.finish_join(uuid, bytea, bytea)
  from public;
grant execute on function public.create_space(bytea, uuid, uuid, bytea), public.finish_join(uuid, bytea, bytea)
  to authenticated;
