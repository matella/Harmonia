-- Security review fix: the change cursor and a record's identity belong to the server.
-- Without this, a member could insert a record with a low `seq` so the other devices'
-- incremental pulls (`seq > cursor`) skip it, or move a record by updating its key.

create function public.records_assign_seq() returns trigger
language plpgsql as $$
begin
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;
create trigger records_assign_seq before insert on public.records
  for each row execute function public.records_assign_seq();

-- Replaces the update trigger: newest version wins, key columns are immutable, and the
-- cursor is always reassigned by the server.
create or replace function public.records_keep_newest() returns trigger
language plpgsql as $$
begin
  if new.space_id <> old.space_id or new.record_type <> old.record_type or new.record_id <> old.record_id then
    raise exception 'record identity is immutable';
  end if;
  if new.version <= old.version then
    return null; -- skip this update
  end if;
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;

revoke all on function public.records_assign_seq() from public;
