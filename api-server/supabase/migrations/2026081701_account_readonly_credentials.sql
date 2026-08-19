-- User-scoped account READ-ONLY credential storage.
-- This table is deliberately isolated from trade_exchange_connections so Toss
-- account access does not become an execution-capable TradingExchange.
begin;

create table if not exists public.account_readonly_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('toss', 'upbit', 'bitget')),
  configured boolean not null default false,
  encrypted_credentials text,
  last_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  check ((configured = false and encrypted_credentials is null)
    or (configured = true and encrypted_credentials is not null))
);

create index if not exists account_readonly_credentials_user_updated_idx
  on public.account_readonly_credentials(user_id, updated_at desc);

alter table public.account_readonly_credentials enable row level security;

-- Credential ciphertext is server-only. The API performs authenticated owner
-- checks before using the service credential; browsers cannot select or mutate
-- this table directly, even when RLS would otherwise identify the same user.
revoke all on public.account_readonly_credentials from public, anon, authenticated;

-- Preserve already stored Upbit/Bitget READ-ONLY-compatible vault ciphertext
-- without copying Kiwoom. The ciphertext format/master key stays unchanged.
insert into public.account_readonly_credentials(
  user_id, provider, configured, encrypted_credentials,
  last_verified_at, last_error_code, created_at, updated_at
)
select
  user_id, exchange, configured, encrypted_credentials,
  last_verified_at, last_error_code, created_at, updated_at
from public.trade_exchange_connections
where exchange in ('upbit', 'bitget')
  and configured = true
  and encrypted_credentials is not null
on conflict (user_id, provider) do nothing;

commit;
