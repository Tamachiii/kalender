-- Adds task completion, calendar deletion support, and email-based sharing.
-- Run this in the Supabase SQL editor for an existing Kalender project.

alter table public.events
  add column if not exists completed boolean not null default false;

alter table public.calendars
  add column if not exists archived_at timestamptz;

create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 32),
  color text not null default '#92c5fc',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

alter table public.events
  add column if not exists tag_id uuid references public.tags(id) on delete set null;

create index if not exists tags_user_id_idx on public.tags(user_id);

alter table public.tags enable row level security;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles(lower(email));

alter table public.profiles enable row level security;

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

drop trigger if exists auth_users_profile on auth.users;
create trigger auth_users_profile
after insert or update of email on auth.users
for each row execute function public.handle_new_user_profile();

insert into public.profiles(id, email)
select id, lower(email)
from auth.users
where email is not null
on conflict (id) do update set email = excluded.email;

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

create or replace function public.can_use_tag(target_tag_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select target_tag_id is null or exists (
    select 1
    from public.tags t
    where t.id = target_tag_id
      and t.user_id = auth.uid()
  );
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

drop trigger if exists tags_touch_updated_at on public.tags;
create trigger tags_touch_updated_at
before update on public.tags
for each row execute function public.touch_tag_updated_at();

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile"
on public.profiles
for select
to authenticated
using (id = auth.uid());

drop policy if exists "Users can read their tags" on public.tags;
create policy "Users can read their tags"
on public.tags
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Users can create their tags" on public.tags;
create policy "Users can create their tags"
on public.tags
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "Users can update their tags" on public.tags;
create policy "Users can update their tags"
on public.tags
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "Users can delete their tags" on public.tags;
create policy "Users can delete their tags"
on public.tags
for delete
to authenticated
using (user_id = auth.uid());

drop policy if exists "Editors can create events" on public.events;
create policy "Editors can create events"
on public.events
for insert
to authenticated
with check (public.can_edit_calendar(calendar_id) and public.can_use_tag(tag_id));

drop policy if exists "Editors can update events" on public.events;
create policy "Editors can update events"
on public.events
for update
to authenticated
using (public.can_edit_calendar(calendar_id))
with check (public.can_edit_calendar(calendar_id) and public.can_use_tag(tag_id));
