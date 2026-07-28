-- 20260722_auth_grade_upgrade.sql 롤백
-- 기존 회원 데이터는 삭제하지 않습니다. 추가된 컬럼/함수만 되돌립니다.

drop function if exists public.admin_list_member_emails();
drop function if exists public.verify_recovery_identity(text, text, text);
drop function if exists public.find_login_name_by_identity(text, text, text);

-- 트리거를 이전(AFTER INSERT 단일) 버전으로 복원
drop trigger if exists on_auth_user_scrub_birth6 on auth.users;
drop function if exists public.scrub_birth6_metadata();
drop trigger if exists on_auth_user_created on auth.users;

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

alter table public.profiles drop column if exists birth_date_6_hash;
