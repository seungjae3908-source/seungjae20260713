-- Member approval, role management and immutable audit trail.
create type public.member_status as enum ('pending', 'approved', 'rejected', 'suspended', 'withdrawn');
create type public.member_role as enum ('user', 'admin');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  login_name text not null unique,
  display_name text not null,
  phone text,
  role public.member_role not null default 'user',
  status public.member_status not null default 'pending',
  approved_at timestamptz,
  approved_by uuid references auth.users(id),
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
);

create index profiles_status_created_idx on public.profiles(status, created_at desc);
create index audit_logs_created_idx on public.audit_logs(created_at desc);
create index audit_logs_actor_idx on public.audit_logs(actor_id, created_at desc);

create or replace function public.is_approved_member()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved') $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved' and role = 'admin') $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, login_name, display_name)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'login_name', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'login_name', ''), '사용자')
  );
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.audit_logs enable row level security;

create policy "members read own profile" on public.profiles for select
using (id = auth.uid());
create policy "admins read profiles" on public.profiles for select
using (public.is_admin());
create policy "admins update profiles" on public.profiles for update
using (public.is_admin()) with check (public.is_admin());
create policy "admins read audit logs" on public.audit_logs for select
using (public.is_admin());

revoke insert, update, delete on public.audit_logs from anon, authenticated;
revoke delete on public.profiles from anon, authenticated;

