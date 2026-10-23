-- Partner sharing phase 3, slice 2 (docs/PARTNER_SYNC.md §7.2): the verified device list.
-- Each device writes its own public keys as an end-to-end encrypted `device` record, so
-- key rotation never has to trust keys from the server's `devices` table.

alter table public.records drop constraint records_record_type_check;
alter table public.records add constraint records_record_type_check
  check (record_type in ('profile', 'person', 'milestone', 'memory', 'memory_media', 'device'));
