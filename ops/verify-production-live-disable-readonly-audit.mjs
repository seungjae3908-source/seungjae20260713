#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const workflowPath = path.join(root, '.github/workflows/production-live-trading-gate.yml');
const auditPath = path.join(root, 'ops/production-live-disable-readonly-audit.sh');
const specPath = path.join(root, 'stock-analyzer/e2e/production-account-readonly-live-qa.spec.ts');

const COUNT_KEYS = [
  'productionProcessCount', 'duplicateWorkers', 'workerExecutingCount',
  'activeLocalOrderCount', 'staleSubmittedOrderCount', 'staleApprovalPlanCount',
  'duplicateClientOrderIdCount', 'activeExecutionClaimCount', 'activeRecoveryLeaseCount',
];
const SAFE_PROVIDER_COUNTERS = [
  'openOrderCount', 'orphanOrderCount', 'activeLocalOrderCount', 'staleLocalOrderCount',
  'duplicateClientOrderIdCount', 'stalePlanCount', 'bitgetActivePositionCount',
  'oppositePositionDuplicateCount', 'nonIsolatedPositionCount',
  'outOfPolicyLeveragePositionCount', 'liquidationRiskPositionCount',
];
const FORBIDDEN_PATTERNS = [
  /postgres(?:ql)?:\/\//iu,
  /\b(?:password|passwd|secret|authorization|accountUid|clientOrderId|exchangeOrderId)\b\s*[=:]/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
];

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function read(file) { return fs.readFileSync(file, 'utf8'); }

function assertSanitizedBlockers(value) {
  assert(Array.isArray(value), 'sanitizedBlockers must be an array');
  assert(value.length <= 50, 'sanitizedBlockers exceeds bound');
  for (const item of value) {
    assert(item && typeof item === 'object' && !Array.isArray(item), 'blocker must be an object');
    assert(Object.keys(item).sort().join(',') === 'provider,state,symbol', 'blocker keys are not bounded');
    assert(/^[a-z0-9_-]{1,16}$/u.test(item.provider), 'blocker provider is not sanitized');
    assert(/^[A-Z0-9._/-]{1,32}$/u.test(item.symbol), 'blocker symbol is not sanitized');
    assert(/^[A-Z0-9_/-]{1,64}$/u.test(item.state), 'blocker state is not sanitized');
  }
}

function assertBaseEvidence(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'artifact must be an object');
  assert(value.schemaVersion === 'production-live-disable-readonly-audit-v1', 'schema version mismatch');
  assert(/^[0-9a-f]{40}$/u.test(value.targetSha), 'targetSha mismatch');
  assert(value.readOnlyEnforced === true, 'readOnlyEnforced must be true');
  assert(value.rawSecretValuesExposed === false, 'rawSecretValuesExposed must be false');
  assert(value.rawAccountValuesExposed === false, 'rawAccountValuesExposed must be false');
  assert(value.mutationRequests?.orders === 0, 'orders must be zero');
  assert(value.mutationRequests?.cancels === 0, 'cancels must be zero');
  assert(value.mutationRequests?.amends === 0, 'amends must be zero');
  assert(value.mutationRequests?.transfers === 0, 'transfers must be zero');
  assert(value.mutationRequests?.withdrawals === 0, 'withdrawals must be zero');
  for (const key of COUNT_KEYS) assert(Number.isInteger(value[key]) && value[key] >= 0, `${key} invalid`);
  assertSanitizedBlockers(value.sanitizedBlockers);
  const serialized = JSON.stringify(value);
  for (const pattern of FORBIDDEN_PATTERNS) assert(!pattern.test(serialized), `sensitive artifact pattern: ${pattern}`);
}

function assertDatabaseArtifact(value) {
  assertBaseEvidence(value);
  if (value.status === 'SAFE') {
    assert(value.code === null, 'safe code must be null');
    assert(value.productionProcessCount === 1, 'safe audit requires one process');
    for (const key of COUNT_KEYS.filter((key) => key !== 'productionProcessCount')) {
      assert(value[key] === 0, `safe audit requires ${key}=0`);
    }
    assert(value.sanitizedBlockers.length === 0, 'safe audit cannot contain blockers');
  } else {
    assert(value.status === 'BLOCKED', 'invalid audit status');
    assert(typeof value.code === 'string' && value.code.length > 0, 'blocked audit requires code');
  }
}

function assertProviderArtifact(value) {
  assert(value?.schemaVersion === 'production-live-disable-readonly-audit-v1', 'provider schema mismatch');
  assert(value?.auditPurpose === 'PRE_DISABLE_SAFETY', 'provider audit purpose mismatch');
  assert(/^[0-9a-f]{40}$/u.test(value?.targetSha), 'provider target SHA invalid');
  assert(value?.officialProductionOrigin === true, 'provider origin not proven');
  assert(value?.authenticatedProductionSession === true, 'provider session not proven');
  assert(value?.secretValuesRecorded === false, 'provider secret values recorded');
  assert(value?.accountValuesRecorded === false, 'provider account values recorded');
  for (const key of ['orderRequests', 'cancelRequests', 'amendRequests', 'transferRequests', 'withdrawalRequests', 'blockedMutationRequests', 'observedAppMutationRequests']) {
    assert(value?.[key] === 0, `${key} must be zero`);
  }
  assert(value?.realOrderSubmitted === false, 'realOrderSubmitted must be false');
  assert(value?.liveTradingAuthorityGranted === false, 'QA must not grant live authority');
  assert(value?.autoTradingAuthorityGranted === false, 'QA must not grant auto authority');
  assert(JSON.stringify(value?.testedProviders) === JSON.stringify(['bitget', 'kiwoom', 'toss', 'upbit']), 'all four providers required');
  for (const key of SAFE_PROVIDER_COUNTERS) assert(value?.safetyCounters?.[key] === 0, `${key} must be zero`);
  assertSanitizedBlockers(value?.sanitizedBlockers);
  assert(value.sanitizedBlockers.length === 0, 'safe provider audit cannot contain blockers');
  for (const provider of value.providers ?? []) {
    assert(['bitget', 'kiwoom', 'toss', 'upbit'].includes(provider?.provider), 'provider invalid');
    assert(provider.connected === true && provider.status === 'CONNECTED', `${provider.provider} not connected`);
    assert(provider.stale === false && provider.fresh === true, `${provider.provider} not fresh`);
    assert(provider.errorCode === null && provider.reconciliationPassed === true, `${provider.provider} reconciliation failed`);
    assert(provider.openOrderCount === 0, `${provider.provider} open orders exist`);
  }
  const serialized = JSON.stringify(value);
  for (const pattern of FORBIDDEN_PATTERNS) assert(!pattern.test(serialized), `sensitive provider artifact pattern: ${pattern}`);
}

function verifyStaticContract() {
  const workflow = read(workflowPath);
  const audit = read(auditPath);
  const spec = read(specPath);
  for (const token of [
    'Fresh four-provider pre-disable read-only audit',
    'Require global internal-order and worker idle evidence before any disable',
    'Disable in safe order: automatic, futures, spot, background worker',
    'Post-disable four-provider read-only audit',
    'BLOCKED_LIVE_STATE_NOT_TERMINAL',
    'ops/production-live-disable-readonly-audit.sh',
    'ops/verify-production-live-disable-readonly-audit.mjs',
    '--provider-artifact production-live-disable-pre-artifacts/production-account-readonly-live-qa.json',
    "CRYPTO_AUTO_LEGACY_EXECUTION_ENABLED: 'false'",
  ]) assert(workflow.includes(token), `workflow token missing: ${token}`);
  assert(workflow.indexOf('Fresh four-provider pre-disable read-only audit') < workflow.indexOf('Disable in safe order: automatic, futures, spot, background worker'), 'provider audit must precede disable');
  assert(workflow.indexOf('Require global internal-order and worker idle evidence before any disable') < workflow.indexOf('Disable in safe order: automatic, futures, spot, background worker'), 'global audit must precede disable');
  assert(workflow.indexOf('Disable in safe order: automatic, futures, spot, background worker') < workflow.indexOf('Post-disable four-provider read-only audit'), 'post audit must follow disable');
  assert(workflow.includes('environment: production'), 'protected environment missing');
  assert(workflow.includes("rm -f -- ~/.ssh/id_ed25519"), 'SSH key cleanup missing');
  assert(audit.startsWith('#!/usr/bin/env bash'), 'audit shebang missing');
  assert(audit.includes('set -Eeuo pipefail'), 'strict shell mode missing');
  assert(!audit.includes('set -x'), 'shell tracing forbidden');
  assert(audit.includes("PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000'"), 'read-only PGOPTIONS missing');
  assert(audit.includes("'BEGIN READ ONLY;'"), 'read-only transaction missing');
  const sqlStart = audit.indexOf('const SQL = [');
  const sqlEnd = audit.indexOf("].join('\\n');", sqlStart);
  assert(sqlStart >= 0 && sqlEnd > sqlStart, 'hardcoded SQL block missing');
  const sql = audit.slice(sqlStart, sqlEnd).toUpperCase();
  for (const word of ['INSERT ', 'UPDATE ', 'DELETE ', 'ALTER ', 'CREATE ', 'DROP ', 'TRUNCATE ', 'GRANT ', 'REVOKE ', 'CALL ', 'COPY ']) {
    assert(!sql.includes(word), `mutating SQL forbidden: ${word.trim()}`);
  }
  assert(spec.includes('PRODUCTION_LIVE_DISABLE_READONLY_AUDIT'), 'provider recovery mode missing');
  assert(spec.includes("name === 'bitgetActivePositionCount'"), 'active futures position recovery gate missing');
  assert(spec.includes('sanitizedBlockers'), 'sanitized provider blockers missing');

  const safe = {
    schemaVersion: 'production-live-disable-readonly-audit-v1', targetSha: 'a'.repeat(40), status: 'SAFE', code: null,
    readOnlyEnforced: true, rawSecretValuesExposed: false, rawAccountValuesExposed: false,
    mutationRequests: { orders: 0, cancels: 0, amends: 0, transfers: 0, withdrawals: 0 },
    productionProcessCount: 1, duplicateWorkers: 0, workerExecutingCount: 0,
    activeLocalOrderCount: 0, staleSubmittedOrderCount: 0, staleApprovalPlanCount: 0,
    duplicateClientOrderIdCount: 0, activeExecutionClaimCount: 0, activeRecoveryLeaseCount: 0,
    sanitizedBlockers: [], runtimeFlags: {},
  };
  assertDatabaseArtifact(safe);
  let rejected = false;
  try { assertDatabaseArtifact({ ...safe, activeExecutionClaimCount: 1 }); } catch { rejected = true; }
  assert(rejected, 'unsafe active claim artifact passed');
  process.stdout.write('production live-disable read-only audit static contract passed\n');
}

const [mode, file] = process.argv.slice(2);
try {
  if (mode === '--static') verifyStaticContract();
  else if (mode === '--artifact' && file) {
    assertDatabaseArtifact(JSON.parse(read(path.resolve(file))));
    process.stdout.write('production live-disable database artifact verified\n');
  } else if (mode === '--provider-artifact' && file) {
    assertProviderArtifact(JSON.parse(read(path.resolve(file))));
    process.stdout.write('production live-disable provider artifact verified\n');
  } else fail('usage: --static | --artifact <file> | --provider-artifact <file>');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
