-- A record version far ahead of the server's clock comes from a broken or hostile clock.
-- Accepting it would make devices stop pulling at it (they wait for their own clocks to
-- catch up) and would let it beat every normal edit. Such writes are skipped silently,
-- like stale ones, so one bad row never fails a whole upload (docs/PARTNER_SYNC.md §17).

/** True when the HLC's wall time is more than a day ahead of the server's clock. */
create function public.records_version_too_far_ahead(version text) returns boolean
language sql stable as $$
  select split_part(version, '-', 1)::bigint > (extract(epoch from now()) * 1000)::bigint + 86400000
$$;

create or replace function public.records_assign_seq() returns trigger
language plpgsql as $$
begin
  if public.records_version_too_far_ahead(new.version) then
    return null; -- skip this write
  end if;
  perform pg_advisory_xact_lock(hashtextextended('harmonia.records:' || new.space_id::text, 0));
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;

create or replace function public.records_keep_newest() returns trigger
language plpgsql as $$
begin
  if new.space_id <> old.space_id or new.record_type <> old.record_type or new.record_id <> old.record_id then
    raise exception 'record identity is immutable';
  end if;
  if new.version <= old.version or public.records_version_too_far_ahead(new.version) then
    return null; -- skip this write
  end if;
  perform pg_advisory_xact_lock(hashtextextended('harmonia.records:' || new.space_id::text, 0));
  new.seq := nextval(pg_get_serial_sequence('public.records', 'seq'));
  return new;
end
$$;
