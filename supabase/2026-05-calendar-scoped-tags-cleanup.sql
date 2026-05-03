-- Follow-up to 2026-05-calendar-scoped-tags.sql.
-- Run only after verifying that the new calendar-scoped tag flow works for
-- every existing calendar and that no events still reference legacy
-- user-scoped tags.
--
-- This migration is destructive: it deletes the legacy user-scoped tag rows
-- (tags.calendar_id is null) and adds the constraints that were deferred so
-- the main migration could be retried safely.

begin;

-- 1. Verify there are no events still referencing legacy rows. If this fails,
--    the main migration's remap step did not run on this dataset; STOP and
--    re-run 2026-05-calendar-scoped-tags.sql before retrying this cleanup.
do $$
declare
  orphan_count integer;
begin
  select count(*) into orphan_count
  from public.events e
  join public.tags t on t.id = e.tag_id
  where t.calendar_id is null;

  if orphan_count > 0 then
    raise exception
      'Aborting cleanup: % events still reference legacy user-scoped tags. Re-run 2026-05-calendar-scoped-tags.sql first.',
      orphan_count;
  end if;
end;
$$;

-- 2. Delete the legacy user-scoped rows. They are now invisible to RLS and
--    not referenced by any event.
delete from public.tags where calendar_id is null;

-- 3. Now that no nulls remain, lock the column down.
alter table public.tags alter column calendar_id set not null;

-- 4. Tag names are unique per calendar (the seed trigger and the UI both
--    assume this). Use a regular unique constraint now that calendar_id is
--    NOT NULL.
alter table public.tags
  drop constraint if exists tags_calendar_id_name_key;
alter table public.tags
  add constraint tags_calendar_id_name_key unique (calendar_id, name);

-- 5. Tag is now mandatory on every event. Make tag_id NOT NULL.
alter table public.events alter column tag_id set not null;

-- 6. Strengthen the FK so a tag cannot be deleted while events still
--    reference it. The frontend reassigns events to "Untagged" before
--    deleting; this is the database-level safety net.
alter table public.events
  drop constraint if exists events_tag_id_fkey;
alter table public.events
  add constraint events_tag_id_fkey
  foreign key (tag_id) references public.tags(id) on delete restrict;

-- 7. Drop the old index whose predicate referenced the deleted nullable rows.
drop index if exists tags_user_id_idx;

commit;
