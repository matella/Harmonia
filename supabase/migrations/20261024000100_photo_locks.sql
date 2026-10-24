-- Security review of slice 3 (docs/PARTNER_SYNC.md §18): a part being stored and its
-- reservation being released could interleave. release_blob() saw no part yet and deleted
-- the reservation, then the part landed anyway: stored, and counted against nothing.
-- Both now lock the reservation row: the size check of a stored part for share, the
-- release for update. Whichever comes second waits and then sees what the other did (the
-- release finds the part and refuses; a part after a release finds no reservation).

create or replace function public.photos_part_size() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  tokens text[] := string_to_array(new.name, '/');
  reserved blobs%rowtype;
  part integer;
  plain bigint;
begin
  if new.bucket_id <> 'photos' or new.metadata is null or new.metadata->>'size' is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.name = new.name
     and old.metadata->>'size' is not distinct from new.metadata->>'size' then
    return new;
  end if;
  if array_length(tokens, 1) <> 3 or tokens[3] !~ '^(0|[1-9][0-9]{0,4})$'
     or tokens[1] !~ '^[0-9a-f-]{36}$' or tokens[2] !~ '^[0-9a-f-]{36}$' then
    raise exception 'part size';
  end if;
  select * into reserved from blobs b
    where b.space_id = tokens[1]::uuid and b.id = tokens[2]::uuid
    for share;
  part := tokens[3]::integer;
  if not found or part >= reserved.parts then raise exception 'part size'; end if;
  plain := least(1048576, reserved.size - part::bigint * 1048576);
  if (new.metadata->>'size')::bigint <> plain + 17 * ((plain + 65535) / 65536) then
    raise exception 'part size';
  end if;
  return new;
end
$$;

create or replace function public.release_blob(blob uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if current_device_id() is null or space is null then raise exception 'not a member'; end if;
  -- Waits for any part of it still being stored (see above).
  perform 1 from blobs b where b.space_id = space and b.id = blob for update;
  if not found then return; end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'photos' and o.name like space::text || '/' || blob::text || '/%'
  ) then
    raise exception 'parts remain';
  end if;
  delete from blobs b where b.space_id = space and b.id = blob;
end
$$;
