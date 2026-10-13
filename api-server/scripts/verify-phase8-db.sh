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
if (value.admin_v2_rls_verified !== true) throw new Error('live staging admin V2 RLS guard was not verified');
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

run_budget_owner_sql() {
  # Only the disposable budget install changes its effective role. No hosted
  # database/parameter privilege is granted, and the migration gets no superuser.
  [[ "${CI:-}" == "true" && "$PGDATABASE" == "phase8" && "$PGUSER" == "phase8"
    && ( "$PGHOST" == "127.0.0.1" || "$PGHOST" == "localhost" ) ]] || {
    echo '[phase8-db] budget owner test requires disposable loopback CI' >&2; exit 1;
  }
  local label="$1" path="$2"
  # Absolute paths are reserved for generated disposable CI SQL; repository
  # migrations continue to resolve relative to the immutable checkout.
  local source_file="$path"
  if [[ "$path" != /* ]]; then source_file="${ROOT_DIR}/${path}"; fi
  [[ -f "$source_file" ]] || { echo '[phase8-db] budget SQL source missing' >&2; exit 1; }
  echo "[phase8-db] ${label}"
  {
    printf 'set role phase8_budget_owner;\n'
    printf "%s\n" "do \$owner\$ begin
      if (select rolsuper or rolcreatedb or rolcreaterole or rolbypassrls from pg_roles where rolname=current_user)
        or has_parameter_privilege(current_user,'automatic_live_guard.expected_schema_fingerprint','SET')
      then raise exception 'BUDGET_INSTALL_ROLE_MUST_HAVE_NO_SUPERUSER_OR_PARAMETER_AUTHORITY'; end if;
    end \$owner\$;"
    cat "$source_file"
    printf '\nreset role;\n'
  } | "${PSQL[@]}"
}

run_production_paper_gate() {
  local label="$1"
  local expected_tables_before="$2"
  local expected_policies_before="${3:-}"
  local artifact="$BOOTSTRAP_ARTIFACT_DIR/production-paper-journal-${label}.json"
  echo "[phase8-db] verify protected Production paper gate: ${label}"
  CI=true \
  PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI=true \
  APPROVED_TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  PROD_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
  node "${ROOT_DIR}/ops/apply-production-paper-journal-privileges.mjs" > "$artifact"
  CI=true \
  PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI=true \
  node "${ROOT_DIR}/ops/verify-production-paper-journal-privileges.mjs" --artifact "$artifact"
  node - "$artifact" "$expected_tables_before" "$expected_policies_before" <<'NODE'
const fs = require('node:fs');
const [file, expectedRaw, expectedPoliciesRaw] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(file, 'utf8'));
const expected = Number(expectedRaw);
if (value.tables_before !== expected) throw new Error(`tables_before ${value.tables_before} != ${expected}`);
if (value.tables_created !== 6 - expected) throw new Error('tables_created mismatch');
if (value.database_changed !== (expected === 0)) throw new Error('database_changed mismatch');
if (value.journal_rows_mutated !== false) throw new Error('journal rows were mutated');
if (expectedPoliciesRaw && value.policies_before !== Number(expectedPoliciesRaw)) {
  throw new Error('predeploy gate did not encounter the expected V2 policy state');
}
if (expectedPoliciesRaw && value.policies_repaired !== false) {
  throw new Error('canonical V2 protection policies must not be rewritten');
}
if (value.policy_contract_verified !== true || value.table_contract_verified !== true) {
  throw new Error('Production paper contract verification missing');
}
NODE
}

assert_production_paper_partial_schema_fails() {
  local stdout_file="$BOOTSTRAP_ARTIFACT_DIR/production-paper-journal-partial.stdout"
  local stderr_file="$BOOTSTRAP_ARTIFACT_DIR/production-paper-journal-partial.stderr"
  echo "[phase8-db] verify protected Production paper gate rejects partial schema"
  "${PSQL[@]}" --command 'create table public.paper_accounts (id text primary key);'
  if CI=true \
    PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI=true \
    APPROVED_TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    PROD_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
    node "${ROOT_DIR}/ops/apply-production-paper-journal-privileges.mjs" \
      > "$stdout_file" 2> "$stderr_file"; then
    echo '[phase8-db] partial Production paper schema unexpectedly passed' >&2
    exit 1
  fi
  grep -Fx '[production-paper-journal-privileges] paper_journal_partial_schema' "$stderr_file"
  "${PSQL[@]}" --command 'drop table public.paper_accounts;'
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

run_production_paper_gate "existing-schema-noop" 6

assert_production_paper_v2_tamper_fails() {
  local stdout_file="$BOOTSTRAP_ARTIFACT_DIR/v2-guard-tamper.stdout"
  local stderr_file="$BOOTSTRAP_ARTIFACT_DIR/v2-guard-tamper.stderr"
  echo "[phase8-db] verify Paper privilege gate rejects permissive admin V2 policy tampering"
  "${PSQL[@]}" --command "alter policy admin_v2_paper_wallet_insert_guard on public.paper_accounts with check (true);"
  if CI=true \
    PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI=true \
    APPROVED_TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    PROD_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
    node "${ROOT_DIR}/ops/apply-production-paper-journal-privileges.mjs" \
      > "$stdout_file" 2> "$stderr_file"; then
    echo '[phase8-db] insecure V2 Paper wallet policy unexpectedly passed' >&2
    exit 1
  fi
  grep -Fx '[production-paper-journal-privileges] paper_journal_policy_contract_invalid' "$stderr_file"
  run_sql "restore administrator V2 Paper write barriers" \
    "api-server/supabase/migrations/2026100901_admin_four_paper_wallet_rls_guard.sql"
}
assert_production_paper_v2_tamper_fails

run_sql "verify legacy personal Telegram policy cleanup" "api-server/supabase/test/personal_telegram_policy_cleanup_integration.sql"

run_sql "verify Auth profile trigger and deletion cascade" "api-server/supabase/test/staging_bootstrap_trigger_integration.sql"
run_sql "seed exact four-tier auth fixtures" "api-server/supabase/test/phase8_auth_harness.sql"

# Regression: a successful rollout installed member V2 guards after the old
# privilege check. The NEXT deployment then rejected its valid 30-policy DB.
# Exercise that exact post-rollout state with a nonempty journal and prove
# repeat deployments preserve every row and policy, not just their counts.
run_sql "apply member V2 protections for post-rollout redeploy regression" \
  "api-server/supabase/migrations/2026101001_member_four_market_paper_wallet_guard.sql"
"${PSQL[@]}" --command "insert into public.paper_journal_entries(user_id,id,payload) values ('11111111-1111-1111-1111-111111111111','redeploy-contract-probe','{\"retained\":true}');"
paper_redeploy_fingerprint() {
  "${PSQL[@]}" --tuples-only --no-align --command "select md5(coalesce((select string_agg(row_to_json(j)::text, '|' order by user_id,id) from public.paper_journal_entries j),'')), md5((select string_agg(row_to_json(p)::text, '|' order by tablename,policyname) from pg_catalog.pg_policies p where schemaname='public' and tablename in ('paper_accounts','paper_orders','paper_positions','paper_fills','paper_journal_entries','paper_sync_state')));"
}
redeploy_before="$(paper_redeploy_fingerprint)"
run_production_paper_gate "admin-member-v2-noop" 6 30
run_production_paper_gate "admin-member-v2-repeat-noop" 6 30
[[ "$(paper_redeploy_fingerprint)" == "$redeploy_before" ]] || {
  echo '[phase8-db] V2 redeploy changed journal rows or RLS policies' >&2; exit 1;
}

assert_production_member_v2_contract_fails() {
  local label="$1"
  local mutation_sql="$2"
  local stdout_file="$BOOTSTRAP_ARTIFACT_DIR/member-v2-${label}.stdout"
  local stderr_file="$BOOTSTRAP_ARTIFACT_DIR/member-v2-${label}.stderr"
  echo "[phase8-db] verify protected member V2 contract rejects ${label}"
  "${PSQL[@]}" --command "$mutation_sql"
  if CI=true \
    PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI=true \
    APPROVED_TARGET_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
    PROD_DATABASE_URL="postgresql://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}" \
    node "${ROOT_DIR}/ops/apply-production-paper-journal-privileges.mjs" \
      > "$stdout_file" 2> "$stderr_file"; then
    echo '[phase8-db] unsafe member V2 contract unexpectedly passed' >&2; exit 1;
  fi
  grep -Fx '[production-paper-journal-privileges] paper_journal_policy_contract_invalid' "$stderr_file"
  run_sql "restore member V2 protection contract" \
    "api-server/supabase/migrations/2026101001_member_four_market_paper_wallet_guard.sql"
}
assert_production_paper_v2_tamper_fails
assert_production_member_v2_contract_fails "insert-tamper" \
  "alter policy member_v2_paper_wallet_insert_guard on public.paper_accounts with check (true);"
assert_production_member_v2_contract_fails "update-tamper" \
  "alter policy member_v2_paper_wallet_update_guard on public.paper_accounts using (true) with check (true);"
assert_production_member_v2_contract_fails "delete-tamper" \
  "alter policy member_v2_paper_wallet_delete_guard on public.paper_accounts using (true);"
assert_production_member_v2_contract_fails "missing-wallet-guard" \
  "drop policy member_v2_paper_wallet_insert_guard on public.paper_accounts;"
assert_production_member_v2_contract_fails "wrong-role" \
  "alter policy member_v2_paper_wallet_insert_guard on public.paper_accounts to anon;"
assert_production_member_v2_contract_fails "missing-canonical-order-guard" \
  "drop policy member_v2_auto_paper_insert_guard on public.trade_orders;"
assert_production_member_v2_contract_fails "unexpected-extra-policy" \
  "create policy unexpected_redeploy_policy on public.paper_accounts for select to authenticated using (true);"
"${PSQL[@]}" --command "drop policy unexpected_redeploy_policy on public.paper_accounts;"
run_production_paper_gate "restored-admin-member-v2-noop" 6 30
[[ "$(paper_redeploy_fingerprint)" == "$redeploy_before" ]] || {
  echo '[phase8-db] V2 rejection/restore changed journal rows or RLS policies' >&2; exit 1;
}
"${PSQL[@]}" --command "delete from public.paper_journal_entries where user_id='11111111-1111-1111-1111-111111111111' and id='redeploy-contract-probe';"

# Reproduce the exact pre-fix privilege states on the disposable CI database,
# then prove the new migrations alone restore the intended API-role access.
run_sql "remove paper API-role privileges for pre-migration reproduction" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.down.sql"
run_sql "assert pre-migration paper privilege failure" "api-server/supabase/test/paper_journal_privileges_before_migration.sql"
run_sql "remove audit API-role privileges for pre-migration reproduction" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.down.sql"
run_sql "assert pre-migration audit privilege failure" "api-server/supabase/test/member_permission_audit_privileges_before_migration.sql"
run_sql "apply Phase 7 migration idempotently" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql"
run_sql "apply Phase 8 permission migration idempotently" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
run_sql "apply Phase 8 paper capability RLS idempotently" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql"
run_sql "apply trade automation storage and RLS idempotently" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
run_sql "apply trade automation safety hardening" "api-server/supabase/migrations/2026080502_trade_automation_safety_hardening.sql"
run_sql "reapply trade automation safety hardening idempotently" "api-server/supabase/migrations/2026080502_trade_automation_safety_hardening.sql"
run_sql "apply recovery worker lease fencing" "api-server/supabase/migrations/2026080503_trade_recovery_worker_leases.sql"
run_sql "reapply recovery worker lease fencing idempotently" "api-server/supabase/migrations/2026080503_trade_recovery_worker_leases.sql"
run_sql "apply provider submission intent fence" "api-server/supabase/migrations/2026080504_trade_pre_submission_fence.sql"
run_sql "reapply provider submission intent fence idempotently" "api-server/supabase/migrations/2026080504_trade_pre_submission_fence.sql"
run_sql "apply split child order storage and sequencing" "api-server/supabase/migrations/2026080505_trade_split_child_orders.sql"
run_sql "reapply split child order storage and sequencing idempotently" "api-server/supabase/migrations/2026080505_trade_split_child_orders.sql"
run_sql "apply authenticated paper privileges" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql"
run_sql "reapply authenticated paper privileges idempotently" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql"
run_sql "apply authenticated audit privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "reapply authenticated audit privileges idempotently" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "verify trade automation atomicity, CAS, leases, legs, and protection schema" "api-server/supabase/test/trade_automation_safety_hardening_integration.sql"
echo "[phase8-db] verify order idempotency, execution claims, submission intent, and recovery worker leases"
bash "${ROOT_DIR}/api-server/scripts/verify-trade-automation-concurrency.sh"
run_sql "verify explicit paper privileges and anon denial" "api-server/supabase/test/paper_journal_privileges_integration.sql"
run_sql "verify audit privileges and administrator-only RLS" "api-server/supabase/test/member_permission_audit_privileges_integration.sql"
run_sql "execute pre-0506 trade automation ownership RLS queries" "api-server/supabase/test/trade_automation_rls_integration.sql"
run_sql "execute real ownership RLS integration queries" "api-server/supabase/test/phase8_rls_integration.sql"
run_sql "execute real membership-tier RLS integration queries" "api-server/supabase/test/phase8_tier_rls_integration.sql"

run_sql "apply final trade order atomicity and admin-only RLS" "api-server/supabase/migrations/2026080506_trade_order_atomicity_admin_rls.sql"
run_sql "reapply final trade order atomicity and admin-only RLS idempotently" "api-server/supabase/migrations/2026080506_trade_order_atomicity_admin_rls.sql"
run_sql "verify final trade order atomicity and admin-only RLS" "api-server/supabase/test/trade_order_atomicity_admin_rls_integration.sql"
# Match the hosted migration's owner privileges without changing other suites.
# These are empty/synthetic CI tables, never a Production ownership change.
[[ "${CI:-}" == "true" && "$PGDATABASE" == "phase8" && "$PGUSER" == "phase8"
  && ( "$PGHOST" == "127.0.0.1" || "$PGHOST" == "localhost" ) ]] || {
  echo '[phase8-db] budget owner fixture requires disposable loopback CI' >&2; exit 1;
}
"${PSQL[@]}" <<'SQL'
do $owner_fixture$ declare relation text; routine text; begin
  if not exists(select 1 from pg_roles where rolname='phase8_budget_owner') then
    create role phase8_budget_owner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  foreach relation in array array['trade_automation_profiles','trade_system_controls','trade_order_plans',
    'trade_orders','trade_order_events','trade_order_legs','trade_protection_orders','trade_live_budget_reservations'] loop
    if to_regclass('public.'||relation) is null then continue; end if;
    execute format('alter table public.%I owner to phase8_budget_owner',relation);
  end loop;
  -- The bootstrap can already have installed the budget once as the CI admin.
  -- Transfer every canonical routine too, so the restricted-owner reapply is
  -- a real ownership-compatible upgrade, not only an empty-schema install.
  for routine in select p.oid::regprocedure::text from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
      'claim_trade_order_execution','read_automatic_live_budget_snapshot','reserve_automatic_live_entry_budget',
      'is_automatic_live_ledger_payload','automatic_live_budget_schema_fingerprint','read_automatic_live_budget_guard',
      'automatic_live_budget_expected_schema_fingerprint') loop
    execute format('alter function %s owner to phase8_budget_owner',routine);
  end loop;
end $owner_fixture$;
grant usage, create on schema public to phase8_budget_owner;
grant usage on schema auth to phase8_budget_owner;
SQL
run_budget_owner_sql "apply AUTO LIVE atomic budget guard as non-superuser owner" "api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql"
run_budget_owner_sql "reapply AUTO LIVE atomic budget guard idempotently as non-superuser owner" "api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql"
# Exercise the *same complete SQL transaction as the human-gated Production
# installer* in a disposable Phase8 database. The previous isolated migration
# tests could miss privileges used only by the install wrapper.
GENERATED_BUDGET_INSTALL_SQL="$BOOTSTRAP_ARTIFACT_DIR/production-budget-install-transaction.sql"
(
  cd "$ROOT_DIR"
  node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { productionBudgetInstallationSql } from './ops/apply-production-auto-live-budget.mjs';
const source = readFileSync('api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql','utf8');
process.stdout.write(productionBudgetInstallationSql(source, 'a'.repeat(40)));
NODE
) > "$GENERATED_BUDGET_INSTALL_SQL"
run_budget_owner_sql "verify exact Production installer transaction under non-superuser role" "$GENERATED_BUDGET_INSTALL_SQL"
run_sql "verify AUTO LIVE budget, claim atomicity and ACL" "api-server/supabase/test/automatic_live_atomic_budget_integration.sql"
bash "${ROOT_DIR}/api-server/scripts/verify-automatic-live-budget-concurrency.sh"
run_sql "apply risk envelope and atomic pending-split cancellation" "api-server/supabase/migrations/2026080801_trade_risk_envelope_kill_switch.sql"
run_sql "reapply risk envelope and atomic pending-split cancellation idempotently" "api-server/supabase/migrations/2026080801_trade_risk_envelope_kill_switch.sql"
run_sql "verify risk envelope invariant and fast-move split cancellation" "api-server/supabase/test/trade_risk_envelope_kill_switch_integration.sql"
run_sql "apply canonical member investment schema and RLS" "api-server/supabase/migrations/2026082705_member_investment_canonical.sql"
run_sql "reapply canonical member investment schema idempotently" "api-server/supabase/migrations/2026082705_member_investment_canonical.sql"
run_sql "verify member investment ownership, LIVE lock, vault isolation, and LONG/SHORT model" "api-server/supabase/test/member_investment_canonical_integration.sql"
echo "[phase8-db] verify concurrent fast-move split cancellation race"
bash "${ROOT_DIR}/api-server/scripts/verify-trade-split-cancel-concurrency.sh"

echo "[phase8-db] verify failed migration transaction leaves no partial object"
if "${PSQL[@]}" --command "begin; create table public.phase8_partial_failure_probe(id integer); select 1 / 0; commit;"; then
  echo "[phase8-db] expected transaction failure did not occur" >&2
  exit 1
fi
"${PSQL[@]}" --command "do \$\$ begin if to_regclass('public.phase8_partial_failure_probe') is not null then raise exception 'partial migration object remained'; end if; end \$\$;"

run_sql "rollback risk envelope and atomic pending-split cancellation" "api-server/supabase/migrations/2026080801_trade_risk_envelope_kill_switch.down.sql"
run_sql "rollback canonical member investment schema" "api-server/supabase/migrations/2026082705_member_investment_canonical.down.sql"
run_sql "assert canonical member investment rollback cleanup" "api-server/supabase/test/member_investment_canonical_rollback_assert.sql"
run_sql "assert risk envelope rollback cleanup" "api-server/supabase/test/trade_risk_envelope_kill_switch_rollback_assert.sql"
run_sql "rollback final trade order atomicity and admin-only RLS" "api-server/supabase/migrations/2026080506_trade_order_atomicity_admin_rls.down.sql"
run_sql "rollback empty AUTO LIVE atomic budget guard" "api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.down.sql"
run_sql "rollback authenticated audit privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.down.sql"
run_sql "rollback authenticated paper privileges" "api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.down.sql"
run_sql "rollback split child order storage and sequencing" "api-server/supabase/migrations/2026080505_trade_split_child_orders.down.sql"
run_sql "rollback provider submission intent fence" "api-server/supabase/migrations/2026080504_trade_pre_submission_fence.down.sql"
run_sql "rollback recovery worker lease fencing" "api-server/supabase/migrations/2026080503_trade_recovery_worker_leases.down.sql"
run_sql "rollback trade automation safety hardening" "api-server/supabase/migrations/2026080502_trade_automation_safety_hardening.down.sql"
run_sql "rollback trade automation migration" "api-server/supabase/migrations/2026080301_trade_automation_integration.down.sql"
run_sql "assert trade automation rollback cleanup" "api-server/supabase/test/trade_automation_rollback_assert.sql"
run_sql "rollback Phase 8 paper capability RLS" "api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.down.sql"
run_sql "rollback Phase 8 permission migration" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.down.sql"
run_sql "rollback Phase 7 migration" "api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.down.sql"
run_sql "assert rollback cleanup" "api-server/supabase/test/phase8_rollback_assert.sql"
run_sql "reapply Phase 8 permission migration" "api-server/supabase/migrations/2026080202_release_candidate_permissions_phase8.sql"
assert_production_paper_partial_schema_fails
run_production_paper_gate "missing-schema-bootstrap" 0
run_production_paper_gate "post-bootstrap-noop" 6
run_sql "reapply trade automation migration" "api-server/supabase/migrations/2026080301_trade_automation_integration.sql"
run_sql "reapply trade automation safety hardening" "api-server/supabase/migrations/2026080502_trade_automation_safety_hardening.sql"
run_sql "reapply recovery worker lease fencing" "api-server/supabase/migrations/2026080503_trade_recovery_worker_leases.sql"
run_sql "reapply provider submission intent fence" "api-server/supabase/migrations/2026080504_trade_pre_submission_fence.sql"
run_sql "reapply split child order storage and sequencing" "api-server/supabase/migrations/2026080505_trade_split_child_orders.sql"
run_sql "reapply authenticated audit privileges" "api-server/supabase/migrations/2026080502_member_permission_audit_authenticated_privileges.sql"
run_sql "reapply final trade order atomicity and admin-only RLS" "api-server/supabase/migrations/2026080506_trade_order_atomicity_admin_rls.sql"
run_sql "reapply AUTO LIVE atomic budget guard" "api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql"
run_sql "recheck AUTO LIVE budget, claim atomicity and ACL" "api-server/supabase/test/automatic_live_atomic_budget_integration.sql"
bash "${ROOT_DIR}/api-server/scripts/verify-automatic-live-budget-concurrency.sh"
run_sql "reapply risk envelope and atomic pending-split cancellation" "api-server/supabase/migrations/2026080801_trade_risk_envelope_kill_switch.sql"
run_sql "reapply canonical member investment schema" "api-server/supabase/migrations/2026082705_member_investment_canonical.sql"
run_sql "assert reapply state" "api-server/supabase/test/phase8_reapply_assert.sql"
run_sql "recheck explicit paper privileges after reapply" "api-server/supabase/test/paper_journal_privileges_integration.sql"
run_sql "recheck audit privileges and administrator-only RLS after reapply" "api-server/supabase/test/member_permission_audit_privileges_integration.sql"
run_sql "recheck final trade order atomicity and admin-only RLS after reapply" "api-server/supabase/test/trade_order_atomicity_admin_rls_integration.sql"
run_sql "recheck risk envelope invariant and fast-move split cancellation after reapply" "api-server/supabase/test/trade_risk_envelope_kill_switch_integration.sql"
run_sql "recheck canonical member investment storage and RLS after reapply" "api-server/supabase/test/member_investment_canonical_integration.sql"
echo "[phase8-db] recheck concurrent fast-move split cancellation race after reapply"
bash "${ROOT_DIR}/api-server/scripts/verify-trade-split-cancel-concurrency.sh"
run_sql "recheck membership-tier RLS after reapply" "api-server/supabase/test/phase8_tier_rls_integration.sql"

run_sql "apply member S/AI access hardening" "api-server/supabase/migrations/2026100601_member_access_s_ai_hardening.sql"
run_sql "reapply member S/AI access hardening idempotently" "api-server/supabase/migrations/2026100601_member_access_s_ai_hardening.sql"
run_sql "apply member SECURITY DEFINER privilege lockdown" "api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql"
run_sql "reapply member SECURITY DEFINER privilege lockdown idempotently" "api-server/supabase/migrations/2026100801_member_security_definer_lockdown.sql"
run_sql "verify associate analytics RLS and membership expiry" "api-server/supabase/test/member_access_s_ai_hardening_integration.sql"

echo "[phase8-db] disposable database and atomic staging bootstrap verification completed"
