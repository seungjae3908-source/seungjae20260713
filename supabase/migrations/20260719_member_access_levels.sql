
begin;

-- 기존 enum 컬럼을 text로 안전하게 변환하여 새 역할을 바로 사용할 수 있게 합니다.
alter table public.profiles
  alter column role drop default;

alter table public.profiles
  alter column role type text
  using role::text;

update public.profiles
set role = 'full', updated_at = now()
where role = 'user';

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('associate', 'full', 'admin'));

alter table public.profiles
  alter column role set default 'associate';

create index if not exists profiles_role_status_idx
  on public.profiles(role, status, created_at desc);

-- 신규 가입자는 승인대기 + 준회원 역할로 생성됩니다.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles(
    id,
    login_name,
    display_name,
    role,
    status
  )
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'login_name', ''),
      split_part(new.email, '@', 1)
    ),
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(new.raw_user_meta_data->>'login_name', ''),
      '사용자'
    ),
    'associate',
    'pending'
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.profiles
    where id = auth.uid()
      and status = 'approved'
      and role = 'admin'
  )
$$;

create or replace function public.is_full_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1
    from public.profiles
    where id = auth.uid()
      and status = 'approved'
      and role in ('full', 'admin')
  )
$$;

commit;

-- 등급 변경을 로그인 중인 회원 화면에 실시간 반영합니다.
do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception
  when duplicate_object then null;
end
$$;