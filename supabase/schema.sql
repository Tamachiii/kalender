-- Kalender Supabase schema and Row Level Security policies.
-- Run this in the Supabase SQL editor after enabling Email/Password Auth.
--
-- Tags are calendar-scoped (one row per (calendar_id, name)). Every newly
-- created calendar is auto-seeded with six tags via the
-- `calendars_seed_tags` trigger: Untagged + the five legacy categories
-- (Work, Personal, Urgent, Focus, Travel). Events reference tags via the
-- mandatory `events.tag_id`; color and name are read from the joined tag
-- row (no display snapshot on the event itself).

create extension if not exists pgcrypto;

do $$
begin
  create type public.calendar_role as enum ('owner', 'collaborator', 'viewer');
exception
  when duplicate_object then null;
end;
$$;

create table public.calendars (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  color text not null default '#92c5fc' check (color ~ '^#[0-9a-fA-F]{6}$'),
  archived_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.calendar_members (
  calendar_id uuid not null references public.calendars(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.calendar_role not null default 'viewer',
  created_at timestamptz not null default now(),
  primary key (calendar_id, user_id)
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create table public.tags (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 32),
  color text not null default '#92c5fc' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_id, name)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references public.calendars(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  tag_id uuid not null references public.tags(id) on delete restrict,
  completed boolean not null default false,
  reminder_minutes integer,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (reminder_minutes is null or reminder_minutes in (5, 10, 15, 30, 60, 1440))
);

create table public.quick_add_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shortcut text not null check (char_length(shortcut) between 1 and 32),
  default_title text not null default '' check (char_length(default_title) <= 120),
  default_duration_minutes integer not null default 60
    check (default_duration_minutes between 1 and 1440),
  default_tag text,
  default_calendar_id uuid references public.calendars(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, shortcut)
);

create index calendars_owner_id_idx on public.calendars(owner_id);
create index calendar_members_user_id_idx on public.calendar_members(user_id);
create index profiles_email_idx on public.profiles(lower(email));
create index tags_calendar_id_idx on public.tags(calendar_id);
create index events_calendar_time_idx on public.events(calendar_id, starts_at, ends_at);
create index events_tag_id_idx on public.events(tag_id);
create index quick_add_templates_user_id_idx on public.quick_add_templates(user_id);

alter table public.calendars
  alter column owner_id set default auth.uid();

alter table public.calendars enable row level security;
alter table public.calendar_members enable row level security;
alter table public.profiles enable row level security;
alter table public.tags enable row level security;
alter table public.events enable row level security;
alter table public.quick_add_templates enable row level security;

create or replace function public.is_calendar_member(target_calendar_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.calendar_members cm
    where cm.calendar_id = target_calendar_id
      and cm.user_id = auth.uid()
  );
$$;

create or replace function public.can_edit_calendar(target_calendar_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.calendar_members cm
    where cm.calendar_id = target_calendar_id
      and cm.user_id = auth.uid()
      and cm.role in ('owner', 'collaborator')
  );
$$;

create or replace function public.is_calendar_owner(target_calendar_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.calendar_members cm
    where cm.calendar_id = target_calendar_id
      and cm.user_id = auth.uid()
      and cm.role = 'owner'
  );
$$;

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
      select 1
      from public.tags t
      where t.id = target_tag_id
        and t.calendar_id = target_calendar_id
    );
$$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  new.updated_by = auth.uid();
  return new;
end;
$$;

create or replace function public.touch_tag_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_quick_add_template_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.add_calendar_owner_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.calendar_members(calendar_id, user_id, role)
  values (new.id, new.owner_id, 'owner')
  on conflict (calendar_id, user_id) do update set role = 'owner';
  return new;
end;
$$;

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

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(id, email)
  values (new.id, lower(new.email))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create or replace function public.share_calendar_by_email(
  target_calendar_id uuid,
  target_email text,
  target_role public.calendar_role
)
returns public.calendar_members
language plpgsql
security definer
set search_path = public
as $$
declare
  target_user_id uuid;
  membership public.calendar_members;
begin
  if target_role = 'owner' then
    raise exception 'Cannot grant owner role through sharing';
  end if;

  if not public.is_calendar_owner(target_calendar_id) then
    raise exception 'Only calendar owners can share calendars';
  end if;

  select p.id into target_user_id
  from public.profiles p
  where p.email = lower(trim(target_email));

  if target_user_id is null then
    raise exception 'No user found for email %', target_email;
  end if;

  insert into public.calendar_members(calendar_id, user_id, role)
  values (target_calendar_id, target_user_id, target_role)
  on conflict (calendar_id, user_id) do update set role = excluded.role
  returning * into membership;

  return membership;
end;
$$;

drop trigger if exists auth_users_profile on auth.users;
create trigger auth_users_profile
after insert or update of email on auth.users
for each row execute function public.handle_new_user_profile();

insert into public.profiles(id, email)
select id, lower(email)
from auth.users
where email is not null
on conflict (id) do update set email = excluded.email;

drop trigger if exists events_touch_updated_at on public.events;
create trigger events_touch_updated_at
before update on public.events
for each row execute function public.touch_updated_at();

drop trigger if exists tags_touch_updated_at on public.tags;
create trigger tags_touch_updated_at
before update on public.tags
for each row execute function public.touch_tag_updated_at();

drop trigger if exists quick_add_templates_touch_updated_at on public.quick_add_templates;
create trigger quick_add_templates_touch_updated_at
before update on public.quick_add_templates
for each row execute function public.touch_quick_add_template_updated_at();

drop trigger if exists calendars_add_owner_member on public.calendars;
create trigger calendars_add_owner_member
after insert on public.calendars
for each row execute function public.add_calendar_owner_member();

drop trigger if exists calendars_seed_tags on public.calendars;
create trigger calendars_seed_tags
after insert on public.calendars
for each row execute function public.seed_calendar_tags();

drop policy if exists "Members can read calendars" on public.calendars;
create policy "Members can read calendars"
on public.calendars
for select
to authenticated
using (owner_id = auth.uid() or public.is_calendar_member(id));

drop policy if exists "Authenticated users can create owned calendars" on public.calendars;
create policy "Authenticated users can create owned calendars"
on public.calendars
for insert
to authenticated
with check (owner_id = auth.uid());

drop policy if exists "Owners can update calendars" on public.calendars;
create policy "Owners can update calendars"
on public.calendars
for update
to authenticated
using (owner_id = auth.uid() or public.is_calendar_owner(id))
with check (owner_id = auth.uid() or public.is_calendar_owner(id));

drop policy if exists "Owners can delete calendars" on public.calendars;
create policy "Owners can delete calendars"
on public.calendars
for delete
to authenticated
using (owner_id = auth.uid() or public.is_calendar_owner(id));

drop policy if exists "Users can read their memberships" on public.calendar_members;
create policy "Users can read their memberships"
on public.calendar_members
for select
to authenticated
using (user_id = auth.uid() or public.is_calendar_owner(calendar_id));

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "Members can read tags" on public.tags;
create policy "Members can read tags"
on public.tags
for select
to authenticated
using (public.is_calendar_member(calendar_id));

drop policy if exists "Editors can create tags" on public.tags;
create policy "Editors can create tags"
on public.tags
for insert
to authenticated
with check (
  user_id = auth.uid()
  and public.can_edit_calendar(calendar_id)
);

drop policy if exists "Editors can update tags" on public.tags;
create policy "Editors can update tags"
on public.tags
for update
to authenticated
using (public.can_edit_calendar(calendar_id))
with check (public.can_edit_calendar(calendar_id));

drop policy if exists "Editors can delete tags" on public.tags;
create policy "Editors can delete tags"
on public.tags
for delete
to authenticated
using (public.can_edit_calendar(calendar_id));

drop policy if exists "Users can read their quick add templates" on public.quick_add_templates;
create policy "Users can read their quick add templates"
on public.quick_add_templates
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can create their quick add templates" on public.quick_add_templates;
create policy "Users can create their quick add templates"
on public.quick_add_templates
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update their quick add templates" on public.quick_add_templates;
create policy "Users can update their quick add templates"
on public.quick_add_templates
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete their quick add templates" on public.quick_add_templates;
create policy "Users can delete their quick add templates"
on public.quick_add_templates
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Owners can share calendars" on public.calendar_members;
create policy "Owners can share calendars"
on public.calendar_members
for insert
to authenticated
with check (public.is_calendar_owner(calendar_id));

drop policy if exists "Owners can update memberships" on public.calendar_members;
create policy "Owners can update memberships"
on public.calendar_members
for update
to authenticated
using (public.is_calendar_owner(calendar_id))
with check (public.is_calendar_owner(calendar_id));

drop policy if exists "Owners can remove memberships" on public.calendar_members;
create policy "Owners can remove memberships"
on public.calendar_members
for delete
to authenticated
using (public.is_calendar_owner(calendar_id));

drop policy if exists "Members can read events" on public.events;
create policy "Members can read events"
on public.events
for select
to authenticated
using (public.is_calendar_member(calendar_id));

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

drop policy if exists "Editors can delete events" on public.events;
create policy "Editors can delete events"
on public.events
for delete
to authenticated
using (public.can_edit_calendar(calendar_id));

do $$
begin
  alter publication supabase_realtime add table public.events;
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.tags;
exception
  when duplicate_object then null;
end;
$$;
