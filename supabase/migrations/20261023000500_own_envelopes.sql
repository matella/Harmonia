-- A device that joins after a rotation receives every epoch's key in the invite bundle
-- (docs/PARTNER_SYNC.md §7.5) and files its own envelope for each older epoch. PostgREST
-- can't name the partial unique index for "do nothing on conflict", so it goes through
-- this function; a retry after a crash then changes nothing.

/** Files the caller's own envelopes ({epoch, sealed, signature}, base64) for epochs 1..current. */
create function public.store_own_envelopes(envelopes jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := current_device_id();
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
  current_epoch integer := (select s.epoch from spaces s where s.id = (select d.space_id from devices d where d.id = current_device_id()));
  item jsonb;
begin
  if caller is null or space is null then raise exception 'not a member'; end if;
  for item in select * from jsonb_array_elements(coalesce(envelopes, '[]'::jsonb)) loop
    if (item->>'epoch')::integer < 1 or (item->>'epoch')::integer > current_epoch then
      raise exception 'epoch changed';
    end if;
    insert into key_envelopes (space_id, epoch, device_id, sealed, signature, signer_device_id)
      values (space, (item->>'epoch')::integer, caller, decode(item->>'sealed', 'base64'),
              decode(item->>'signature', 'base64'), caller)
      on conflict (space_id, epoch, device_id) where device_id is not null do nothing;
  end loop;
end
$$;

revoke all on function public.store_own_envelopes(jsonb) from public;
grant execute on function public.store_own_envelopes(jsonb) to authenticated;
