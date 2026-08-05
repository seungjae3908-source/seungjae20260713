#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# The full Staging Readiness workflow already applied the exact-SHA bootstrap
# atomically and wrote a sanitized verification artifact. Never run disposable
# rollback fixtures against the live staging database. Validate that evidence
# and retain rollback execution exclusively in disposable PostgreSQL CI.
if [[ -n "${DATABASE_URL:-}" ]]; then
  : "${STAGING_ARTIFACT_DIR:?STAGING_ARTIFACT_DIR is required for live staging evidence verification}"
  node - "$STAGING_ARTIFACT_DIR/staging-bootstrap-verification.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value.status !== 'passed') throw new Error('live staging bootstrap artifact did not pass');
if (value.schema_version !== '20260805.1') throw new Error('live staging bootstrap schema version mismatch');
if (value.atomic_transaction !== true) throw new Error('live staging bootstrap was not atomic');
if (value.idempotency_passes !== 2) throw new Error('live staging bootstrap did not run twice');
if (value.production_export_used !== false) throw new Error('live staging bootstrap used a production export');
if (value.auth_users_copied !== 0 || value.profile_rows_copied !== 0 || value.storage_objects_copied !== 0) {
  throw new Error('live staging bootstrap copied forbidden data');
}
if (value.credentials_recorded !== false) throw new Error('live staging bootstrap recorded credentials');
NODE
  node "$ROOT_DIR/api-server/scripts/verify-paper-journal-privilege-contract.mjs"
  node "$ROOT_DIR/api-server/scripts/verify-member-permission-audit-contract.mjs"
  echo "[phase8-db] live staging bootstrap evidence verified; rollback remains disposable-CI only"
  exit 0
fi

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=phase8}"
: "${PGDATABASE:=phase8}"
: "${PGPASSWORD:?PGPASSWORD is required for disposable Phase 8 verification}"
export PGPASSWORD

PSQL=(psql --host "$PGHOST" --port "$PGPORT" --username "$PGUSER" --dbname "$PGDATABASE" --no-psqlrc --set=ON_ERROR_STOP=1)
BOOTSTRAP_ARTIFACT_DIR="$(mktemp -d)"
cleanup() { rm -rf -- "$BOOTSTRAP_ARTIFACT_DIR"; }
trap cleanup EXIT

run_sql() {
  local label="$1"
  local path="$2"
  echo "[phase8-db] ${label}"
  "${PSQL[@]}" --file "${ROOT_DIR}/${path}"
}

set_atomic_fixture_tier() {
  local membership="$1"
  local role="$2"
  "${PSQL[@]}" --quiet --command "
    update public.profiles
    set membership_level = '${membership}', role = '${role}', permissions_updated_at = now()
    where id = '11111111-1111-1111-1111-111111111111';
  " >/dev/null
}

run_trade_atomic_suite() {
  # Existing deterministic atomicity fixtures use user 111... . Promote that
  # disposable fixture only for the duration of this suite, then restore its
  # regular tier before the remaining membership tests run.
  set_atomic_fixture_tier admin admin
  run_sql "verify admin trade plan and order atomicity contracts" "api-server/supabase/test/trade_automation_atomicity_integration.sql"
  echo "[phase8-db] verify two-session admin trade plan and order atomicity"
  bash "${ROOT_DIR}/api-server/scripts/verify-trade-atomic-race.sh"
  set_atomic_fixture_tier regular user
}

run_sql "create empty Supabase auth bootstrap harness" "api-server/supabase/test/staging_bootstrap_auth_harness.sql"

echo "[phase8-db] apply atomic two-pass isolated staging bootstrap"
CI=true \
STAGING_BOOTSTRAP_ALLOW_DISPOSABLE_CI=true \
STAGING_SUPABASE_URL=https://stagingbootstrapci.supabase.co \
STAGING_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
STAGING_ARTIFACT_DIR="$BOOTSTRAP_ARTIFACT_DIR" \
node "${ROOT_DIR}/api-server/scripts/apply-staging-supabase-bootstrap.mjs"

node - "$BOOTSTRAP_ARTIFACT_DIR/staging-bootstrap-verification.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
if (value.status !== 'passed') throw new Error('staging bootstrap artifact did not pass');
if (value.schema_version !== '20260805.1') throw new Error('staging bootstrap schema version mismatch');
if (value.atomic_transaction !== true) throw new Error('staging bootstrap was not atomic');
if (value.idempotency_passes !== 2) throw new Error('staging bootstrap did not run twice');
if (value.auth_users_copied !== 0 || value.profile_rows_copied !== 0 || value.storage_objects_copied !== 0) {
  throw new Error('staging bootstrap copied forbidden data');
}
NODE

run_sql "verify Auth profile trigger and deletion cascade" "api-server/supabase/test/staging_bootstrap_trigger_integration.sql"
run_sql "seed exact four-tier auth fixtures" "api-server/supabase/test/phase8_auth_harness.sql"
run_sql "apply Phase 7 migration idempotently" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql"
run_sql "apply Phase 8 permission migration idempotently" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
run_sql "apply Phase 8 paper capability RLS idempotently" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql"
run_sql "apply trade automation storage and RLS idempotently" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
run_sql "apply trade automation admin-only RLS idempotently" "api-server/supabase/migrations/2026080401_trade_automation_admin_only.sql"
run_sql "apply atomic trade execution RPC" "api-server/supabase/migrations/2026080402_trade_order_atomic_execution.sql"
run_sql "reapply atomic trade execution RPC idempotently" "api-server/supabase/migrations/2026080402_trade_order_atomic_execution.sql"
# Verify the service-only trading control before legacy Phase 8 fixtures grant
# broad table privileges for paper-journal RLS checks.
run_sql "execute trade automation admin-only ownership RLS queries" "api-server/supabase/test/trade_automation_admin_only_rls_integration.sql"
run_trade_atomic_suite
run_sql "execute real ownership RLS integration queries" "api-server/supabase/test/phase8_rls_integration.sql"
run_sql "execute real membership-tier RLS integration queries" "api-server/supabase/test/phase8_tier_rls_integration.sql"

# Reproduce the exact pre-fix privilege states in the disposable database, then
# prove the narrow API-role migrations and their idempotency contracts.
run_sql "rollback paper journal authenticated privileges" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.down.sql"
run_sql "assert pre-fix paper journal privilege failure" "api-server/supabase/test/paper_journal_privileges_before_migration.sql"
run_sql "rollback member permission audit authenticated privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.down.sql"
run_sql "assert pre-fix member permission audit privilege failure" "api-server/supabase/test/member_permission_audit_privileges_before_migration.sql"
run_sql "apply paper journal authenticated privileges" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql"
run_sql "reapply paper journal authenticated privileges idempotently" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql"
run_sql "apply member permission audit authenticated privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "reapply member permission audit authenticated privileges idempotently" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "verify paper journal authenticated privileges" "api-server/supabase/test/paper_journal_privileges_integration.sql"
run_sql "verify member permission audit privileges and administrator-only RLS" "api-server/supabase/test/member_permission_audit_privileges_integration.sql"

echo "[phase8-db] verify failed migration transaction leaves no partial object"
if "${PSQL[@]}" --command "begin; create table public.phase8_partial_failure_probe(id integer); select 1 / 0; commit;"; then
  echo "[phase8-db] expected transaction failure did not occur" >&2
  exit 1
fi
"${PSQL[@]}" --command "do \$\$ begin if to_regclass('public.phase8_partial_failure_probe') is not null then raise exception 'partial migration object remained'; end if; end \$\$;"

run_sql "rollback member permission audit authenticated privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.down.sql"
run_sql "rollback paper journal authenticated privileges" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.down.sql"
run_sql "rollback atomic trade execution RPC" "api-server/supabase/migrations/2026080402_trade_order_atomic_execution.down.sql"
run_sql "assert atomic trade execution rollback scope" "api-server/supabase/test/trade_automation_atomic_execution_rollback_assert.sql"
run_sql "rollback trade automation admin-only RLS" "api-server/supabase/migrations/2026080401_trade_automation_admin_only.down.sql"
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
run_sql "reapply trade automation admin-only RLS" "api-server/supabase/migrations/2026080401_trade_automation_admin_only.sql"
run_sql "reapply atomic trade execution RPC" "api-server/supabase/migrations/2026080402_trade_order_atomic_execution.sql"
run_sql "reapply paper journal authenticated privileges after rollback cycle" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql"
run_sql "reapply member permission audit authenticated privileges after rollback cycle" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "assert reapply state" "api-server/supabase/test/phase8_reapply_assert.sql"
run_sql "recheck paper journal authenticated privileges after reapply" "api-server/supabase/test/paper_journal_privileges_integration.sql"
run_sql "recheck member permission audit privileges after reapply" "api-server/supabase/test/member_permission_audit_privileges_integration.sql"
# Recheck the service-only trading control before the tier fixture re-grants all
# tables to the API roles for its isolated compatibility assertions.
run_sql "recheck trade automation admin-only RLS after reapply" "api-server/supabase/test/trade_automation_admin_only_rls_integration.sql"
run_trade_atomic_suite
run_sql "recheck membership-tier RLS after reapply" "api-server/supabase/test/phase8_tier_rls_integration.sql"

echo "[phase8-db] disposable database and atomic staging bootstrap verification completed"
