-- Fix calendar creation RLS for an existing Kalender Supabase project.
-- Run this once in the Supabase SQL editor if creating a calendar fails with:
-- "new row violates row-level security policy for table \"calendars\"".

alter table public.calendars
  alter column owner_id set default auth.uid();

alter table public.calendars enable row level security;
alter table public.calendar_members enable row level security;
alter table public.events enable row level security;

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

drop trigger if exists calendars_add_owner_member on public.calendars;
create trigger calendars_add_owner_member
after insert on public.calendars
for each row execute function public.add_calendar_owner_member();

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
