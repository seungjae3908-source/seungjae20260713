-- Recovery worker lease ownership and stale-worker fencing.
-- CI/disposable PostgreSQL only until a separate production migration approval.
begin;

create or replace function public.transition_trade_recovery_order_atomic(
  p_worker_id uuid,
  p_user_id uuid,
  p_order_id uuid,
  p_expected_state text,
  p_expected_version bigint,
  p_next_state text,
  p_order_payload jsonb,
  p_event_payload jsonb,
  p_release_lease boolean
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $transition_trade_recovery_order_atomic$
declare
  result jsonb;
  next_payload jsonb;
  event_id uuid;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then
    raise exception 'USER_SCOPE_MISMATCH';
  end if;
  if p_worker_id is null then raise exception 'TRADE_RECOVERY_WORKER_REQUIRED'; end if;
  event_id := nullif(p_event_payload->>'id', '')::uuid;
  if event_id is null then raise exception 'TRADE_RECOVERY_EVENT_REQUIRED'; end if;

  next_payload := jsonb_set(p_order_payload, '{version}', to_jsonb(p_expected_version + 1), true);

  update public.trade_orders
  set state = p_next_state,
      version = version + 1,
      payload = case
        when p_release_lease then jsonb_set(
          jsonb_set(next_payload, '{recoveryLeaseOwner}', 'null'::jsonb, true),
          '{recoveryLeaseUntil}', 'null'::jsonb, true
        )
        else jsonb_set(
          jsonb_set(next_payload, '{recoveryLeaseOwner}', to_jsonb(p_worker_id::text), true),
          '{recoveryLeaseUntil}', to_jsonb(recovery_lease_until::text), true
        )
      end,
      exchange_order_id = nullif(next_payload->>'exchangeOrderId', ''),
      remaining_quantity = nullif(next_payload->>'remainingQuantity', '')::numeric,
      fills = coalesce(next_payload->'fills', '[]'::jsonb),
      fee_amount = nullif(next_payload->>'feeAmount', '')::numeric,
      fee_currency = nullif(next_payload->>'feeCurrency', ''),
      exchange_created_at = nullif(next_payload->>'exchangeCreatedAt', '')::timestamptz,
      exchange_updated_at = nullif(next_payload->>'exchangeUpdatedAt', '')::timestamptz,
      cancelable = nullif(next_payload->>'cancelable', '')::boolean,
      provider_status_code = nullif(next_payload->>'providerStatusCode', ''),
      next_retry_at = nullif(next_payload->>'nextRetryAt', '')::timestamptz,
      last_reconciled_at = nullif(next_payload->>'lastReconciledAt', '')::timestamptz,
      manual_review_required = coalesce((next_payload->>'manualReviewRequired')::boolean, false),
      recovery_lease_owner = case when p_release_lease then null else recovery_lease_owner end,
      recovery_lease_until = case when p_release_lease then null else recovery_lease_until end,
      protection_status = coalesce(nullif(next_payload->>'protectionStatus', ''), protection_status),
      protection_error_code = nullif(next_payload->>'protectionErrorCode', ''),
      updated_at = coalesce(nullif(next_payload->>'updatedAt', '')::timestamptz, clock_timestamp())
  where user_id = p_user_id
    and id = p_order_id
    and state = p_expected_state
    and version = p_expected_version
    and recovery_lease_owner = p_worker_id
    and recovery_lease_until >= clock_timestamp()
  returning payload into result;

  if result is null then return null; end if;

  insert into public.trade_order_events(user_id, id, order_id, to_state, payload, created_at)
  values (
    p_user_id,
    event_id,
    p_order_id,
    p_next_state,
    p_event_payload,
    coalesce(nullif(p_event_payload->>'createdAt', '')::timestamptz, clock_timestamp())
  );
  return result;
end
$transition_trade_recovery_order_atomic$;

revoke all on function public.transition_trade_recovery_order_atomic(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.transition_trade_recovery_order_atomic(
  uuid, uuid, uuid, text, bigint, text, jsonb, jsonb, boolean
) to service_role;

commit;
