import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { productionBudgetConnection, productionBudgetMigrationBody, assertProductionBudgetReceipt } from '../../ops/apply-production-auto-live-budget.mjs';

const sha = 'a'.repeat(40);
const migration = 'api-server/supabase/migrations/20261012010706_automatic_live_atomic_budget.sql';
test('budget installer rejects wrong database identity and strips only one transaction envelope', () => {
  const safe = 'postgresql://postgres:fake-password@db.bawcbkoyovbeajkrnduq.supabase.co:5432/postgres';
  assert.equal(productionBudgetConnection(safe).database, 'postgres');
  for (const bad of [safe.replace('bawcbkoyovbeajkrnduq','wrong-project'), safe.replace(':5432',':6543'),
    safe.replace('/postgres','/other'), `${safe}?sslmode=disable`, safe.replace('fake-password','')]) {
    assert.throws(() => productionBudgetConnection(bad));
  }
  const source = readFileSync(migration, 'utf8');
  assert.ok(productionBudgetMigrationBody(source).includes('pg_advisory_xact_lock'));
  assert.throws(() => productionBudgetMigrationBody('begin;\nbegin;\ncommit;'));
});
test('budget install receipt cannot grant authority, mutate trading rows or reuse another SHA', () => {
  const receipt = { schemaVersion: 'production-auto-live-budget-install-v1', targetSha: sha, status: 'PASS',
    migrationSha256: 'b'.repeat(64), transactional: true, guardReady: true, userTradingRowsPreserved: true,
    reservationRowsPreserved: true, productionProjectMatch: true, orderRequests: 0, cancelRequests: 0,
    amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, liveTradingAuthorityGranted: false, autoTradingAuthorityGranted: false };
  assertProductionBudgetReceipt(receipt, sha);
  for (const patch of [{ targetSha: 'c'.repeat(40) }, { orderRequests: 1 }, { autoTradingAuthorityGranted: true },
    { userTradingRowsPreserved: false }, { reservationRowsPreserved: false }, { guardReady: false }]) {
    assert.throws(() => assertProductionBudgetReceipt({ ...receipt, ...patch }, sha));
  }
});
test('budget DDL is server-only and durable; no provider execution or expiration-based release is introduced', () => {
  const source = readFileSync(migration, 'utf8');
  const installer = readFileSync('ops/apply-production-auto-live-budget.mjs', 'utf8');
  assert.ok(source.includes("set default_transaction_isolation='serializable'"));
  assert.ok(source.includes("current_setting('transaction_isolation')<>'serializable'"));
  assert.ok(source.includes('from public,anon,authenticated'));
  assert.ok(source.includes('AUTOMATIC_LIVE_ATOMIC_BUDGET_CLAIM_REQUIRED'));
  assert.ok(source.includes('as restrictive for insert to authenticated'));
  assert.ok(source.includes('auto_live_server_update_guard'));
  assert.ok(source.includes('auto_live_server_delete_guard'));
  assert.ok(source.includes('CANONICAL_LIVE_AUTO_HANDOFF'));
  assert.ok(source.includes('AUTO_EXIT_ENTRY_PLAN:'));
  assert.ok(source.includes('automatic-live-atomic-budget-v3'));
  assert.ok(source.includes('automatic_live_budget_schema_fingerprint'));
  assert.ok(source.includes('pg_get_expr(p.polwithcheck,p.polrelid)'));
  assert.ok(source.includes('automatic_live_budget_expected_schema_fingerprint'));
  assert.ok(!source.includes('automatic_live_guard.expected_schema_fingerprint'));
  assert.ok(source.includes('max(amount_krw) amount_krw,max(risk_krw) risk_krw'));
  assert.ok(source.includes('AUTOMATIC_LIVE_BUDGET_CHARGE_LINEAGE_DRIFT'));
  assert.ok(installer.includes("is distinct from 'automatic-live-atomic-budget-v3'"));
  const repository = readFileSync('api-server/src/services/trade-automation.repository.ts', 'utf8');
  assert.ok(repository.includes("result.data?.version !== 'automatic-live-atomic-budget-v3'"));
  assert.ok(!source.includes('security definer'));
  assert.ok(!source.includes('expires_at'));
  assert.ok(installer.includes('autoTradingBackground?.enabled !== false'));
  assert.ok(installer.includes('USER_TRADING_ROWS_MUTATED'));
  assert.ok(installer.includes('BUDGET_RESERVATION_ROWS_MUTATED'));
  const deploy = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
  assert.ok(deploy.includes('environment: production'));
  assert.ok(deploy.includes('ops/apply-production-auto-live-budget.mjs'));
  assert.ok(deploy.includes('production-auto-live-budget-${{ env.TARGET_SHA }}'));
  assert.ok(deploy.indexOf('budget_command=') < deploy.indexOf('Destroy deployment authority before read-only QA'));
});

test('owner-bound baseline needs no custom-parameter privilege and cannot become a dynamic proof', () => {
  const source = readFileSync(migration, 'utf8');
  const rollback = readFileSync(migration.replace('.sql', '.down.sql'), 'utf8');
  const integration = readFileSync('api-server/supabase/test/automatic_live_atomic_budget_integration.sql', 'utf8');
  const harness = readFileSync('api-server/scripts/verify-phase8-db.sh', 'utf8');
  const gate = readFileSync('.github/workflows/production-automatic-trading-gate.yml', 'utf8');
  assert.ok(source.includes("regexp_replace(p.prosrc,'^select ''[0-9a-f]{32}''::text;$'"));
  assert.ok(source.includes("substring(p.prosrc from '^select ''([0-9a-f]{32})''::text;$')"));
  for (const role of ['service_role', 'authenticated', 'anon']) {
    assert.ok(source.includes(`not pg_has_role('${role}',p.proowner,'MEMBER')`));
  }
  assert.ok(source.includes("'language',p.prolang"));
  assert.ok(source.includes("to_regprocedure('public.automatic_live_budget_expected_schema_fingerprint()')"));
  assert.ok(!/grant\s+(?:set|all).*on\s+parameter/iu.test(source));
  assert.ok(!/alter\s+(?:role|user).*superuser/iu.test(source));
  assert.ok(rollback.includes('drop function if exists public.automatic_live_budget_expected_schema_fingerprint()'));
  for (const probe of ['ROLLBACK_BASELINE_LITERAL_PROBE', 'ROLLBACK_DYNAMIC_BASELINE_PROBE',
    'ROLLBACK_BASELINE_ACL_PROBE', 'ROLLBACK_MISSING_BASELINE_PROBE', 'ROLLBACK_BASELINE_OWNER_PROBE']) {
    assert.ok(integration.includes(probe));
  }
  assert.ok(integration.includes('server replaced owner-bound baseline'));
  assert.ok(integration.includes('authenticated obtained owner-bound baseline'));
  assert.ok(harness.includes('phase8_budget_owner nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls'));
  assert.ok(harness.includes("has_parameter_privilege(current_user,'automatic_live_guard.expected_schema_fingerprint','SET')"));
  assert.ok(harness.includes('set role phase8_budget_owner;'));
  assert.ok(gate.includes('node --test .github/tests/production-auto-live-budget-contract.test.mjs'));
  for (const path of [migration, migration.replace('.sql', '.down.sql'),
    'api-server/supabase/test/automatic_live_atomic_budget_integration.sql', 'api-server/scripts/verify-phase8-db.sh']) {
    assert.ok(gate.includes(`      - ${path}`));
  }
});

test('sealed schema proof reads catalog metadata only, never account rows or credentials', () => {
  const source = readFileSync(migration, 'utf8');
  const proof = source.slice(source.indexOf('create or replace function public.automatic_live_budget_expected_schema_fingerprint()'));
  assert.ok(proof.includes('from pg_proc'));
  assert.ok(proof.includes('from pg_class'));
  assert.doesNotMatch(proof, /\bfrom\s+public\.(?:trade_|\w*credential|\w*vault)/iu);
  assert.doesNotMatch(proof, /\b(?:encrypted_credentials|api_key|apikey|passphrase|authorization|access_sign)\b/iu);
  assert.ok(proof.includes('from public,anon,authenticated'));
  assert.doesNotMatch(proof, /\b(?:raise\s+notice|copy\b|http_|net\.http|dblink)/iu);
});
