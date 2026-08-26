-- Keep digest delivery on the canonical notification_deliveries outbox.
-- This server-only function serializes claims for one user/digest key so
-- concurrent workers cannot split the same due digest into duplicate sends.
begin;

create or replace function public.claim_personal_telegram_digest(
  p_user_id uuid,
  p_delivery_id uuid,
  p_now timestamptz,
  p_limit integer default 50
)
returns setof public.notification_deliveries
language plpgsql
security definer
set search_path = public, pg_temp
as $claim_personal_telegram_digest$
declare
  v_digest_key text;
begin
  if p_limit < 1 or p_limit > 50 then
    raise exception 'personal Telegram digest claim limit is invalid';
  end if;

  select delivery.payload ->> 'digestKey'
  into v_digest_key
  from public.notification_deliveries delivery
  where delivery.user_id = p_user_id
    and delivery.id = p_delivery_id
    and delivery.delivery_kind = 'PERSONAL_ALERT'
    and delivery.state in ('PENDING', 'RETRY_SCHEDULED', 'FAILED')
    and delivery.payload ->> 'deliveryMode' = 'BATCHED'
    and (delivery.next_retry_at is null or delivery.next_retry_at <= p_now);

  if v_digest_key is null or btrim(v_digest_key) = '' then
    return;
  end if;

  -- Acquire the digest-level lock before taking row locks. A second worker for
  -- the same digest waits here and then observes the first worker's SENDING rows.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || v_digest_key, 0));

  return query
  with picked as (
    select delivery.id
    from public.notification_deliveries delivery
    where delivery.user_id = p_user_id
      and delivery.delivery_kind = 'PERSONAL_ALERT'
      and delivery.state in ('PENDING', 'RETRY_SCHEDULED', 'FAILED')
      and delivery.payload ->> 'deliveryMode' = 'BATCHED'
      and delivery.payload ->> 'digestKey' = v_digest_key
      and (delivery.next_retry_at is null or delivery.next_retry_at <= p_now)
    order by delivery.created_at asc, delivery.id asc
    for update skip locked
    limit p_limit
  )
  update public.notification_deliveries delivery
  set state = 'SENDING',
      updated_at = p_now
  from picked
  where delivery.user_id = p_user_id
    and delivery.id = picked.id
  returning delivery.*;
end
$claim_personal_telegram_digest$;

revoke all on function public.claim_personal_telegram_digest(uuid, uuid, timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.claim_personal_telegram_digest(uuid, uuid, timestamptz, integer)
  to service_role;

commit;
