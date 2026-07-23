-- ============================================================
-- 관리자 변경 감사 로그 트리거 (idempotent, 데이터 변경 없음)
-- 목적: 서비스 역할 키 없이도 profiles의 role/status 변경이
--       반드시 audit_logs에 기록되도록 DB 차원에서 보장.
-- Supabase SQL Editor에서 전체 실행하세요.
-- ============================================================

create or replace function public.log_profile_change()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if (old.role is distinct from new.role) or (old.status is distinct from new.status) then
    insert into public.audit_logs(actor_id, action, target_type, target_id, details)
    values (
      auth.uid(),
      'member.update',
      'profile',
      new.id::text,
      jsonb_build_object(
        'old_role', old.role, 'new_role', new.role,
        'old_status', old.status, 'new_status', new.status
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_profile_admin_change on public.profiles;
create trigger on_profile_admin_change
  after update on public.profiles
  for each row execute procedure public.log_profile_change();
