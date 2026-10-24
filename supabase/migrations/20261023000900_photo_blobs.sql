-- Partner sharing phase 5, slice 2 (docs/PARTNER_SYNC.md §18): encrypted photos.
--  * A private Storage bucket `photos`. One photo is stored as parts of at most 1 MiB of
--    plaintext (16 secretstream chunks of 64 KiB, 17 bytes of overhead each), at
--    `<space_id>/<blob_id>/<part>`. The bucket refuses any object over one part.
--  * Before uploading, a device reserves the photo's plaintext size with reserve_blob(),
--    which checks the space's limit (2 GB, one server setting). Storage accepts a part only
--    from the device that reserved the photo, in its own space, with a part number within
--    that size and exactly the encrypted size that part has. So what a member can store is
--    what was reserved, whatever the client does. Stored parts can't be overwritten (no
--    update policy).

insert into storage.buckets (id, name, public, file_size_limit)
values ('photos', 'photos', false, 16 * (65536 + 17))
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

/** The operator's settings; one row. The limit can change without an app update. */
create table public.storage_settings (
  id integer primary key default 1 check (id = 1),
  photo_bytes_per_space bigint not null check (photo_bytes_per_space > 0)
);
insert into public.storage_settings (id, photo_bytes_per_space) values (1, 2147483648);
alter table public.storage_settings enable row level security;
revoke all on public.storage_settings from anon, authenticated;

/** A reserved photo: its plaintext size and how many parts it may have. */
create table public.blobs (
  space_id uuid not null references public.spaces (id) on delete cascade,
  id uuid not null,
  size bigint not null check (size > 0 and size <= 20 * 1024 * 1024),
  parts integer not null check (parts > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (space_id, id)
);
alter table public.blobs enable row level security;
revoke all on public.blobs from anon, authenticated;

/**
 * Reserves room for a photo of `size` plaintext bytes in the caller's space. Asking again
 * for the same photo and size changes nothing (a retry); the space's total, reserved
 * photos included, may not go over the limit.
 */
create function public.reserve_blob(blob uuid, size bigint)
returns void
language plpgsql security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
  used bigint;
  limit_bytes bigint := (select s.photo_bytes_per_space from storage_settings s where s.id = 1);
  existing blobs%rowtype;
begin
  if current_device_id() is null or space is null then raise exception 'not a member'; end if;
  if size is null or size <= 0 or size > 20 * 1024 * 1024 then raise exception 'not allowed'; end if;
  -- One space's reservations are decided one at a time.
  perform 1 from spaces s where s.id = space for update;
  select * into existing from blobs b where b.space_id = space and b.id = blob;
  if found then
    if existing.size <> size then raise exception 'not allowed'; end if;
    return;
  end if;
  select coalesce(sum(b.size), 0) into used from blobs b where b.space_id = space;
  if used + size > limit_bytes then raise exception 'storage full'; end if;
  insert into blobs (space_id, id, size, parts, created_by)
    values (space, blob, size, ((size + 1048575) / 1048576)::integer, current_device_id());
end
$$;

/** What the screen shows: bytes reserved in my space, and the limit. */
create function public.space_storage()
returns table (used bigint, limit_bytes bigint)
language plpgsql stable security definer set search_path = public as $$
declare
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if space is null then raise exception 'not a member'; end if;
  return query select coalesce((select sum(b.size) from blobs b where b.space_id = space), 0)::bigint,
    (select s.photo_bytes_per_space from storage_settings s where s.id = 1);
end
$$;

/** For Storage policies: an object path in the caller's own space. */
create function public.photo_path_in_my_space(object_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (string_to_array(object_name, '/'))[1] = (select d.space_id::text from devices d where d.id = current_device_id()),
    false)
$$;

/** For the Storage insert policy: `<my space>/<blob I reserved>/<part within its size>`. */
create function public.photo_part_allowed(object_name text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  tokens text[] := string_to_array(object_name, '/');
  space uuid := (select d.space_id from devices d where d.id = current_device_id());
begin
  if space is null or array_length(tokens, 1) <> 3 then return false; end if;
  if tokens[1] <> space::text or tokens[3] !~ '^(0|[1-9][0-9]{0,4})$' then return false; end if;
  if tokens[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return exists (
    select 1 from blobs b
    where b.space_id = space and b.id = tokens[2]::uuid and b.created_by = current_device_id()
      and tokens[3]::integer < b.parts
  );
end
$$;

/**
 * The size check. Storage first checks the insert policy with a row it rolls back (no
 * size yet), uploads, then inserts the row with the file's size (both checked live). So
 * the size is checked here, on that final row: exactly what that part of the reserved
 * photo is once encrypted (each 64 KiB chunk adds 17 bytes, 16 chunks to a part).
 * Nothing beyond the reservation can then be stored.
 */
create function public.photos_part_size() returns trigger
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
revoke all on function public.photos_part_size() from public;
create trigger photos_part_size before insert or update on storage.objects
  for each row execute function public.photos_part_size();

revoke all on function public.reserve_blob(uuid, bigint), public.space_storage(),
  public.photo_path_in_my_space(text), public.photo_part_allowed(text) from public;
grant execute on function public.reserve_blob(uuid, bigint), public.space_storage(),
  public.photo_path_in_my_space(text), public.photo_part_allowed(text) to authenticated;

create policy photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and public.photo_part_allowed(name));
create policy photos_select on storage.objects for select to authenticated
  using (bucket_id = 'photos' and public.photo_path_in_my_space(name));
-- Partners are equal (§6.6): any member may delete a photo of the space (slice 3).
create policy photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and public.photo_path_in_my_space(name));
