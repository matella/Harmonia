-- "Thinking of you" (docs/PARTNER_SYNC.md §22): one tiny end-to-end encrypted record per
-- person, overwritten on every send. The server sees a record of type `nudge` and when it
-- was written, nothing else (the same as for any record).
--  * a nudge is keyed by the sender's person ID, and may be written only by a device of
--    that person (like `recovery`): nobody can send one in a partner's name;
--  * at most 30 sends an hour per device, on top of the general record limit.
-- Like other refused writes, a write for someone else's key is skipped silently.

alter table public.records drop constraint records_record_type_check;
alter table public.records add constraint records_record_type_check
  check (record_type in ('profile', 'person', 'milestone', 'memory', 'memory_media', 'device',
                         'recovery', 'purge', 'nudge'));

create function public.records_nudge() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  stored boolean;
begin
  if new.record_type <> 'nudge' then return new; end if;
  if new.record_id is distinct from (
    select d.person_id from devices d where d.id = current_device_id() and d.space_id = new.space_id
  ) then
    return null; -- skip this write
  end if;
  -- A push is an upsert: the insert trigger also runs when it turns into an update of the
  -- stored row, so the send is counted once, by the update trigger, in that case.
  stored := tg_op = 'INSERT' and exists (
    select 1 from records r
    where r.space_id = new.space_id and r.record_type = 'nudge' and r.record_id = new.record_id
  );
  if not stored then perform take_rate('nudge', 30, 3600); end if;
  return new;
end
$$;
revoke all on function public.records_nudge() from public;

create trigger records_a_nudge before insert or update on public.records
  for each row execute function public.records_nudge();
