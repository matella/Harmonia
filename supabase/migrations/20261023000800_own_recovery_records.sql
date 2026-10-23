-- Security review of phase 4: a person's `recovery` record (their recovery public key,
-- end to end encrypted) may be written only by a device of that person. Otherwise another
-- member could put a public key of their own in it: rotations would then seal to a key the
-- server refuses, and that person's recovery would quietly stop covering new epochs.
-- Like other refused writes, such a write is skipped silently.

create function public.records_own_recovery() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.record_type = 'recovery' and new.record_id is distinct from (
    select d.person_id from devices d where d.id = current_device_id() and d.space_id = new.space_id
  ) then
    return null; -- skip this write
  end if;
  return new;
end
$$;
revoke all on function public.records_own_recovery() from public;

-- Before-triggers run in name order; a skipped write stops at the first one that skips.
create trigger records_a_own_recovery before insert or update on public.records
  for each row execute function public.records_own_recovery();
