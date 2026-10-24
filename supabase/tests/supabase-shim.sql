-- Minimal stand-in for what Supabase provides before migrations run, so the real
-- migration and its row-level security can be exercised in PGlite (no Docker needed).
-- auth.uid() mirrors Supabase's implementation: the `sub` claim of the request's JWT.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;
-- Supabase grants table privileges to these roles by default; RLS is what restricts them.
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
-- Supabase Storage keeps one row per object in storage.objects, under row-level security;
-- only the columns the migrations use are here. The service itself (file size limits,
-- the bytes) is exercised in the live tests.
create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  -- Storage sets the file's size here before the row is inserted.
  metadata jsonb,
  created_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated;
grant select, insert, delete on storage.objects to authenticated;
