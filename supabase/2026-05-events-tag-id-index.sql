-- Add a covering index on events.tag_id. After the calendar-scoped tags
-- cleanup migration, the FK is `on delete restrict`, so every tag delete
-- triggers a constraint check that scans events. The two paths that read
-- this column directly are:
--   - api.js countEventsUsingTag — `count(*) where tag_id = ?` for the
--     delete-tag confirmation modal.
--   - api.js reassignEventsTag — `update events set tag_id = ? where tag_id = ?`
--     before deleting a tag.
-- Without the index both seq-scan the events table.
--
-- Idempotent and online: `create index if not exists` does not block writes.

create index if not exists events_tag_id_idx on public.events(tag_id);
