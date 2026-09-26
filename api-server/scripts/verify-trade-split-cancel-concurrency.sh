#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable split cancellation concurrency verification}"
export PGPASSWORD

PSQL=(psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT

USER_ID="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PLAN_ID="82000000-0000-0000-0000-000000000010"
LEG1_ID="82000000-0000-0000-0000-000000000011"
LEG2_ID="82000000-0000-0000-0000-000000000012"
ORDER1_ID="82000000-0000-0000-0000-000000000021"
ORDER2_ID="82000000-0000-0000-0000-000000000022"
EVENT_ID="82000000-0000-0000-0000-000000000033"

echo "[trade-split-cancel-concurrency] seed approved plan with first child filled and second child planned"
"${PSQL[@]}" <<SQL
with approval as (
  select clock_timestamp() as approved_at, clock_timestamp() + interval '10 minutes' as expires_at
)
insert into public.trade_order_plans(
  user_id, id, idempotency_key, state, payload, approval_expires_at, version, created_at, updated_at
)
select
  '$USER_ID',
  '$PLAN_ID',
  'split-cancel-concurrency',
  'SUBMITTED',
  jsonb_build_object(
    'id', '$PLAN_ID',
    'userId', '$USER_ID',
    'idempotencyKey', 'split-cancel-concurrency',
    'state', 'SUBMITTED',
    'version', 0,
    'approvedAt', approved_at::text,
    'approvalExpiresAt', expires_at::text,
    'estimatedKrw', 100000,
    'quoteAmount', 100000,
    'splitRatios', jsonb_build_array(50, 50),
    'riskEnvelope', jsonb_build_object(
      'version', 1,
      'investmentKrw', 100000,
      'maxLossKrw', 5250,
      'maxSlippagePercent', 0.25,
      'maxSplitCount', 2,
      'allowCancelUnfilled', true,
      'stopMethod', 'fixed_stop',
      'emergencyExitScope', 'cancel_unfilled_and_reduce_only',
      'approvedAt', approved_at::text,
      'expiresAt', expires_at::text
    )
  ),
  expires_at,
  0,
  approved_at,
  approved_at
from approval;

select public.create_trade_split_orders_atomic(
  '$USER_ID',
  '$PLAN_ID',
  'SUBMITTED',
  0,
  jsonb_build_array(
    jsonb_build_object(
      'id', '$LEG1_ID', 'userId', '$USER_ID', 'planId', '$PLAN_ID',
      'legKey', 'entry-1', 'legType', 'ENTRY', 'sequenceNo', 1,
      'idempotencyKey', 'split-cancel-concurrency-leg-1', 'plannedQuoteAmount', 50000,
      'filledQuantity', 0, 'state', 'PLANNED', 'version', 0
    ),
    jsonb_build_object(
      'id', '$LEG2_ID', 'userId', '$USER_ID', 'planId', '$PLAN_ID',
      'legKey', 'entry-2', 'legType', 'ENTRY', 'sequenceNo', 2,
      'idempotencyKey', 'split-cancel-concurrency-leg-2', 'plannedQuoteAmount', 50000,
      'filledQuantity', 0, 'state', 'PLANNED', 'version', 0
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'id', '$ORDER1_ID', 'userId', '$USER_ID', 'planId', '$PLAN_ID',
      'exchange', 'upbit', 'clientOrderId', 'split-cancel-race-1', 'state', 'SUBMITTED',
      'version', 0, 'legId', '$LEG1_ID', 'legKey', 'entry-1',
      'legSequenceNo', 1, 'legCount', 2, 'requestedQuoteAmount', 50000,
      'previousChildOrderId', null, 'approvedPlanVersion', 0,
      'createdAt', clock_timestamp()::text, 'updatedAt', clock_timestamp()::text
    ),
    jsonb_build_object(
      'id', '$ORDER2_ID', 'userId', '$USER_ID', 'planId', '$PLAN_ID',
      'exchange', 'upbit', 'clientOrderId', 'split-cancel-race-2', 'state', 'PLANNED',
      'version', 0, 'legId', '$LEG2_ID', 'legKey', 'entry-2',
      'legSequenceNo', 2, 'legCount', 2, 'requestedQuoteAmount', 50000,
      'previousChildOrderId', '$ORDER1_ID', 'approvedPlanVersion', 0,
      'createdAt', clock_timestamp()::text, 'updatedAt', clock_timestamp()::text
    )
  ),
  jsonb_build_array(
    jsonb_build_object(
      'id', '82000000-0000-0000-0000-000000000031', 'userId', '$USER_ID',
      'orderId', '$ORDER1_ID', 'toState', 'SUBMITTED', 'reason', 'SPLIT_CHILD_CREATED',
      'createdAt', clock_timestamp()::text
    ),
    jsonb_build_object(
      'id', '82000000-0000-0000-0000-000000000032', 'userId', '$USER_ID',
      'orderId', '$ORDER2_ID', 'toState', 'PLANNED', 'reason', 'SPLIT_CHILD_CREATED',
      'createdAt', clock_timestamp()::text
    )
  )
);

update public.trade_orders
set state = 'FILLED',
    version = version + 1,
    payload = jsonb_set(jsonb_set(payload, '{state}', '"FILLED"'::jsonb, true), '{version}', '1'::jsonb, true),
    updated_at = clock_timestamp()
where user_id = '$USER_ID' and id = '$ORDER1_ID' and state = 'SUBMITTED';
SQL

cancel_worker() {
  "${PSQL[@]}" <<SQL
select case when public.cancel_trade_split_children_atomic(
  '$USER_ID',
  '$PLAN_ID',
  0,
  2,
  jsonb_build_array(
    jsonb_build_object(
      'id', '$EVENT_ID',
      'userId', '$USER_ID',
      'orderId', '$ORDER2_ID',
      'fromState', 'PLANNED',
      'toState', 'CANCELED',
      'reason', 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT',
      'createdAt', '2026-08-08T04:30:00.000Z'
    )
  )
) is null then 0 else 1 end;
SQL
}

cancel_worker > "$TMP_DIR/cancel-1.out" & pid1="$!"
cancel_worker > "$TMP_DIR/cancel-2.out" & pid2="$!"
wait "$pid1"
wait "$pid2"

successes="$(awk '$0 == "1" { count += 1 } END { print count + 0 }' "$TMP_DIR"/cancel-*.out)"
[[ "$successes" == "2" ]] || { echo "expected two successful idempotent cancellation callers, got $successes" >&2; exit 1; }

snapshot="$("${PSQL[@]}" --command "select (select state || ':' || version from public.trade_orders where user_id = '$USER_ID' and id = '$ORDER1_ID') || '|' || (select state || ':' || version from public.trade_orders where user_id = '$USER_ID' and id = '$ORDER2_ID') || '|' || (select count(*) from public.trade_order_events where user_id = '$USER_ID' and id = '$EVENT_ID' and order_id = '$ORDER2_ID' and to_state = 'CANCELED' and payload->>'fromState' = 'PLANNED');")"
[[ "$snapshot" == "FILLED:1|CANCELED:1|1" ]] || { echo "concurrent split cancellation invariant mismatch: $snapshot" >&2; exit 1; }

echo "[trade-split-cancel-concurrency] concurrent callers=2; filled child unchanged; planned child canceled once; audit event=1; private exchange requests=0"

"${PSQL[@]}" <<SQL
delete from public.trade_order_events where user_id = '$USER_ID' and order_id in ('$ORDER1_ID', '$ORDER2_ID');
delete from public.trade_orders where user_id = '$USER_ID' and plan_id = '$PLAN_ID';
delete from public.trade_order_legs where user_id = '$USER_ID' and plan_id = '$PLAN_ID';
delete from public.trade_order_plans where user_id = '$USER_ID' and id = '$PLAN_ID';
SQL
