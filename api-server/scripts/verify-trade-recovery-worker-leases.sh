#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable recovery lease verification}"
export PGPASSWORD

PSQL=(psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT

USER_ID="11111111-1111-1111-1111-111111111111"
PLAN_1="43000000-0000-0000-0000-000000000001"
PLAN_2="43000000-0000-0000-0000-000000000002"
ORDER_1="53000000-0000-0000-0000-000000000001"
ORDER_2="53000000-0000-0000-0000-000000000002"
WORKER_1="73000000-0000-0000-0000-000000000001"
WORKER_2="73000000-0000-0000-0000-000000000002"
WORKER_3="73000000-0000-0000-0000-000000000003"
WRONG_WORKER="73000000-0000-0000-0000-000000000099"
FIXTURE_TIME="2000-01-01T00:00:00.000Z"

# Seed and cleanup remain database-owner operations. The deliberately old
# updated_at values and one-row claim limit isolate these two fixtures from
# orders left by preceding migration integration tests without weakening the
# real SKIP LOCKED race.
"${PSQL[@]}" <<SQL
delete from public.trade_order_events where user_id = '$USER_ID' and order_id in ('$ORDER_1', '$ORDER_2');
delete from public.trade_orders where user_id = '$USER_ID' and id in ('$ORDER_1', '$ORDER_2');
delete from public.trade_order_plans where user_id = '$USER_ID' and id in ('$PLAN_1', '$PLAN_2');

insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, version, updated_at)
values
  ('$USER_ID', '$PLAN_1', 'recovery-lease-plan-1', 'SUBMITTED',
   jsonb_build_object('id', '$PLAN_1', 'userId', '$USER_ID', 'state', 'SUBMITTED', 'version', 0), 0, '$FIXTURE_TIME'),
  ('$USER_ID', '$PLAN_2', 'recovery-lease-plan-2', 'SUBMITTED',
   jsonb_build_object('id', '$PLAN_2', 'userId', '$USER_ID', 'state', 'SUBMITTED', 'version', 0), 0, '$FIXTURE_TIME');

insert into public.trade_orders(
  user_id, id, plan_id, exchange, client_order_id, state, payload, version,
  remaining_quantity, fills, manual_review_required, updated_at
)
values
  ('$USER_ID', '$ORDER_1', '$PLAN_1', 'upbit', 'recovery-client-1', 'ACCEPTED',
   jsonb_build_object(
     'id', '$ORDER_1', 'userId', '$USER_ID', 'planId', '$PLAN_1', 'exchange', 'upbit',
     'clientOrderId', 'recovery-client-1', 'exchangeOrderId', null, 'state', 'ACCEPTED',
     'version', 0, 'requestedQuantity', 1, 'remainingQuantity', 1, 'filledQuantity', 0,
     'averageFillPrice', null, 'fills', jsonb_build_array(), 'retryCount', 0,
     'lastErrorCode', null, 'manualReviewRequired', false,
     'createdAt', '$FIXTURE_TIME', 'updatedAt', '$FIXTURE_TIME'
   ), 0, 1, '[]'::jsonb, false, '$FIXTURE_TIME'),
  ('$USER_ID', '$ORDER_2', '$PLAN_2', 'upbit', 'recovery-client-2', 'RECOVERY_REQUIRED',
   jsonb_build_object(
     'id', '$ORDER_2', 'userId', '$USER_ID', 'planId', '$PLAN_2', 'exchange', 'upbit',
     'clientOrderId', 'recovery-client-2', 'exchangeOrderId', null, 'state', 'RECOVERY_REQUIRED',
     'version', 0, 'requestedQuantity', 1, 'remainingQuantity', 1, 'filledQuantity', 0,
     'averageFillPrice', null, 'fills', jsonb_build_array(), 'retryCount', 0,
     'lastErrorCode', null, 'manualReviewRequired', false,
     'createdAt', '$FIXTURE_TIME', 'updatedAt', '$FIXTURE_TIME'
   ), 0, 1, '[]'::jsonb, false, '$FIXTURE_TIME');
SQL

claim_worker() {
  local worker_id="$1"
  "${PSQL[@]}" <<SQL
set role service_role;
select payload->>'id'
from public.claim_trade_recovery_orders('$worker_id', 1, 60) as claimed(payload);
SQL
}

claim_worker "$WORKER_1" > "$TMP_DIR/worker-1.out" & pid_1="$!"
claim_worker "$WORKER_2" > "$TMP_DIR/worker-2.out" & pid_2="$!"
wait "$pid_1"
wait "$pid_2"

claimed_total="$(cat "$TMP_DIR/worker-1.out" "$TMP_DIR/worker-2.out" | awk 'NF { count += 1 } END { print count + 0 }')"
claimed_unique="$(cat "$TMP_DIR/worker-1.out" "$TMP_DIR/worker-2.out" | awk 'NF' | sort -u | awk 'END { print NR + 0 }')"
claimed_fixture_unique="$(cat "$TMP_DIR/worker-1.out" "$TMP_DIR/worker-2.out" | awk -v a="$ORDER_1" -v b="$ORDER_2" '$0 == a || $0 == b' | sort -u | awk 'END { print NR + 0 }')"
[[ "$claimed_total" == "2" ]] || { echo "expected two total recovery claims, got $claimed_total" >&2; exit 1; }
[[ "$claimed_unique" == "2" ]] || { echo "recovery order was claimed by more than one worker" >&2; exit 1; }
[[ "$claimed_fixture_unique" == "2" ]] || { echo "parallel workers did not claim both isolated fixtures" >&2; exit 1; }

first_snapshot="$("${PSQL[@]}" --command "select id || '|' || recovery_lease_owner || '|' || version || '|' || state from public.trade_orders where id = '$ORDER_1';")"
IFS='|' read -r claimed_order claimed_owner claimed_version claimed_state <<< "$first_snapshot"
[[ "$claimed_order" == "$ORDER_1" && "$claimed_version" == "0" && "$claimed_state" == "ACCEPTED" ]] || {
  echo "unexpected first claimed order snapshot: $first_snapshot" >&2
  exit 1
}

transition_result() {
  local worker_id="$1"
  local expected_state="$2"
  local expected_version="$3"
  local next_state="$4"
  local event_id="$5"
  local reason="$6"
  local release_lease="$7"
  "${PSQL[@]}" <<SQL
set role service_role;
select case when public.transition_trade_recovery_order_atomic(
  '$worker_id', '$USER_ID', '$ORDER_1', '$expected_state', $expected_version, '$next_state',
  (select payload || jsonb_build_object('state', '$next_state', 'updatedAt', clock_timestamp()::text)
   from public.trade_orders where id = '$ORDER_1'),
  jsonb_build_object(
    'id', '$event_id', 'userId', '$USER_ID', 'orderId', '$ORDER_1',
    'fromState', '$expected_state', 'toState', '$next_state', 'reason', '$reason',
    'metadata', jsonb_build_object('orderSubmissionAttempted', false),
    'createdAt', clock_timestamp()::text
  ), $release_lease
) is null then 0 else 1 end;
SQL
}

wrong_prepare="$(transition_result "$WRONG_WORKER" ACCEPTED 0 RECOVERY_REQUIRED 83000000-0000-0000-0000-000000000001 WRONG_WORKER_PREPARE false)"
[[ "$wrong_prepare" == "0" ]] || { echo "wrong worker changed a leased order" >&2; exit 1; }

correct_prepare="$(transition_result "$claimed_owner" ACCEPTED 0 RECOVERY_REQUIRED 83000000-0000-0000-0000-000000000002 LEASE_OWNER_PREPARE false)"
[[ "$correct_prepare" == "1" ]] || { echo "lease owner could not prepare recovery order" >&2; exit 1; }

prepared_snapshot="$("${PSQL[@]}" --command "select state || '|' || version || '|' || recovery_lease_owner from public.trade_orders where id = '$ORDER_1';")"
[[ "$prepared_snapshot" == "RECOVERY_REQUIRED|1|$claimed_owner" ]] || {
  echo "prepare did not preserve the recovery lease: $prepared_snapshot" >&2
  exit 1
}

wrong_final="$(transition_result "$WRONG_WORKER" RECOVERY_REQUIRED 1 CANCELED 83000000-0000-0000-0000-000000000003 WRONG_WORKER_FINAL true)"
[[ "$wrong_final" == "0" ]] || { echo "wrong worker finalized a leased order" >&2; exit 1; }

correct_final="$(transition_result "$claimed_owner" RECOVERY_REQUIRED 1 CANCELED 83000000-0000-0000-0000-000000000004 LEASE_OWNER_FINAL true)"
[[ "$correct_final" == "1" ]] || { echo "lease owner could not finalize recovery order" >&2; exit 1; }

final_snapshot="$("${PSQL[@]}" --command "select state || '|' || version || '|' || coalesce(recovery_lease_owner::text, 'null') || '|' || (select count(*) from public.trade_order_events where order_id = '$ORDER_1') from public.trade_orders where id = '$ORDER_1';")"
[[ "$final_snapshot" == "CANCELED|2|null|2" ]] || { echo "recovery transition/event atomicity mismatch: $final_snapshot" >&2; exit 1; }

"${PSQL[@]}" <<SQL
update public.trade_orders
set recovery_lease_until = clock_timestamp() - interval '1 second',
    payload = jsonb_set(payload, '{recoveryLeaseUntil}', to_jsonb((clock_timestamp() - interval '1 second')::text), true)
where id = '$ORDER_2';
SQL

reclaimed="$("${PSQL[@]}" <<SQL
set role service_role;
select count(*)
from public.claim_trade_recovery_orders('$WORKER_3', 1, 60) as claimed(payload)
where payload->>'id' = '$ORDER_2';
SQL
)"
[[ "$reclaimed" == "1" ]] || { echo "expired recovery lease was not reclaimable" >&2; exit 1; }

reclaimed_owner="$("${PSQL[@]}" --command "select recovery_lease_owner from public.trade_orders where id = '$ORDER_2';")"
[[ "$reclaimed_owner" == "$WORKER_3" ]] || { echo "expired lease was reclaimed by an unexpected worker" >&2; exit 1; }

echo "[trade-recovery-leases] two parallel workers=2 unique claims; wrong-owner transitions=0; owner prepare/final=2 atomic events; expired lease reclaimed=1; exchange order POST=0"

"${PSQL[@]}" <<SQL
delete from public.trade_order_events where user_id = '$USER_ID' and order_id in ('$ORDER_1', '$ORDER_2');
delete from public.trade_orders where user_id = '$USER_ID' and id in ('$ORDER_1', '$ORDER_2');
delete from public.trade_order_plans where user_id = '$USER_ID' and id in ('$PLAN_1', '$PLAN_2');
SQL
