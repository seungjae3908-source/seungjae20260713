-- 회원 등급 5단계: pending → associate → full → master → admin
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles alter column role set default 'pending';
alter table public.profiles add constraint profiles_role_check
  check (role in ('pending','associate','full','master','admin'));
create index if not exists profiles_role_status_idx on public.profiles(role, status, created_at desc);
