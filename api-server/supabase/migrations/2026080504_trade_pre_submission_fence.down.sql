begin;

create or replace function public.claim_trade_order_execution(
  p_user_id uuid,
  p_order_id uuid,
  p_expected_version bigint,
  p_claim_id uuid,
  p_lease_seconds integer default 30
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $claim_trade_order_execution$
declare
  result jsonb;
begin
  if auth.uid() is not null and auth.uid() <> p_user_id then raise exception 'USER_SCOPE_MISMATCH'; end if;
  if p_lease_seconds < 5 or p_lease_seconds > 300 then raise exception 'TRADE_EXECUTION_LEASE_INVALID'; end if;
  update public.trade_orders
  set execution_claim_id = p_claim_id,
      execution_claimed_at = clock_timestamp(),
      version = version + 1,
      payload = jsonb_set(
        jsonb_set(payload, '{version}', to_jsonb(version + 1), true),
        '{executionClaimId}', to_jsonb(p_claim_id::text), true
      ),
      updated_at = clock_timestamp()
  where user_id = p_user_id
    and id = p_order_id
    and state = 'SUBMITTED'
    and version = p_expected_version
    and (execution_claimed_at is null or execution_claimed_at < clock_timestamp() - make_interval(secs => p_lease_seconds))
  returning payload into result;
  return result;
end
$claim_trade_order_execution$;

revoke all on function public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer) from public, anon;
grant execute on function public.claim_trade_order_execution(uuid, uuid, bigint, uuid, integer) to authenticated, service_role;

commit;
