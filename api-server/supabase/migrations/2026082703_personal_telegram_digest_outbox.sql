-- Atomic append for per-user Telegram BATCHED/Digest delivery.
-- Reuses notification_deliveries from the durable personal outbox. One row is
-- created per user/window; sanitized event metadata is appended under a row
-- lock and the existing worker sends the row after next_retry_at=window_end.
begin;

create or replace function public.append_personal_telegram_digest_item(
  p_user_id uuid,
  p_delivery_id uuid,
  p_dedupe_key text,
  p_window_end timestamptz,
  p_event jsonb,
  p_summary text,
  p_created_at timestamptz
)
returns table(delivery_id uuid, accepted boolean, item_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $digest$
declare
  current_row public.notification_deliveries%rowtype;
  current_events jsonb;
  current_count integer;
  event_id text;
  event_market text;
  event_signal_type text;
  event_priority text;
  event_symbol text;
  event_occurred_at text;
  safe_event jsonb;
  safe_summary text;
begin
  if p_user_id is null or p_delivery_id is null or p_window_end is null or p_created_at is null then
    raise exception 'DIGEST_INVALID_ARGUMENT';
  end if;
  if p_window_end <= p_created_at or p_window_end - p_created_at > interval '7 days' then
    raise exception 'DIGEST_INVALID_WINDOW';
  end if;
  if p_dedupe_key is null or length(p_dedupe_key) < 8 or length(p_dedupe_key) > 240 then
    raise exception 'DIGEST_INVALID_KEY';
  end if;
  if jsonb_typeof(p_event) is distinct from 'object' then
    raise exception 'DIGEST_INVALID_EVENT';
  end if;
  if jsonb_typeof(p_event->'userId') is distinct from 'string'
    or jsonb_typeof(p_event->'eventId') is distinct from 'string'
    or jsonb_typeof(p_event->'signalType') is distinct from 'string'
    or jsonb_typeof(p_event->'priority') is distinct from 'string'
    or jsonb_typeof(p_event->'occurredAt') is distinct from 'string' then
    raise exception 'DIGEST_INVALID_EVENT';
  end if;
  if p_event ? 'market' and coalesce(jsonb_typeof(p_event->'market'), 'null') not in ('string', 'null') then
    raise exception 'DIGEST_INVALID_EVENT';
  end if;
  if p_event ? 'symbol' and coalesce(jsonb_typeof(p_event->'symbol'), 'null') not in ('string', 'null') then
    raise exception 'DIGEST_INVALID_EVENT';
  end if;

  event_id := nullif(btrim(p_event->>'eventId'), '');
  if event_id is null or length(event_id) > 160
    or nullif(btrim(p_event->>'userId'), '') is distinct from p_user_id::text then
    raise exception 'DIGEST_EVENT_OWNER_MISMATCH';
  end if;

  event_signal_type := nullif(btrim(p_event->>'signalType'), '');
  event_priority := nullif(btrim(p_event->>'priority'), '');
  event_market := nullif(btrim(p_event->>'market'), '');
  event_symbol := nullif(btrim(p_event->>'symbol'), '');
  event_occurred_at := nullif(btrim(p_event->>'occurredAt'), '');

  if event_signal_type is null or event_signal_type not in (
    'BUY', 'LONG', 'SHORT', 'NO_TRADE', 'PRICE_TARGET', 'STRATEGY_HEALTH',
    'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR'
  ) then
    raise exception 'DIGEST_INVALID_SIGNAL_TYPE';
  end if;
  if event_priority is null or event_priority not in ('CRITICAL', 'IMPORTANT', 'INFO') then
    raise exception 'DIGEST_INVALID_PRIORITY';
  end if;
  if event_market is not null and event_market not in ('KR', 'US', 'CRYPTO_SPOT', 'CRYPTO_FUTURES') then
    raise exception 'DIGEST_INVALID_MARKET';
  end if;
  if event_market is null and event_signal_type not in (
    'STRATEGY_HEALTH', 'CHAMPION', 'RESEARCH', 'SETTLEMENT', 'PROVIDER_SERVER_ERROR'
  ) then
    raise exception 'DIGEST_MARKET_REQUIRED';
  end if;
  if event_symbol is not null and length(event_symbol) > 64 then
    raise exception 'DIGEST_INVALID_SYMBOL';
  end if;
  if event_occurred_at is null then
    raise exception 'DIGEST_INVALID_TIMESTAMP';
  end if;
  begin
    perform event_occurred_at::timestamptz;
  exception when others then
    raise exception 'DIGEST_INVALID_TIMESTAMP';
  end;

  safe_event := jsonb_strip_nulls(jsonb_build_object(
    'userId', p_user_id::text,
    'eventId', event_id,
    'market', event_market,
    'signalType', event_signal_type,
    'priority', event_priority,
    'symbol', event_symbol,
    'occurredAt', event_occurred_at
  ));

  safe_summary := left(regexp_replace(coalesce(p_summary, ''), '[\r\n\t]+', ' ', 'g'), 180);
  if length(btrim(safe_summary)) = 0 then
    safe_summary := '알림 세부내용 N/A';
  end if;

  loop
    select * into current_row
    from public.notification_deliveries
    where user_id = p_user_id and dedupe_key = p_dedupe_key
    for update;

    if found then
      if current_row.delivery_kind <> 'PERSONAL_ALERT'
        or current_row.state <> 'PENDING'
        or current_row.next_retry_at is distinct from p_window_end
        or coalesce(current_row.payload->>'digestMode', '') <> 'BATCHED' then
        return query select current_row.id, false, 0;
        return;
      end if;

      current_events := coalesce(current_row.payload->'digestEvents', '[]'::jsonb);
      if jsonb_typeof(current_events) <> 'array' then
        return query select current_row.id, false, 0;
        return;
      end if;
      current_count := jsonb_array_length(current_events);
      if current_count >= 20 then
        return query select current_row.id, false, current_count;
        return;
      end if;
      if exists (
        select 1 from jsonb_array_elements(current_events) value
        where value->>'eventId' = event_id
      ) then
        return query select current_row.id, false, current_count;
        return;
      end if;

      update public.notification_deliveries
      set payload = jsonb_set(
            jsonb_set(
              current_row.payload,
              '{digestEvents}',
              current_events || jsonb_build_array(safe_event),
              true
            ),
            '{alert,details}',
            to_jsonb(
              left(
                coalesce(current_row.payload#>>'{alert,details}', '📬 Telegram 모아보기')
                || E'\n• ' || safe_summary,
                3900
              )
            ),
            true
          ),
          updated_at = p_created_at
      where user_id = p_user_id and id = current_row.id;

      return query select current_row.id, true, current_count + 1;
      return;
    end if;

    begin
      insert into public.notification_deliveries (
        user_id, id, event_id, dedupe_key, state, attempts, next_retry_at,
        last_error_code, created_at, updated_at, delivery_kind, payload
      ) values (
        p_user_id, p_delivery_id, null, p_dedupe_key, 'PENDING', 0, p_window_end,
        null, p_created_at, p_created_at, 'PERSONAL_ALERT',
        jsonb_build_object(
          'event', safe_event,
          'alert', jsonb_build_object(
            'type', 'intelligence_report',
            'details', '📬 Telegram 모아보기' || E'\n• ' || safe_summary,
            'timestamp', p_window_end::text,
            'duplicateWindowMs', 0,
            'cooldownMs', 0,
            'linkPreview', false
          ),
          'digestMode', 'BATCHED',
          'digestEvents', jsonb_build_array(safe_event)
        )
      );
      return query select p_delivery_id, true, 1;
      return;
    exception when unique_violation then
      -- Another server process created the same user/window row first.
      -- Retry the loop and append under that row's lock.
      null;
    end;
  end loop;
end
$digest$;

revoke all on function public.append_personal_telegram_digest_item(uuid,uuid,text,timestamptz,jsonb,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.append_personal_telegram_digest_item(uuid,uuid,text,timestamptz,jsonb,text,timestamptz)
  to service_role;

commit;