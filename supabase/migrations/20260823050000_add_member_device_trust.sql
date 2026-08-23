-- Device trust is server-authoritative. Browser clients never receive direct
-- table privileges; the API stores public keys and hashes only.
create table if not exists public.member_trusted_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  public_key_jwk jsonb not null,
  key_fingerprint text not null,
  label text not null default '등록 기기',
  platform text not null default 'web',
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  last_verified_at timestamptz,
  revoked_at timestamptz,
  constraint member_trusted_devices_public_key_shape check (
    jsonb_typeof(public_key_jwk) = 'object'
    and public_key_jwk ->> 'kty' = 'EC'
    and public_key_jwk ->> 'crv' = 'P-256'
    and coalesce(public_key_jwk ->> 'x', '') <> ''
    and coalesce(public_key_jwk ->> 'y', '') <> ''
    and not (public_key_jwk ? 'd')
  ),
  constraint member_trusted_devices_fingerprint_shape check (key_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint member_trusted_devices_label_length check (char_length(label) between 1 and 80),
  constraint member_trusted_devices_platform_length check (char_length(platform) between 1 and 32)
);

create unique index if not exists member_trusted_devices_live_fingerprint_uq
  on public.member_trusted_devices(user_id, key_fingerprint)
  where status <> 'revoked';
-- Serialize enrollment per member. This database invariant prevents two
-- simultaneous first-device or paired-device requests from both reserving a
-- pending device and bypassing the configured active-device limit.
create unique index if not exists member_trusted_devices_one_pending_uq
  on public.member_trusted_devices(user_id)
  where status = 'pending';
create index if not exists member_trusted_devices_user_status_idx
  on public.member_trusted_devices(user_id, status, created_at desc);

create table if not exists public.member_device_challenges (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.member_trusted_devices(id) on delete cascade,
  purpose text not null check (purpose in ('enroll', 'verify')),
  challenge_hash text not null check (challenge_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_device_challenges_expiry check (expires_at > created_at)
);
create index if not exists member_device_challenges_user_device_idx
  on public.member_device_challenges(user_id, device_id, created_at desc);
create index if not exists member_device_challenges_expiry_idx
  on public.member_device_challenges(expires_at) where used_at is null;

create table if not exists public.member_device_pairing_tokens (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_by_device_id uuid not null references public.member_trusted_devices(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_device_pairing_tokens_expiry check (expires_at > created_at)
);
create index if not exists member_device_pairing_tokens_user_expiry_idx
  on public.member_device_pairing_tokens(user_id, expires_at) where used_at is null;

-- A pairing token must not remain usable after the trusted device that issued
-- it has been revoked. The API already checks device-session validity when the
-- token is created; this trigger also protects the later consume operation.
create or replace function public.require_active_member_device_pairing_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.used_at is not null and old.used_at is null then
    if not exists (
      select 1
      from public.member_trusted_devices d
      where d.id = new.created_by_device_id
        and d.user_id = new.user_id
        and d.status = 'active'
    ) then
      raise exception 'PAIRING_CREATOR_NOT_ACTIVE' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists member_device_pairing_creator_active on public.member_device_pairing_tokens;
create trigger member_device_pairing_creator_active
before update of used_at on public.member_device_pairing_tokens
for each row execute function public.require_active_member_device_pairing_creator();

create table if not exists public.member_device_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.member_trusted_devices(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint member_device_sessions_expiry check (expires_at > created_at)
);
create index if not exists member_device_sessions_user_device_idx
  on public.member_device_sessions(user_id, device_id, expires_at desc)
  where revoked_at is null;
create index if not exists member_device_sessions_expiry_idx
  on public.member_device_sessions(expires_at) where revoked_at is null;

alter table public.member_trusted_devices enable row level security;
alter table public.member_device_challenges enable row level security;
alter table public.member_device_pairing_tokens enable row level security;
alter table public.member_device_sessions enable row level security;

-- No authenticated-client policies are intentionally created. Device trust is
-- written and read only by the server using its secret/service credential after
-- the normal Supabase bearer session has been independently authenticated.
revoke all privileges on table public.member_trusted_devices from anon, authenticated;
revoke all privileges on table public.member_device_challenges from anon, authenticated;
revoke all privileges on table public.member_device_pairing_tokens from anon, authenticated;
revoke all privileges on table public.member_device_sessions from anon, authenticated;
