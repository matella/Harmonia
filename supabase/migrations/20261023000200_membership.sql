-- Partner sharing phase 3, slice 1 (docs/PARTNER_SYNC.md §6.5, §17): leaving.
-- After a space is dissolved, row-level security simply returns nothing to the other
-- devices, which would look "up to date" forever. Each sync therefore first asks where
-- the calling device belongs.

/**
 * The calling user's device and its place: space, person and the space's current epoch
 * (null when the device belongs to no space), and whether it was revoked. No row when the
 * calling user has no device at all.
 */
create function public.membership()
returns table (device_id uuid, revoked boolean, space_id uuid, person_id uuid, epoch integer)
language sql stable security definer set search_path = public as $$
  select d.id, d.revoked_at is not null, d.space_id, d.person_id, s.epoch
  from devices d left join spaces s on s.id = d.space_id
  where d.auth_user_id = auth.uid()
$$;

revoke all on function public.membership() from public;
grant execute on function public.membership() to authenticated;

-- Dissolving left devices with a stale person_id: deleting the space clears
-- devices.space_id first, so the (space_id, person_id) reference no longer matched the
-- deleted persons. Clear both explicitly, then delete the space.
create or replace function public.dissolve_space() returns void
language plpgsql security definer set search_path = public as $$
declare
  target uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if target is null then raise exception 'not a member'; end if;
  update devices set space_id = null, person_id = null where space_id = target;
  delete from spaces where id = target; -- cascades to persons, envelopes, records, invites
end
$$;
