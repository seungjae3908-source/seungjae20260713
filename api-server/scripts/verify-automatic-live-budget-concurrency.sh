#!/usr/bin/env bash
set -euo pipefail

# Mock ledger only, two real PostgreSQL connections, no provider transport.
# Reject every live/Staging connection rather than trusting the caller's label.
[[ "${CI:-}" == "true" && -z "${DATABASE_URL:-}" && "${PGDATABASE:-phase8}" == "phase8" && "${PGUSER:-phase8}" == "phase8" ]] || {
  echo "AUTO_LIVE_BUDGET_CONCURRENCY_DISPOSABLE_CI_ONLY" >&2; exit 1;
}
[[ "${PGHOST:-127.0.0.1}" == "127.0.0.1" || "${PGHOST:-127.0.0.1}" == "localhost" ]] || {
  echo "AUTO_LIVE_BUDGET_CONCURRENCY_LOOPBACK_ONLY" >&2; exit 1;
}
: "${PGPASSWORD:?Disposable CI database password is required}"
export PGPASSWORD
export PGCONNECT_TIMEOUT=10
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(psql --host "${PGHOST:-127.0.0.1}" --port "${PGPORT:-5432}" --username "${PGUSER:-phase8}" --dbname "${PGDATABASE:-phase8}" --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --quiet)
TMP_DIR="$(mktemp -d)"
cleanup() {
  # Exact synthetic IDs only. Never remove an owner or an account baseline.
  "${PSQL[@]}" <<'SQL' >/dev/null
begin;
delete from public.trade_live_budget_reservations where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and order_id in ('57000000-0000-0000-0000-000000000001','57000000-0000-0000-0000-000000000002');
delete from public.trade_orders where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id in ('57000000-0000-0000-0000-000000000001','57000000-0000-0000-0000-000000000002');
delete from public.trade_order_plans where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  and id in ('47000000-0000-0000-0000-000000000001','47000000-0000-0000-0000-000000000002');
commit;
SQL
  rm -rf -- "$TMP_DIR"
}
trap cleanup EXIT

# Reuse the canonical mock plan/order fixtures up to (not including) their
# transactional assertions. Do not copy or replace the owner's policy.
{
  awk '
    /^do \$admission\$/ { exit }
    /^insert into public.trade_automation_profiles/ { skip=1 }
    skip && /^on conflict/ { skip=0; next }
    !skip { print }
  ' "$ROOT_DIR/api-server/supabase/test/automatic_live_atomic_budget_integration.sql"
  printf '\ncommit;\n'
} | "${PSQL[@]}" >/dev/null

# Deterministic rendezvous: both transactions must take their MVCC snapshots
# and actually wait on this gate before either can reserve. A timed sleep alone
# can accidentally exercise sequential requests and falsely certify a race.
stdbuf -oL "${PSQL[@]}" >"$TMP_DIR/barrier" 2>"$TMP_DIR/barrier-error" <<'SQL' &
select pg_advisory_lock(714123001::bigint);
select 'BARRIER_READY';
do $barrier$
declare deadline timestamptz:=clock_timestamp()+interval '8 seconds';
begin
  loop
    exit when (select count(*) from pg_locks where locktype='advisory'
      and classid=0 and objid=714123001 and objsubid=1 and mode='ShareLock' and not granted)=2;
    if clock_timestamp()>deadline then raise exception 'BUDGET_RACE_TWO_SNAPSHOTS_NOT_OBSERVED'; end if;
    perform pg_sleep(0.02);
  end loop;
end $barrier$;
select pg_advisory_unlock(714123001::bigint);
SQL
barrier_pid="$!"
barrier_deadline=$((SECONDS + 8))
until grep -q '^BARRIER_READY$' "$TMP_DIR/barrier"; do
  kill -0 "$barrier_pid" 2>/dev/null && (( SECONDS < barrier_deadline )) || {
    echo "AUTO_LIVE_BUDGET_RACE_BARRIER_START_FAILED" >&2; exit 1;
  }
  sleep 0.02
done

worker() {
  local n="$1" attempt result
  # Retry only PostgreSQL 40001, which confirms rollback of the whole DB
  # transaction. Unknown transport/permission/DDL errors are not retried.
  for attempt in 1 2 3; do
    if result="$("${PSQL[@]}" --set=VERBOSITY=verbose 2>"$TMP_DIR/error-$n" <<SQL
begin isolation level serializable;
select set_config('request.jwt.claim.sub','',true);
do \$race\$
declare snap jsonb; projection jsonb; response jsonb;
begin
  snap:=public.read_automatic_live_budget_snapshot('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  -- The coordinator releases only after BOTH real connections are waiting.
  perform pg_advisory_xact_lock_shared(714123001::bigint);
  projection:=jsonb_build_object('userId','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'orderId','57000000-0000-0000-0000-00000000000$n',
    'planId','47000000-0000-0000-0000-00000000000$n','expectedVersion',0,
    'market','crypto_spot','instrument','upbit:KRW:BUDGET$n','strategy','budget-test',
    'amountKrw',70000,'riskKrw',700,'baseCharges','[]'::jsonb,'releases','[]'::jsonb,
    'limits',jsonb_build_object('total',400000,'market',100000,'instrument',100000,
      'strategy',400000,'risk',8000,'positions',8,'order',100000));
  response:=public.reserve_automatic_live_entry_budget('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '57000000-0000-0000-0000-00000000000$n','67000000-0000-0000-0000-00000000000$n',snap,projection,false);
  if response->>'status'='SNAPSHOT_STALE' then
    raise exception using errcode='40001',message='SNAPSHOT_STALE_ROLLBACK';
  end if;
  if response->>'status'='RESERVED' then
    perform set_config('auto_live_test.result','RESERVED',true);
  elsif response->>'blockCode'='AUTOMATIC_LIVE_BUDGET_MARKET_EXCEEDED' then
    perform set_config('auto_live_test.result','BLOCKED',true);
  else raise exception 'unexpected race result: %',response; end if;
end \$race\$;
select current_setting('auto_live_test.result');
commit;
SQL
    )"; then
      [[ "$result" == $'\nRESERVED' || "$result" == $'\nBLOCKED' || "$result" == 'RESERVED' || "$result" == 'BLOCKED' ]] || {
        echo "AUTO_LIVE_BUDGET_RACE_RESULT_INVALID" >&2; return 1;
      }
      printf '%s\n' "$result" | sed '/^$/d'; return 0
    fi
    if ! grep -q 'ERROR:  40001:' "$TMP_DIR/error-$n"; then
      echo "AUTO_LIVE_BUDGET_RACE_NON_SERIALIZATION_FAILURE" >&2
      cat "$TMP_DIR/error-$n" >&2; return 1
    fi
  done
  echo "AUTO_LIVE_BUDGET_RACE_SERIALIZATION_BOUND_EXCEEDED" >&2; return 1
}
worker 1 >"$TMP_DIR/worker-1" & first_pid="$!"
worker 2 >"$TMP_DIR/worker-2" & second_pid="$!"
first_status=0; second_status=0; barrier_status=0
wait "$first_pid" || first_status=$?
wait "$second_pid" || second_status=$?
wait "$barrier_pid" || barrier_status=$?
(( first_status == 0 && second_status == 0 && barrier_status == 0 )) || {
  echo "AUTO_LIVE_BUDGET_RACE_CONNECTION_FAILED" >&2; exit 1;
}
[[ "$(grep -l '^RESERVED$' "$TMP_DIR/worker-1" "$TMP_DIR/worker-2" | wc -l)" -eq 1 ]]
[[ "$(grep -l '^BLOCKED$' "$TMP_DIR/worker-1" "$TMP_DIR/worker-2" | wc -l)" -eq 1 ]]
actual="$("${PSQL[@]}" --command "select count(*)||':'||sum(amount_krw)::text from public.trade_live_budget_reservations where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and state='HELD';")"
[[ "$actual" == '1:70000.00' ]]
claims="$("${PSQL[@]}" --command "select count(*) from public.trade_orders where user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and id in ('57000000-0000-0000-0000-000000000001','57000000-0000-0000-0000-000000000002') and execution_claim_id is not null;")"
[[ "$claims" == '1' ]]
echo "AUTO_LIVE_ATOMIC_BUDGET_TWO_CONNECTION_RACE_PASS; FINANCIAL_API_CALLS=0"
