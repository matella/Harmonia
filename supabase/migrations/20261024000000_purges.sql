-- Partner sharing phase 5, slice 3 (docs/PARTNER_SYNC.md §18): deleting for good.
--  * A `purge` record: content-free, keyed by the ID of a date, memory or photo deleted
--    for good. Writing it deletes that item's records from the server, and later writes
--    to that ID are skipped: deleting for good is final. Only those three types: record
--    IDs are shared across types (a person's recovery record has the person's ID, device
--    records carry removals), and the server can't see which type a purge meant.
--  * release_blob(): frees a photo's reservation, only once none of its parts remain.
--  * For the operator: what a crash left behind (photos of spaces that are gone, or not
--    reserved any more, and reservations never uploaded), cleaned by
--    scripts/cleanup-photo-storage.mjs with the service role.

alter table public.records drop constraint records_record_type_check;
alter table public.records add constraint records_record_type_check
  check (record_type in ('profile', 'person', 'milestone', 'memory', 'memory_media', 'device',
                         'recovery', 'purge'));

/** Skips writes to an item that was deleted for good (and keeps the purge record itself). */
create function public.records_purged() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.record_type in ('milestone', 'memory', 'memory_media') and exists (
    select 1 from records r
    where r.space_id = new.space_id and r.record_type = 'purge' and r.record_id = new.record_id
  ) then
    return null; -- skip this write
  end if;
  return new;
end
$$;
revoke all on function public.records_purged() from public;
create trigger records_a_purged before insert or update on public.records
  for each row execute function public.records_purged();

/** A purge record deletes the item's records (only dates, memories and photos). */
create function public.records_purge_targets() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.record_type = 'purge' then
    delete from records r
    where r.space_id = new.space_id and r.record_id = new.record_id
      and r.record_type in ('milestone', 'memory', 'memory_media');
  end if;
  return null;
end
$$;
revoke all on function public.records_purge_targets() from public;
create trigger records_purge_targets after insert or update on public.records
  for each row execute function public.records_purge_targets();

/**
 * Frees a photo's reservation in my space. Refused while any of its parts are still in
 * Storage: they would then count for nothing against the limit.
 */
create function public.release_blob(blob uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if current_device_id() is null or space is null then raise exception 'not a member'; end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'photos' and o.name like space::text || '/' || blob::text || '/%'
  ) then
    raise exception 'parts remain';
  end if;
  delete from blobs b where b.space_id = space and b.id = blob;
end
$$;
revoke all on function public.release_blob(uuid) from public;
grant execute on function public.release_blob(uuid) to authenticated;

-- The size check of slice 2 also ran on updates Storage makes to an object's other
-- columns; it now looks only at rows whose size is new.
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
  select * into reserved from blobs b where b.space_id = tokens[1]::uuid and b.id = tokens[2]::uuid;
  part := tokens[3]::integer;
  if not found or part >= reserved.parts then raise exception 'part size'; end if;
  plain := least(1048576, reserved.size - part::bigint * 1048576);
  if (new.metadata->>'size')::bigint <> plain + 17 * ((plain + 65535) / 65536) then
    raise exception 'part size';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------
-- For the operator (service role only)

/**
 * Photo parts nothing accounts for any more: their space is gone (left while the app
 * couldn't finish deleting its photos) or their reservation was released. Only parts
 * older than `older_than`, so an upload in progress is never touched.
 */
create function public.orphan_photo_parts(older_than interval default interval '1 hour')
returns table (name text)
language sql stable security definer set search_path = public as $$
  select o.name from storage.objects o
  where o.bucket_id = 'photos' and o.created_at < now() - older_than
    and not exists (
      select 1 from blobs b
      where b.space_id::text = split_part(o.name, '/', 1) and b.id::text = split_part(o.name, '/', 2)
    )
  order by o.name
$$;

/** Releases reservations that never got a part, older than `older_than`. Returns how many. */
create function public.release_stale_reservations(older_than interval default interval '1 day')
returns integer
language plpgsql security definer set search_path = public as $$
declare
  released integer;
begin
  delete from blobs b
  where b.created_at < now() - older_than
    and not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'photos' and o.name like b.space_id::text || '/' || b.id::text || '/%'
    );
  get diagnostics released = row_count;
  return released;
end
$$;

revoke all on function public.orphan_photo_parts(interval), public.release_stale_reservations(interval)
  from public, anon, authenticated;
grant execute on function public.orphan_photo_parts(interval), public.release_stale_reservations(interval)
  to service_role;
