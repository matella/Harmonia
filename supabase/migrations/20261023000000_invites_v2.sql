-- Partner sharing phase 2, slice 3 (docs/PARTNER_SYNC.md §6.1–6.2, §17):
--  * person IDs on the server are the devices' own local person IDs, so records,
--    authors and server membership use the same identifiers;
--  * the space key reaches a joiner only after approval, through the invite envelope
--    (wrapped with the secret in the invite code, which the server never sees). The
--    inviter no longer seals the key to a public key the server handed over, so the
--    server cannot obtain it even if nobody compares the safety code;
--  * each side can read both public keys of the other device for the safety code;
--  * every step can be retried after a lost reply.

alter table public.invites alter column envelope drop not null;
alter table public.invites add column joiner_person_id uuid;

-- ---------------------------------------------------------------------------------
-- Create a space with the caller's own person ID.

drop function public.create_space(bytea);

/**
 * Creates a space whose first person is `self_person` (the device's local person ID) and
 * stores the caller's sealed key. If the caller already created this space (the reply was
 * lost), returns it again.
 */
create function public.create_space(sealed_key bytea, self_person uuid)
returns table (space_id uuid, person_id uuid, epoch integer)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  mine devices%rowtype;
  new_space uuid;
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
  if exists (select 1 from persons p where p.id = self_person) then raise exception 'person exists'; end if;
  insert into spaces default values returning id into new_space;
  insert into persons (id, space_id) values (self_person, new_space);
  update devices set space_id = new_space, person_id = self_person where id = device;
  insert into key_envelopes (space_id, epoch, device_id, sealed) values (new_space, 1, device, sealed_key);
  return query select new_space, self_person, 1;
end
$$;

-- ---------------------------------------------------------------------------------
-- Claim (joiner), see the claim (inviter), approve or decline (inviter).

drop function public.claim_invite(uuid);

/**
 * The joiner claims an invite for its device and its own person ID: single use, before
 * expiry. Returns the inviter device's public keys for the safety code. Claiming again
 * from the same device returns the same answer.
 */
create function public.claim_invite(invite uuid, person uuid)
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
  if exists (select 1 from persons p where p.id = person) then raise exception 'person exists'; end if;
  update invites set joiner_device_id = device, joiner_person_id = person, claimed_at = coalesce(claimed_at, now())
    where id = invite;
  return query select d.sign_public_key, d.box_public_key from devices d where d.id = row.inviter_device_id;
end
$$;

/** For members of the invite's space: the claimed device's public keys, if claimed. */
create function public.invite_claim(invite uuid)
returns table (joiner_sign_public_key bytea, joiner_box_public_key bytea, approved boolean)
language plpgsql security definer set search_path = public as $$
declare
  row invites%rowtype;
begin
  select * into row from invites i where i.id = invite;
  if not found or not is_space_member(row.space_id) then raise exception 'not allowed'; end if;
  return query
    select d.sign_public_key, d.box_public_key, row.approved_at is not null
    from devices d where d.id = row.joiner_device_id;
end
$$;

drop function public.approve_invite(uuid, bytea, uuid);

/**
 * The inviter approves the claimed device: as the person it claimed with, or (adding one
 * of my devices, phase 3) as an existing person of the space. Approving twice is a no-op.
 * The key itself is fetched by the joiner with accept_invite.
 */
create function public.approve_invite(invite uuid, as_person uuid default null)
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
    if not exists (select 1 from persons p where p.id = as_person and p.space_id = row.space_id) then
      raise exception 'unknown person';
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

/** The inviter refuses the claim (or withdraws the invite): it can no longer be used. */
create function public.decline_invite(invite uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  row invites%rowtype;
begin
  select * into row from invites i where i.id = invite for update;
  if not found then return; end if;
  if not is_space_member(row.space_id) then raise exception 'not allowed'; end if;
  if row.approved_at is not null then raise exception 'already approved'; end if;
  delete from invites where id = invite;
end
$$;

-- ---------------------------------------------------------------------------------
-- Accept and finish (joiner).

/**
 * For the approved joiner device: the invite envelope (the space key wrapped with the
 * invite secret) and where it now belongs. Repeatable until finish_join clears it.
 */
create function public.accept_invite(invite uuid)
returns table (envelope bytea, space_id uuid, person_id uuid, epoch integer)
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  row invites%rowtype;
begin
  select * into row from invites i where i.id = invite;
  if not found or row.joiner_device_id is distinct from device or row.envelope is null then
    raise exception 'invite unavailable';
  end if;
  if row.approved_at is null then raise exception 'not approved yet'; end if;
  return query
    select row.envelope, s.id, d.person_id, s.epoch
    from devices d join spaces s on s.id = d.space_id
    where d.id = device;
end
$$;

/**
 * The joiner stores the space key sealed to its own device and the invite envelope is
 * cleared. Repeatable: a second call changes nothing.
 */
create function public.finish_join(invite uuid, sealed_key bytea)
returns void
language plpgsql security definer set search_path = public as $$
declare
  device uuid := current_device_id();
  row invites%rowtype;
  space uuid;
  current_epoch integer;
begin
  select * into row from invites i where i.id = invite for update;
  if not found or row.joiner_device_id is distinct from device or row.approved_at is null then
    raise exception 'invite unavailable';
  end if;
  select s.id, s.epoch into space, current_epoch from spaces s where s.id = row.space_id;
  insert into key_envelopes (space_id, epoch, device_id, sealed)
    values (space, current_epoch, device, sealed_key)
    on conflict (space_id, epoch, device_id) where device_id is not null do nothing;
  update invites set envelope = null where id = invite;
end
$$;

-- ---------------------------------------------------------------------------------

revoke all on function
  public.create_space(bytea, uuid),
  public.claim_invite(uuid, uuid),
  public.invite_claim(uuid),
  public.approve_invite(uuid, uuid),
  public.decline_invite(uuid),
  public.accept_invite(uuid),
  public.finish_join(uuid, bytea)
from public;
grant execute on function
  public.create_space(bytea, uuid),
  public.claim_invite(uuid, uuid),
  public.invite_claim(uuid),
  public.approve_invite(uuid, uuid),
  public.decline_invite(uuid),
  public.accept_invite(uuid),
  public.finish_join(uuid, bytea)
to authenticated;
