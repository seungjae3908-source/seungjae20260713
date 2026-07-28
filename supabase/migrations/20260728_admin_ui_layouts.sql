-- 관리자 UI 편집츰 1차 저잤이
-- 코드 배포와 별도로 Supabase는 적용핼야 서버 저잤/게/복원이 활성과니다.

create extension if not exists pgcrypto;

create table if not exists public.ui_layout_versions (
  id uuid primary key default gen_random_uuid(),
  page_key text not null
    check (page_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  version integer not null check (version > 0),
  status text not null default 'draft'
    check (status in ('draft', 'published', 'archived')),
  schema_version integer not null default 1
    check (schema_version = 1),
  layout jsonb not null,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (page_key, version)
);

create index if not exists ui_layout_versions_page_version_idx
  on public.ui_layout_versions(page_key, version desc);

create unique index if not exists ui_layout_versions_one_published_idx
  on public.ui_layout_versions(page_key)
  where status = 'published';

alter table public.ui_layout_versions enable row level security;

drop policy if exists "approved members read published ui layouts"
  on public.ui_layout_versions;
create policy "approved members read published ui layouts"
  on public.ui_layout_versions
  for select
  to authenticated
  using (
    status = 'published'
    or public.is_admin()
  );

drop policy if exists "admins insert ui layouts"
  on public.ui_layout_versions;
create policy "admins insert ui layouts"
  on public.ui_layout_versions
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists "admins update ui layouts"
  on public.ui_layout_versions;
create policy "admins update ui layouts"
  on public.ui_layout_versions
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "admins delete ui layouts"
  on public.ui_layout_versions;
create policy "admins delete ui layouts"
  on public.ui_layout_versions
  for delete
  to authenticated
  using (public.is_admin());

grant select on public.ui_layout_versions to authenticated;
grant insert, update, delete on public.ui_layout_versions to authenticated;
grant all on public.ui_layout_versions to service_role;
