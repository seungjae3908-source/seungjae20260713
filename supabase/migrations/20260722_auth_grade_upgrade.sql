-- 1차 인증·회원등급 정비: 생년월일 6자리(해시) + 계정찾기 함수 + 관리자 이메일 조회
-- 기존 회원 데이터는 변경하지 않습니다. (추가 컬럼/함수만 생성)
-- 롤백: supabase/migrations/rollback/20260722_auth_grade_upgrade_rollback.sql

create extension if not exists pgcrypto;

-- 1) 생년월일 6자리는 해시로만 저장 (원문 저장 금지)
alter table public.profiles
  add column if not exists birth_date_6_hash text;

-- 2) 신규 가입 트리거 2단계:
--    (a) BEFORE: 생년월일 원문을 즉시 해시로 바꿔 메타데이터에서 원문 제거 (개인정보 보호)
--    (b) AFTER: profiles 행 생성 (auth.users 행이 확정된 뒤라 FK 안전)
drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_scrub_birth6 on auth.users;

create or replace function public.scrub_birth6_metadata()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  birth6 text;
begin
  birth6 := nullif(new.raw_user_meta_data->>'birth_date_6', '');
  if birth6 is not null then
    new.raw_user_meta_data := new.raw_user_meta_data - 'birth_date_6';
    if birth6 ~ '^[0-9]{6}$' then
      -- 사용자 id를 소금으로 쓴 해시만 남긴다 (원문 복원 불가)
      new.raw_user_meta_data := new.raw_user_meta_data
        || jsonb_build_object('birth_date_6_hash', encode(digest(new.id::text || ':' || birth6, 'sha256'), 'hex'));
    end if;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_scrub_birth6 before insert on auth.users
for each row execute procedure public.scrub_birth6_metadata();

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, login_name, display_name, birth_date_6_hash)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'login_name', ''), split_part(new.email, '@', 1)),
    coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'login_name', ''), '사용자'),
    nullif(new.raw_user_meta_data->>'birth_date_6_hash', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- 3) 아이디 찾기: 이름+이메일+생년월일 일치 시 login_name 반환 (service_role 전용)
create or replace function public.find_login_name_by_identity(
  p_email text,
  p_name text,
  p_birth6 text
) returns text
language sql stable security definer set search_path = public
as $$
  select p.login_name
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(u.email) = lower(trim(p_email))
    and (
      p.display_name = trim(p_name)
      or p.login_name = lower(trim(p_name))
    )
    and p.birth_date_6_hash is not null
    and p.birth_date_6_hash = encode(digest(p.id::text || ':' || p_birth6, 'sha256'), 'hex')
  limit 1
$$;

-- 4) 비밀번호 찾기 본인확인: 아이디/이메일+이름(+생년월일) 일치 시 이메일 반환.
--    생년월일이 등록되지 않은 기존 회원은 생년월일 검증 없이 이름+아이디/이메일로 확인 가능.
create or replace function public.verify_recovery_identity(
  p_identifier text,
  p_name text,
  p_birth6 text
) returns text
language sql stable security definer set search_path = public
as $$
  select u.email
  from public.profiles p
  join auth.users u on u.id = p.id
  where (
      lower(u.email) = lower(trim(p_identifier))
      or p.login_name = lower(trim(p_identifier))
    )
    and (
      p.display_name = trim(p_name)
      or p.login_name = lower(trim(p_name))
    )
    and (
      p.birth_date_6_hash is null
      or p.birth_date_6_hash = encode(digest(p.id::text || ':' || p_birth6, 'sha256'), 'hex')
    )
  limit 1
$$;

-- 5) 관리자 회원관리: 이메일 목록(마스킹은 서버에서 수행)
create or replace function public.admin_list_member_emails()
returns table(id uuid, email text)
language sql stable security definer set search_path = public
as $$
  select u.id, u.email::text
  from auth.users u
  where public.is_admin()
$$;

-- 계정찾기 함수는 브라우저(anon/authenticated)에서 직접 호출 금지 — 서버 전용
revoke execute on function public.find_login_name_by_identity(text, text, text) from public, anon, authenticated;
revoke execute on function public.verify_recovery_identity(text, text, text) from public, anon, authenticated;
grant execute on function public.find_login_name_by_identity(text, text, text) to service_role;
grant execute on function public.verify_recovery_identity(text, text, text) to service_role;
grant execute on function public.admin_list_member_emails() to authenticated, service_role;
