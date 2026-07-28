-- 계정 찾기 요청 저장. 아이디·비밀번호를 화면에서 직접 노출하지 않고 관리자 확인 방식으로 처리합니다.
create table if not exists public.account_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  request_type text not null check (request_type in ('login_name', 'password')),
  login_name text,
  display_name text not null,
  note text,
  status text not null default 'pending' check (status in ('pending', 'resolved', 'rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists account_recovery_requests_status_created_idx
  on public.account_recovery_requests (status, created_at desc);

alter table public.account_recovery_requests enable row level security;

drop policy if exists "anyone can create recovery request" on public.account_recovery_requests;
create policy "anyone can create recovery request"
  on public.account_recovery_requests for insert
  to anon, authenticated
  with check (status = 'pending');

drop policy if exists "admins read recovery requests" on public.account_recovery_requests;
create policy "admins read recovery requests"
  on public.account_recovery_requests for select
  to authenticated
  using (public.is_admin());

drop policy if exists "admins update recovery requests" on public.account_recovery_requests;
create policy "admins update recovery requests"
  on public.account_recovery_requests for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());
