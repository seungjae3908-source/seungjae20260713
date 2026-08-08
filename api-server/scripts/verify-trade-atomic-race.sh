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
FIRST_ERR="$WORK_DIR/first.err"
SECOND_ERR="$WORK_DIR/second.err"
FIRST_PID=""

ADMIN_ID="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PLAN_ID="47000000-0000-0000-0000-000000000001"
FIRST_ORDER_ID="57000000-0000-0000-0000-000000000001"
SECOND_ORDER_ID="57000000-0000-0000-0000-000000000002"

cleanup_rows() {
  "${PSQL[@]}" --quiet --command "
    delete from public.trade_order_events where user_id = '$ADMIN_ID' and order_id in (
      select id from public.trade_orders where user_id = '$ADMIN_ID' and plan_id = '$PLAN_ID'
    );
    delete from public.trade_orders where user_id = '$ADMIN_ID' and plan_id = '$PLAN_ID';
    delete from public.trade_order_plans where user_id = '$ADMIN_ID' and id = '$PLAN_ID';
  " >/dev/null
}

cleanup() {
  if [[ -n "$FIRST_PID" ]] && kill -0 "$FIRST_PID" 2>/dev/null; then
    kill "$FIRST_PID" 2>/dev/null
    if ! wait "$FIRST_PID" 2>/dev/null; then :; fi
  fi
  if ! cleanup_rows; then :; fi
  rm -rf -- "$WORK_DIR"
}
trap cleanup EXIT

cleanup_rows

"${PSQL[@]}" --quiet --command "
  insert into public.trade_order_plans(user_id, id, idempotency_key, state, payload, version)
  values ('$ADMIN_ID', '$PLAN_ID', '0506-direct-race-plan', 'SUBMITTED', '{}', 0);
" >/dev/null

cat >"$FIRST_SQL" <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$ADMIN_ID';
insert into public.trade_orders(
  user_id, id, plan_id, exchange, client_order_id, state, payload, version
) values (
  '$ADMIN_ID', '$FIRST_ORDER_ID', '$PLAN_ID', 'upbit', '0506-direct-race-a', 'SUBMITTED', '{}', 0
);
\! touch '$READY_FILE'
select pg_sleep(2);
commit;
SQL

cat >"$SECOND_SQL" <<SQL
begin;
set local role authenticated;
set local request.jwt.claim.sub = '$ADMIN_ID';
insert into public.trade_orders(
  user_id, id, plan_id, exchange, client_order_id, state, payload, version
) values (
  '$ADMIN_ID', '$SECOND_ORDER_ID', '$PLAN_ID', 'upbit', '0506-direct-race-b', 'SUBMITTED', '{}', 0
);
commit;
SQL

"${PSQL[@]}" --quiet --file "$FIRST_SQL" >/dev/null 2>"$FIRST_ERR" &
FIRST_PID=$!

for _ in $(seq 1 100); do
  if [[ -f "$READY_FILE" ]]; then break; fi
  if ! kill -0 "$FIRST_PID" 2>/dev/null; then
    cat "$FIRST_ERR" >&2
    echo "[trade-atomic-race] first database session exited before holding the unique-key transaction" >&2
    exit 1
  fi
  sleep 0.05
done

if [[ ! -f "$READY_FILE" ]]; then
  cat "$FIRST_ERR" >&2
  echo "[trade-atomic-race] first database session did not reach the open transaction" >&2
  exit 1
fi

if "${PSQL[@]}" --quiet --file "$SECOND_SQL" >/dev/null 2>"$SECOND_ERR"; then
  echo "[trade-atomic-race] second direct non-split order unexpectedly succeeded" >&2
  exit 1
fi

wait "$FIRST_PID"
FIRST_PID=""

if ! grep -Eq 'duplicate key value|unique constraint|trade_orders_single_plan_unique_idx' "$SECOND_ERR"; then
  cat "$SECOND_ERR" >&2
  echo "[trade-atomic-race] second session failed for an unexpected reason" >&2
  exit 1
fi

"${PSQL[@]}" --quiet --command "
  do \$trade_race_result\$
  begin
    if (select count(*) from public.trade_orders
        where user_id = '$ADMIN_ID' and plan_id = '$PLAN_ID' and leg_id is null) <> 1 then
      raise exception '0506 non-split unique invariant did not preserve exactly one order';
    end if;
  end
  \$trade_race_result\$;
" >/dev/null

echo "[trade-atomic-race] two authenticated admin sessions preserved one non-split order at the table boundary; second insert rejected by 0506 unique invariant"
