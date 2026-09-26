create extension if not exists pgcrypto;

create table if not exists public.app_backups (
  member_id uuid primary key references public.profiles(id) on delete cascade,
  schema_version integer not null default 1 check (schema_version between 1 and 20),
  payload jsonb not null default '{}'::jsonb,
  item_count integer not null default 0 check (item_count between 0 and 500),
  checksum text not null,
  client_updated_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.app_backups enable row level security;

drop policy if exists app_backups_own on public.app_backups;
create policy app_backups_own
  on public.app_backups
  for all
  using (auth.uid() = member_id)
  with check (auth.uid() = member_id);
