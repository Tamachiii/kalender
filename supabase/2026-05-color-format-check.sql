-- Lock down `tags.color` and `calendars.color` to a strict 6-digit hex form.
-- Without this, a collaborator with insert/update access on a shared
-- calendar can write any string into `tags.color`. The frontend interpolates
-- color values directly into HTML `style` attributes (defense-in-depth
-- escaping is also being added on the client), so an unrestricted string
-- becomes a stored XSS vector for every other member of the calendar.
--
-- Idempotent: drops the constraint if it already exists, then re-adds it.
-- Safe to re-paste into the SQL editor.
--
-- This also rewrites any existing rows whose color is not in the strict
-- form to the per-table default, otherwise the ALTER TABLE would fail on
-- legacy data.

begin;

update public.tags
set color = '#94a3b8'
where color !~ '^#[0-9a-fA-F]{6}$';

update public.calendars
set color = '#92c5fc'
where color !~ '^#[0-9a-fA-F]{6}$';

alter table public.tags drop constraint if exists tags_color_format_check;
alter table public.tags
  add constraint tags_color_format_check
  check (color ~ '^#[0-9a-fA-F]{6}$');

alter table public.calendars drop constraint if exists calendars_color_format_check;
alter table public.calendars
  add constraint calendars_color_format_check
  check (color ~ '^#[0-9a-fA-F]{6}$');

commit;
