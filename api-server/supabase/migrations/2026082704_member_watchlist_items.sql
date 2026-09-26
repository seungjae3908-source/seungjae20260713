begin;

create table if not exists public.member_watchlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  market text not null check (market in ('KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES', 'UNRESOLVED')),
  symbol text not null check (char_length(trim(symbol)) between 1 and 64),
  name text,
  currency text,
  target_price numeric check (target_price is null or target_price > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, market, symbol)
);

create index if not exists idx_member_watchlist_market_symbol_user
  on public.member_watchlist_items (market, symbol, user_id);

alter table public.member_watchlist_items enable row level security;
alter table public.member_watchlist_items force row level security;

revoke all on table public.member_watchlist_items from public, anon, authenticated;
grant select, insert, update, delete on table public.member_watchlist_items to authenticated;
grant all on table public.member_watchlist_items to service_role;

drop policy if exists member_watchlist_select_own on public.member_watchlist_items;
create policy member_watchlist_select_own
  on public.member_watchlist_items
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists member_watchlist_insert_own on public.member_watchlist_items;
create policy member_watchlist_insert_own
  on public.member_watchlist_items
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists member_watchlist_update_own on public.member_watchlist_items;
create policy member_watchlist_update_own
  on public.member_watchlist_items
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists member_watchlist_delete_own on public.member_watchlist_items;
create policy member_watchlist_delete_own
  on public.member_watchlist_items
  for delete
  to authenticated
  using (auth.uid() = user_id);

comment on table public.member_watchlist_items is
  'Authenticated member-owned watchlist. UNRESOLVED rows are retained for sync but are never eligible for Telegram signal matching.';

commit;
