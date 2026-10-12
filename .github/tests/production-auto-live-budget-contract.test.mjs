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
  assert.ok(source.includes('automatic_live_guard.expected_schema_fingerprint'));
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
