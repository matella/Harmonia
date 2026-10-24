-- Security review of partner sharing (docs/PARTNER_SYNC.md §19).
--  * Person rows: members could insert, change or delete them directly (the "narrow it
--    when touching it next" of §11). Deleting one cascades, so a partner could have wiped
--    my recovery key's entry by deleting my person row. Nothing needs direct writes: the
--    functions that create persons run as the owner. Members may now only read them.
--  * The not-signed-in role: Supabase grants it every table and function by default, and
--    the migrations only revoked `public`. Every function refuses a caller that isn't a
--    registered device and no policy lets it read a row, so nothing was open, but nothing
--    should rest on that. It now has no privileges here, now or for objects made later.

drop policy persons_member_all on public.persons;
create policy persons_member_read on public.persons for select to authenticated
  using (public.is_space_member(space_id));

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;

-- Postgres also grants every new function to PUBLIC (which the signed-out role inherits),
-- separately from Supabase's own grants; those stay only where the app needs them.
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

-- An internal helper that trusts its `space` and `caller` arguments was callable by any
-- signed-in device: my earlier migration revoked it only from PUBLIC, while Supabase also
-- grants signed-in users directly. Anyone knowing a space's and a person's IDs (an
-- ex-member, a removed device) could have filled that person's recovery envelope slots
-- with junk, so the real envelopes for those epochs would be skipped and recovery break.
revoke execute on function public.store_recovery_envelopes(uuid, uuid, jsonb, integer, integer, uuid)
  from authenticated, anon, public;
