-- Move tags from user-scoped to calendar-scoped, drop events.category and
-- events.color in favor of a single tag_id (color/name come from the joined
-- tags row). Idempotent and transactional: safe to re-paste into the SQL
-- editor.
--
-- Run order on an existing project:
--   1. supabase/feature_updates.sql              -- if not already applied
--   2. supabase/2026-05-add-quick-add-templates.sql -- if not already applied
--   3. supabase/2026-05-calendar-scoped-tags.sql -- this file
--   4. After verifying with two real users, optionally run
--      supabase/2026-05-calendar-scoped-tags-cleanup.sql to drop the legacy
--      user-scoped rows and add the NOT NULL / unique(calendar_id, name)
--      constraints.

begin;

------------------------------------------------------------------------------
-- 1. Schema additions on tags
------------------------------------------------------------------------------

alter table public.tags
  add column if not exists calendar_id uuid references public.calendars(id) on delete cascade;

alter table public.tags
  drop constraint if exists tags_user_id_name_key;

-- user_id stays for audit purposes only. Drop the auth.uid() default so it
-- cannot silently misattribute a tag created by a calendar owner via RPC.
alter table public.tags
  alter column user_id drop default;

create index if not exists tags_calendar_id_idx on public.tags(calendar_id);

------------------------------------------------------------------------------
-- 2. Seed standard tags for every existing calendar.
-- These match the legacy `events.category` enum so events can be remapped to
-- a real tag row in step 4. "Untagged" is the per-calendar default used when
-- a tag is deleted while in use.
------------------------------------------------------------------------------

insert into public.tags (calendar_id, user_id, name, color)
select c.id, c.owner_id, seed.name, seed.color
from public.calendars c
cross join (values
  ('Untagged', '#94a3b8'),
  ('Work',     '#3b82f6'),
  ('Personal', '#22c55e'),
  ('Urgent',   '#ef4444'),
  ('Focus',    '#a855f7'),
  ('Travel',   '#f59e0b')
) as seed(name, color)
where not exists (
  select 1 from public.tags existing
  where existing.calendar_id = c.id and existing.name = seed.name
);

------------------------------------------------------------------------------
-- 3. Copy each user-scoped custom tag into every calendar that user owns.
-- Preserve name/color/created_at. Skip name collisions with seeded tags or
-- with prior copies of this same migration.
------------------------------------------------------------------------------

insert into public.tags (calendar_id, user_id, name, color, created_at)
select c.id, t.user_id, t.name, t.color, t.created_at
from public.tags t
join public.calendars c on c.owner_id = t.user_id
where t.calendar_id is null
  and not exists (
    select 1 from public.tags existing
    where existing.calendar_id = c.id and existing.name = t.name
  );

------------------------------------------------------------------------------
-- 4. Remap events. Three cases, applied in order:
--    a) tag_id points at a legacy user-scoped tag → switch to the per-calendar
--       copy with the same name in the event's calendar.
--    b) tag_id is null and category matches a seeded tag name (case-insensitive)
--       → use that.
--    c) anything still null → Untagged of the event's calendar.
------------------------------------------------------------------------------

update public.events e
set tag_id = nt.id
from public.tags ot, public.tags nt
where e.tag_id = ot.id
  and ot.calendar_id is null
  and nt.calendar_id = e.calendar_id
  and nt.name = ot.name;

update public.events e
set tag_id = nt.id
from public.tags nt
where e.tag_id is null
  and nt.calendar_id = e.calendar_id
  and lower(nt.name) = e.category;

update public.events e
set tag_id = nt.id
from public.tags nt
where e.tag_id is null
  and nt.calendar_id = e.calendar_id
  and nt.name = 'Untagged';

------------------------------------------------------------------------------
-- 5. Trigger: seed standard tags whenever a new calendar is created.
------------------------------------------------------------------------------

create or replace function public.seed_calendar_tags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tags (calendar_id, user_id, name, color)
  values
    (new.id, new.owner_id, 'Untagged', '#94a3b8'),
    (new.id, new.owner_id, 'Work',     '#3b82f6'),
    (new.id, new.owner_id, 'Personal', '#22c55e'),
    (new.id, new.owner_id, 'Urgent',   '#ef4444'),
    (new.id, new.owner_id, 'Focus',    '#a855f7'),
    (new.id, new.owner_id, 'Travel',   '#f59e0b')
  on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists calendars_seed_tags on public.calendars;
create trigger calendars_seed_tags
after insert on public.calendars
for each row execute function public.seed_calendar_tags();

------------------------------------------------------------------------------
-- 6. Rewrite can_use_tag to require the tag to belong to the event's calendar.
-- The old single-arg signature has to go because the new policies below pass
-- both arguments, but Postgres refuses to drop the function while existing
-- policies still depend on it. Drop those policies first; step 8 recreates
-- them against the new signature.
------------------------------------------------------------------------------

drop policy if exists "Editors can create events" on public.events;
drop policy if exists "Editors can update events" on public.events;

drop function if exists public.can_use_tag(uuid);

create or replace function public.can_use_tag(target_tag_id uuid, target_calendar_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_tag_id is not null
    and target_calendar_id is not null
    and exists (
      select 1 from public.tags t
      where t.id = target_tag_id
        and t.calendar_id = target_calendar_id
    );
$$;

------------------------------------------------------------------------------
-- 7. Replace user-scoped tag policies with calendar-scoped policies.
-- SELECT: any member of the calendar.
-- INSERT/UPDATE/DELETE: owner or collaborator of the calendar (can_edit_calendar).
-- During the transition, legacy rows with calendar_id is null become invisible
-- via RLS, which is desired — the cleanup migration drops them.
------------------------------------------------------------------------------

drop policy if exists "Users can read their tags"   on public.tags;
drop policy if exists "Users can create their tags" on public.tags;
drop policy if exists "Users can update their tags" on public.tags;
drop policy if exists "Users can delete their tags" on public.tags;

drop policy if exists "Members can read tags"   on public.tags;
drop policy if exists "Editors can create tags" on public.tags;
drop policy if exists "Editors can update tags" on public.tags;
drop policy if exists "Editors can delete tags" on public.tags;

create policy "Members can read tags"
on public.tags
for select
to authenticated
using (calendar_id is not null and public.is_calendar_member(calendar_id));

create policy "Editors can create tags"
on public.tags
for insert
to authenticated
with check (
  calendar_id is not null
  and user_id = auth.uid()
  and public.can_edit_calendar(calendar_id)
);

create policy "Editors can update tags"
on public.tags
for update
to authenticated
using (calendar_id is not null and public.can_edit_calendar(calendar_id))
with check (calendar_id is not null and public.can_edit_calendar(calendar_id));

create policy "Editors can delete tags"
on public.tags
for delete
to authenticated
using (calendar_id is not null and public.can_edit_calendar(calendar_id));

------------------------------------------------------------------------------
-- 8. Update event policies to use the new can_use_tag(tag_id, calendar_id)
-- signature. Tag now must belong to the event's calendar (RLS enforces).
------------------------------------------------------------------------------

drop policy if exists "Editors can create events" on public.events;
create policy "Editors can create events"
on public.events
for insert
to authenticated
with check (
  public.can_edit_calendar(calendar_id)
  and public.can_use_tag(tag_id, calendar_id)
);

drop policy if exists "Editors can update events" on public.events;
create policy "Editors can update events"
on public.events
for update
to authenticated
using (public.can_edit_calendar(calendar_id))
with check (
  public.can_edit_calendar(calendar_id)
  and public.can_use_tag(tag_id, calendar_id)
);

------------------------------------------------------------------------------
-- 9. Drop the legacy events.category / events.color columns. tag_id is now
-- the canonical identifier; color/name are joined from tags at read time.
-- Dropping the check constraint first because the column is referenced by it.
------------------------------------------------------------------------------

alter table public.events drop constraint if exists events_category_check;
alter table public.events drop column if exists category;
alter table public.events drop column if exists color;

------------------------------------------------------------------------------
-- 10. Quick Add templates: clear default_tag values that no longer resolve.
-- Try to keep tags whose old name matches a tag in the template's
-- default_calendar_id; null out the rest. Users can re-pick from Settings.
------------------------------------------------------------------------------

-- Built-in id strings (lowercase enum values) → matching named tag in default_calendar_id
update public.quick_add_templates qt
set default_tag = (
  select t.id::text from public.tags t
  where t.calendar_id = qt.default_calendar_id
    and lower(t.name) = lower(qt.default_tag)
  limit 1
)
where qt.default_calendar_id is not null
  and qt.default_tag is not null
  and qt.default_tag in ('work', 'personal', 'urgent', 'focus', 'travel');

-- Anything still pointing at a non-existent tag id → null
update public.quick_add_templates qt
set default_tag = null
where qt.default_tag is not null
  and not exists (
    select 1 from public.tags t where t.id::text = qt.default_tag
  );

------------------------------------------------------------------------------
-- 11. Realtime: tags now propagate to collaborators.
------------------------------------------------------------------------------

do $$
begin
  alter publication supabase_realtime add table public.tags;
exception
  when duplicate_object then null;
end;
$$;

commit;
