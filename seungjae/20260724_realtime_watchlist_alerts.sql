-- 실시간 차트 연동: 회원별 자산 관심종목, 가격/등락률 알림,
-- 앱 내부 신호 알림 메타데이터. 기존 데이터는 보존한다.

alter table public.watchlist_items
  add column if not exists asset_type text;

update public.watchlist_items
set asset_type = case
  when upper(coalesce(market, '')) = 'US' then 'stockUS'
  else 'stockKR'
end
where asset_type is null or asset_type = '';

alter table public.watchlist_items
  alter column asset_type set default 'stockKR',
  alter column asset_type set not null;

alter table public.watchlist_items
  drop constraint if exists watchlist_items_device_id_ticker_key;

create unique index if not exists watchlist_items_owner_asset_ticker_uidx
  on public.watchlist_items(device_id, asset_type, ticker);

alter table public.price_alerts
  add column if not exists condition_type text,
  add column if not exists target_value numeric,
  add column if not exists last_checked_change_percent numeric;

update public.price_alerts
set
  condition_type = case
    when direction = 'below' then 'price_below'
    else 'price_above'
  end,
  target_value = target_price
where condition_type is null or target_value is null;

alter table public.price_alerts
  alter column condition_type set default 'price_above',
  alter column condition_type set not null,
  alter column target_value set not null;

alter table public.price_alerts
  drop constraint if exists price_alerts_member_id_asset_type_market_symbol_direction_target_price_key;

create unique index if not exists price_alerts_owner_condition_uidx
  on public.price_alerts(
    member_id,
    asset_type,
    market,
    symbol,
    condition_type,
    target_value
  );

alter table public.notification_history
  add column if not exists asset_type text,
  add column if not exists symbol text,
  add column if not exists signal_id text,
  add column if not exists importance text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create unique index if not exists notification_history_owner_signal_uidx
  on public.notification_history(member_id, signal_id)
  where signal_id is not null;

create index if not exists notification_history_owner_unread_idx
  on public.notification_history(member_id, created_at desc)
  where read_at is null