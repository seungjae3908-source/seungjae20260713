#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable Phase 8 verification}"
export PGPASSWORD

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PSQL=(psql --host "${PGHOST}" --port "${PGPORT}" --username "${PGUSER}" --dbname "${PGDATABASE}" --no-psqlrc --set=ON_ERROR_STOP=1)

run_sql() {
  local label="$1"
  local path="$2"
  echo "[phase8-db] ${label}"
  "${PSQL[@]}" --file "${ROOT_DIR}/${path}"
}

run_sql "create isolated auth harness" "api-server/supabase/test/phase8_auth_harness.sql"
run_sql "apply Phase 7 migration" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql"
run_sql "apply Phase 8 permission migration" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
run_sql "apply Phase 8 paper capability RLS" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql"
run_sql "apply trade automation storage and RLS" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
run_sql "re-run Phase 7 migration idempotently" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql"
run_sql "re-run Phase 8 permission migration idempotently" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
run_sql "re-run Phase 8 paper capability RLS idempotently" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql"
run_sql "re-run trade automation migration idempotently" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
# Verify the service-only trading control before the legacy Phase 8 harness grants
# broad table privileges for its own paper-journal RLS checks.
run_sql "execute trade automation ownership RLS queries" "api-server/supabase/test/trade_automation_rls_integration.sql"
run_sql "execute real ownership RLS integration queries" "api-server/supabase/test/phase8_rls_integration.sql"
run_sql "execute real membership-tier RLS integration queries" "api-server/supabase/test/phase8_tier_rls_integration.sql"

echo "[phase8-db] verify failed migration transaction leaves no partial object"
if "${PSQL[@]}" --command "begin; create table public.phase8_partial_failure_probe(id integer); select 1 / 0; commit;"; then
  echo "[phase8-db] expected transaction failure did not occur" >&2
  exit 1
fi
"${PSQL[@]}" --command "do \$\$ begin if to_regclass('public.phase8_partial_failure_probe') is not null then raise exception 'partial migration object remained'; end if; end \$\$;"

run_sql "rollback trade automation migration" "api-server/supabase/migrations/2026080301_trade_automation_integration.down.sql"
run_sql "assert trade automation rollback cleanup" "api-server/supabase/test/trade_automation_rollback_assert.sql"
run_sql "rollback Phase 8 paper capability RLS" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.down.sql"
run_sql "rollback Phase 8 permission migration" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.down.sql"
run_sql "rollback Phase 7 migration" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.down.sql"
run_sql "assert rollback cleanup" "api-server/supabase/test/phase8_rollback_assert.sql"
run_sql "reapply Phase 7 migration" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql"
run_sql "reapply Phase 8 permission migration" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
run_sql "reapply Phase 8 paper capability RLS" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql"
run_sql "reapply trade automation migration" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
run_sql "assert reapply state" "api-server/supabase/test/phase8_reapply_assert.sql"
run_sql "recheck membership-tier RLS after reapply" "api-server/supabase/test/phase8_tier_rls_integration.sql"
run_sql "recheck trade automation RLS after reapply" "api-server/supabase/test/trade_automation_rls_integration.sql"

echo "[phase8-db] disposable database verification completed"
