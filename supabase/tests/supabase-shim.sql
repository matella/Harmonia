-- Minimal stand-in for what Supabase provides before migrations run, so the real
-- migration and its row-level security can be exercised in PGlite (no Docker needed).
-- auth.uid() mirrors Supabase's implementation: the `sub` claim of the request's JWT.
create role anon nologin;
create role authenticated nologin;
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
