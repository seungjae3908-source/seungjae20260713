-- Rollback for Phase 8 member permissions.
-- CI/test use only in this phase. Do not run against production without approval.

begin;

drop table if exists public.member_permission_audit cascade;

drop policy if exists "profiles phase8 admins update" on public.profiles;
drop policy if exists "profiles phase8 admins select" on public.profiles;
drop policy if exists "profiles phase8 select own" on public.profiles;

drop function if exists public.current_membership_level();

drop index if exists public.profiles_membership_active_idx;

alter table if exists public.profiles
  drop constraint if exists profiles_membership_level_check,
  drop column if exists permissions_updated_at,
  drop column if exists is_active,
  drop column if exists membership_level;

commit;
