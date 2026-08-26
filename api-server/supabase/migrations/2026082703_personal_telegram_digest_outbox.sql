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
  safe_summary text;
begin
  if p_user_id is null or p_delivery_id is null or p_window_end is null or p_created_at is null then
    raise exception 'DIGEST_INVALID_ARGUMENT';
  end if;
  if p_window_end <= p_created_at then
    raise exception 'DIGEST_INVALID_WINDOW';
  end if;
  if p_dedupe_key is null or length(p_dedupe_key) < 8 or length(p_dedupe_key) > 240 then
    raise exception 'DIGEST_INVALID_KEY';
  end if;
  if jsonb_typeof(p_event) <> 'object' then
    raise exception 'DIGEST_INVALID_EVENT';
  end if;
  event_id := nullif(btrim(p_event->>'eventId'), '');
  if event_id is null or nullif(btrim(p_event->>'userId'), '') is distinct from p_user_id::text then
    raise exception 'DIGEST_EVENT_OWNER_MISMATCH';
  end if;
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
              current_events || jsonb_build_array(p_event),
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
          'event', p_event,
          'alert', jsonb_build_object(
            'type', 'intelligence_report',
            'details', '📬 Telegram 모아보기' || E'\n• ' || safe_summary,
            'timestamp', p_window_end::text,
            'duplicateWindowMs', 0,
            'cooldownMs', 0,
            'linkPreview', false
          ),
          'digestMode', 'BATCHED',
          'digestEvents', jsonb_build_array(p_event)
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
