-- ============================================================
-- profiles RLS 무한 재귀(42P17) 수정 패치 (idempotent, 데이터 변경 없음)
-- 원인: profiles 정책이 profiles를 다시 조회 → 무한 재귀
-- 해결: security definer 함수 is_admin() 사용 (RLS 우회 조회라 재귀 없음)
-- Supabase SQL Editor에서 전체 실행하세요.
-- ============================================================

-- is_admin / is_approved_member 재정의 (기존과 동일, 안전하게 재실행)
create or replace function public.is_approved_member()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved') $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'approved' and role = 'admin') $$;

-- 재귀를 유발하던 profiles 정책 교체
drop policy if exists "admins read profiles" on public.profiles;
create policy "admins read profiles" on public.profiles
  for select using (public.is_admin());

drop policy if exists "admins update profiles" on public.profiles;
create policy "admins update profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- audit_logs의 동일 패턴도 함수 기반으로 교체
drop policy if exists "admins read audit logs" on public.audit_logs;
create policy "admins read audit logs" on public.audit_logs
  for select using (public.is_admin());

-- 보안 강화: 승인된 회원만 가격 알림/백업/알림설정/푸시 사용 가능하도록 조건 추가
drop policy if exists price_alerts_own on public.price_alerts;
create policy price_alerts_own on public.price_alerts
  for all using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists app_backups_own on public.app_backups;
create policy app_backups_own on public.app_backups
  for all using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists notification_preferences_own on public.notification_preferences;
create policy notification_preferences_own on public.notification_preferences
  for all using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

drop policy if exists push_subscriptions_own on public.push_subscriptions;
create policy push_subscriptions_own on public.push_subscriptions
  for all using (auth.uid() = member_id and public.is_approved_member())
  with check (auth.uid() = member_id and public.is_approved_member());

-- 확인:
-- select login_name, role, status from public.profiles order by created_at;
