-- Security review of the resumable removal: rotate() said "unknown device" both when the
-- device to remove was no longer in the space (the removal is done: clear it) and when an
-- envelope's recipient was (the sealing device's list was out of date: retry). Distinct
-- messages let the device tell the two apart.

create or replace function public.rotate(target uuid, expected_epoch integer, envelopes jsonb)
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
    raise exception 'target not in space';
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
      raise exception 'unknown recipient';
    end if;
    insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values (space, next_epoch, (item->>'device_id')::uuid, decode(item->>'sealed', 'base64'),
              decode(item->>'signature', 'base64'), caller);
  end loop;
  return next_epoch;
end
$$;
