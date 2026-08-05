#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable trade concurrency verification}"
export PGPASSWORD

PSQL=(psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT

USER_ID="11111111-1111-1111-1111-111111111111"
PLAN_ID="42000000-0000-0000-0000-000000000001"
MOCK_POST_LOG="$TMP_DIR/mock-order-posts.log"
: > "$MOCK_POST_LOG"

echo "[trade-concurrency] seed one submitted plan for ten simultaneous order attempts"
"${PSQL[@]}" <<SQL
set role authenticated;
set request.jwt.claim.sub = '$USER_ID';
insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, version)
values (
  '$USER_ID',
  '$PLAN_ID',
  'concurrency-signal-a',
  'SUBMITTED',
  jsonb_build_object(
    'id', '$PLAN_ID',
    'userId', '$USER_ID',
    'state', 'SUBMITTED',
    'version', 0,
    'updatedAt', '2026-08-05T03:30:00.000Z'
  ),
  0
);
SQL

order_worker() {
  local worker="$1"
  local suffix
  local order_id
  local event_id
  local result
  suffix="$(printf '%012d' "$worker")"
  order_id="52000000-0000-0000-0000-$suffix"
  event_id="62000000-0000-0000-0000-$suffix"
  result="$("${PSQL[@]}" <<SQL
set role authenticated;
set request.jwt.claim.sub = '$USER_ID';
select case when inserted then 1 else 0 end
from public.create_trade_order_atomic(
  '$USER_ID',
  '$PLAN_ID',
  'SUBMITTED',
  jsonb_build_object(
    'id', '$order_id',
    'userId', '$USER_ID',
    'planId', '$PLAN_ID',
    'exchange', 'upbit',
    'clientOrderId', 'concurrency-client-$worker',
    'exchangeOrderId', null,
    'state', 'SUBMITTED',
    'requestedQuantity', 1,
    'remainingQuantity', 1,
    'filledQuantity', 0,
    'fills', jsonb_build_array(),
    'feeAmount', null,
    'feeCurrency', null,
    'version', 0,
    'createdAt', '2026-08-05T03:30:01.000Z',
    'updatedAt', '2026-08-05T03:30:01.000Z'
  ),
  jsonb_build_object(
    'id', '$event_id',
    'userId', '$USER_ID',
    'orderId', '$order_id',
    'fromState', null,
    'toState', 'SUBMITTED',
    'reason', 'CONCURRENT_ORDER_CREATED',
    'metadata', jsonb_build_object('worker', $worker),
    'createdAt', '2026-08-05T03:30:01.000Z'
  )
);
SQL
)"
  [[ "$result" =~ ^[01]$ ]] || { echo "unexpected order worker result: $result" >&2; return 1; }
  printf '%s\n' "$result"
}

pids=()
for worker in $(seq 1 10); do
  order_worker "$worker" > "$TMP_DIR/order-$worker.out" &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done

order_winners="$(awk '$0 == "1" { count += 1 } END { print count + 0 }' "$TMP_DIR"/order-*.out)"
order_losers="$(awk '$0 == "0" { count += 1 } END { print count + 0 }' "$TMP_DIR"/order-*.out)"
[[ "$order_winners" == "1" ]] || { echo "expected one order winner, got $order_winners" >&2; exit 1; }
[[ "$order_losers" == "9" ]] || { echo "expected nine idempotent order losers, got $order_losers" >&2; exit 1; }

atomic_counts="$("${PSQL[@]}" --command "select (select count(*) from public.trade_orders where user_id = '$USER_ID' and plan_id = '$PLAN_ID') || ':' || (select count(*) from public.trade_order_events where user_id = '$USER_ID' and order_id in (select id from public.trade_orders where user_id = '$USER_ID' and plan_id = '$PLAN_ID'));" )"
[[ "$atomic_counts" == "1:1" ]] || { echo "order/event atomicity mismatch: $atomic_counts" >&2; exit 1; }

ORDER_ID="$("${PSQL[@]}" --command "select id from public.trade_orders where user_id = '$USER_ID' and plan_id = '$PLAN_ID';")"
[[ -n "$ORDER_ID" ]] || { echo "winning order id missing" >&2; exit 1; }

claim_worker() {
  local worker="$1"
  local claim_id="72000000-0000-0000-0000-$(printf '%012d' "$worker")"
  local result
  result="$("${PSQL[@]}" <<SQL
set role authenticated;
set request.jwt.claim.sub = '$USER_ID';
select case when public.claim_trade_order_execution(
  '$USER_ID',
  '$ORDER_ID',
  0,
  '$claim_id',
  30
) is null then 0 else 1 end;
SQL
)"
  [[ "$result" =~ ^[01]$ ]] || { echo "unexpected claim worker result: $result" >&2; return 1; }
  if [[ "$result" == "1" ]]; then
    printf 'POST /mock/exchange/orders claim=%s\n' "$claim_id" >> "$MOCK_POST_LOG"
  fi
  printf '%s\n' "$result"
}

claim_worker 1 > "$TMP_DIR/claim-1.out" & claim_pid_1="$!"
claim_worker 2 > "$TMP_DIR/claim-2.out" & claim_pid_2="$!"
wait "$claim_pid_1"
wait "$claim_pid_2"

claim_winners="$(awk '$0 == "1" { count += 1 } END { print count + 0 }' "$TMP_DIR"/claim-*.out)"
claim_losers="$(awk '$0 == "0" { count += 1 } END { print count + 0 }' "$TMP_DIR"/claim-*.out)"
[[ "$claim_winners" == "1" ]] || { echo "expected one execution claim winner, got $claim_winners" >&2; exit 1; }
[[ "$claim_losers" == "1" ]] || { echo "expected one execution claim loser, got $claim_losers" >&2; exit 1; }
[[ "$(wc -l < "$MOCK_POST_LOG" | tr -d ' ')" == "1" ]] || { echo "mock exchange POST count was not exactly one" >&2; exit 1; }

latest_snapshot="$("${PSQL[@]}" --command "select version || '|' || execution_claim_id || '|' || state from public.trade_orders where user_id = '$USER_ID' and id = '$ORDER_ID';")"
IFS='|' read -r latest_version latest_claim latest_state <<< "$latest_snapshot"
[[ "$latest_version" == "1" ]] || { echo "losing worker requery did not observe version 1: $latest_snapshot" >&2; exit 1; }
[[ "$latest_state" == "SUBMITTED" ]] || { echo "claim changed order state unexpectedly: $latest_snapshot" >&2; exit 1; }
[[ "$latest_claim" == "72000000-0000-0000-0000-000000000001" || "$latest_claim" == "72000000-0000-0000-0000-000000000002" ]] || {
  echo "unexpected winning claim id: $latest_snapshot" >&2
  exit 1
}

echo "[trade-concurrency] ten order attempts=1 insert/9 reuse; two claimants=1 winner; mock POST=1; version requery=1"

"${PSQL[@]}" <<SQL
set role authenticated;
set request.jwt.claim.sub = '$USER_ID';
delete from public.trade_order_events where user_id = '$USER_ID' and order_id = '$ORDER_ID';
delete from public.trade_orders where user_id = '$USER_ID' and id = '$ORDER_ID';
delete from public.trade_order_plans where user_id = '$USER_ID' and id = '$PLAN_ID';
SQL
