#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable trade atomicity verification}"
export PGPASSWORD

PSQL=(psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" --no-psqlrc --set=ON_ERROR_STOP=1)
WORK_DIR="$(mktemp -d)"
READY_FILE="$WORK_DIR/first-session-ready"
FIRST_SQL="$WORK_DIR/first.sql"
SECOND_SQL="$WORK_DIR/second.sql"
FIRST_OUT="$WORK_DIR/first.out"
SECOND_OUT="$WORK_DIR/second.out"
FIRST_ERR="$WORK_DIR/first.err"
SECOND_ERR="$WORK_DIR/second.err"
FIRST_PID=""

MEMBER_ID="11111111-1111-1111-1111-111111111111"
PLAN_ID="42000000-0000-0000-0000-000000000001"
FIRST_ORDER_ID="52000000-0000-0000-0000-000000000001"
SECOND_ORDER_ID="52000000-0000-0000-0000-000000000002"
FIRST_EVENT_ID="62000000-0000-0000-0000-000000000001"
SECOND_EVENT_ID="62000000-0000-0000-0000-000000000002"
FIRST_CLAIM_ID="72000000-0000-0000-0000-000000000001"
SECOND_CLAIM_ID="72000000-0000-0000-0000-000000000002"

cleanup_rows() {
  "${PSQL[@]}" --quiet --command "
    delete from public.trade_order_events where user_id = '$MEMBER_ID' and order_id in (
      select id from public.trade_orders where user_id = '$MEMBER_ID' and plan_id = '$PLAN_ID'
    );
    delete from public.trade_orders where user_id = '$MEMBER_ID' and plan_id = '$PLAN_ID';
    delete from public.trade_order_plans where user_id = '$MEMBER_ID' and id = '$PLAN_ID';
  " >/dev/null
}

cleanup() {
  if [[ -n "$FIRST_PID" ]] && kill -0 "$FIRST_PID" 2>/dev/null; then
    kill "$FIRST_PID" 2>/dev/null || true
    wait "$FIRST_PID" 2>/dev/null || true
  fi
  cleanup_rows || true
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

cleanup_rows
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
APPROVAL="$(date -u -d '+10 minutes' +%Y-%m-%dT%H:%M:%S.000Z)"

"${PSQL[@]}" --quiet --command "
  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, approval_expires_at)
  values (
    '$MEMBER_ID', '$PLAN_ID', 'rpc-concurrent-plan', 'APPROVAL_PENDING',
    jsonb_build_object(
      'id', '$PLAN_ID', 'userId', '$MEMBER_ID', 'state', 'APPROVAL_PENDING',
      'approvalExpiresAt', '$APPROVAL', 'updatedAt', '$NOW'
    ),
    '$APPROVAL'::timestamptz
  );
" >/dev/null

cat >"$FIRST_SQL" <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$MEMBER_ID';
select transitioned::text || '|' || order_inserted::text || '|' || execution_claimed::text
from public.submit_trade_plan_order(
  'APPROVAL_PENDING',
  jsonb_build_object(
    'id', '$PLAN_ID', 'userId', '$MEMBER_ID', 'state', 'SUBMITTED',
    'approvalExpiresAt', '$APPROVAL', 'updatedAt', '$NOW'
  ),
  jsonb_build_object(
    'id', '$FIRST_ORDER_ID', 'userId', '$MEMBER_ID', 'planId', '$PLAN_ID',
    'exchange', 'upbit', 'clientOrderId', 'rpc-concurrent-client', 'state', 'SUBMITTED',
    'createdAt', '$NOW', 'updatedAt', '$NOW'
  ),
  jsonb_build_object(
    'id', '$FIRST_EVENT_ID', 'userId', '$MEMBER_ID', 'orderId', '$FIRST_ORDER_ID',
    'fromState', null, 'toState', 'SUBMITTED', 'reason', 'ORDER_CREATED',
    'metadata', '{}'::jsonb, 'createdAt', '$NOW'
  ),
  '$FIRST_CLAIM_ID'
);
\! touch '$READY_FILE'
select pg_sleep(2);
commit;
SQL

cat >"$SECOND_SQL" <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$MEMBER_ID';
select transitioned::text || '|' || order_inserted::text || '|' || execution_claimed::text
from public.submit_trade_plan_order(
  'APPROVAL_PENDING',
  jsonb_build_object(
    'id', '$PLAN_ID', 'userId', '$MEMBER_ID', 'state', 'SUBMITTED',
    'approvalExpiresAt', '$APPROVAL', 'updatedAt', '$NOW'
  ),
  jsonb_build_object(
    'id', '$SECOND_ORDER_ID', 'userId', '$MEMBER_ID', 'planId', '$PLAN_ID',
    'exchange', 'upbit', 'clientOrderId', 'rpc-concurrent-client', 'state', 'SUBMITTED',
    'createdAt', '$NOW', 'updatedAt', '$NOW'
  ),
  jsonb_build_object(
    'id', '$SECOND_EVENT_ID', 'userId', '$MEMBER_ID', 'orderId', '$SECOND_ORDER_ID',
    'fromState', null, 'toState', 'SUBMITTED', 'reason', 'ORDER_CREATED',
    'metadata', '{}'::jsonb, 'createdAt', '$NOW'
  ),
  '$SECOND_CLAIM_ID'
);
commit;
SQL

"${PSQL[@]}" --quiet --tuples-only --no-align --file "$FIRST_SQL" >"$FIRST_OUT" 2>"$FIRST_ERR" &
FIRST_PID=$!

for _ in $(seq 1 100); do
  [[ -f "$READY_FILE" ]] && break
  if ! kill -0 "$FIRST_PID" 2>/dev/null; then
    cat "$FIRST_ERR" >&2
    echo "[trade-atomic-race] first database session exited before acquiring the plan lock" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$READY_FILE" ]]; then
  cat "$FIRST_ERR" >&2
  echo "[trade-atomic-race] first database session did not reach the locked transaction" >&2
  exit 1
fi

"${PSQL[@]}" --quiet --tuples-only --no-align --file "$SECOND_SQL" >"$SECOND_OUT" 2>"$SECOND_ERR"
wait "$FIRST_PID"
FIRST_PID=""

if ! grep -qx 'true|true|true' "$FIRST_OUT"; then
  cat "$FIRST_OUT" >&2
  cat "$FIRST_ERR" >&2
  echo "[trade-atomic-race] first session did not own the transition, insert, and execution claim" >&2
  exit 1
fi
if ! grep -qx 'false|false|false' "$SECOND_OUT"; then
  cat "$SECOND_OUT" >&2
  cat "$SECOND_ERR" >&2
  echo "[trade-atomic-race] second session acquired duplicate atomic work" >&2
  exit 1
fi

"${PSQL[@]}" --quiet --command "
  do \$trade_race_result\$
  begin
    if (select state from public.trade_order_plans where user_id = '$MEMBER_ID' and id = '$PLAN_ID') <> 'SUBMITTED' then
      raise exception 'concurrent atomic RPC did not leave the plan submitted';
    end if;
    if (select count(*) from public.trade_orders where user_id = '$MEMBER_ID' and plan_id = '$PLAN_ID') <> 1 then
      raise exception 'concurrent atomic RPC created more than one order';
    end if;
    if (select count(*) from public.trade_order_events candidate
        join public.trade_orders candidate_order
          on candidate_order.user_id = candidate.user_id and candidate_order.id = candidate.order_id
        where candidate.user_id = '$MEMBER_ID' and candidate_order.plan_id = '$PLAN_ID'
          and candidate.reason is null) > 0 then
      raise exception 'unexpected event projection detected';
    end if;
    if (select count(*) from public.trade_order_events candidate
        join public.trade_orders candidate_order
          on candidate_order.user_id = candidate.user_id and candidate_order.id = candidate.order_id
        where candidate.user_id = '$MEMBER_ID' and candidate_order.plan_id = '$PLAN_ID') <> 1 then
      raise exception 'concurrent atomic RPC created more than one event';
    end if;
    if (select count(*) from public.trade_orders where user_id = '$MEMBER_ID' and plan_id = '$PLAN_ID'
        and execution_claim_id = '$FIRST_CLAIM_ID') <> 1 then
      raise exception 'concurrent atomic RPC did not preserve the first execution claim';
    end if;
  end
  \$trade_race_result\$;
" >/dev/null

echo "[trade-atomic-race] two independent database sessions preserved one plan transition, order, event, and execution claim"
