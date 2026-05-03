-- Adds user-owned Quick Add templates. Run this in the Supabase SQL editor on
-- existing Kalender projects. Idempotent: safe to re-paste.

create table if not exists public.quick_add_templates (
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

create index if not exists quick_add_templates_user_id_idx
  on public.quick_add_templates(user_id);

alter table public.quick_add_templates enable row level security;

create or replace function public.touch_quick_add_template_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists quick_add_templates_touch_updated_at on public.quick_add_templates;
create trigger quick_add_templates_touch_updated_at
before update on public.quick_add_templates
for each row execute function public.touch_quick_add_template_updated_at();

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
