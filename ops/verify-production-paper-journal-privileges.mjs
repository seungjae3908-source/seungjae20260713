import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { classifyProductionPaperJournalPrivilegeFailure } from './classify-production-paper-journal-privilege-failure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) throw new Error(`[production-paper-journal-privileges] ${message}`);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function verifyStatic() {
  const script = read('ops/apply-production-paper-journal-privileges.mjs');
  const classifier = read('ops/classify-production-paper-journal-privilege-failure.mjs');
  const tablesMigration = read('api-server/supabase/migrations/2026080201_journal_sync_analytics_phase7.sql');
  const policyMigration = read('api-server/supabase/migrations/2026080203_phase8_paper_capability_rls.sql');
  const migration = read('api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql');
  const workflow = read('.github/workflows/production-deploy.yml');
  const tables = [
    'paper_accounts', 'paper_orders', 'paper_positions', 'paper_fills',
    'paper_journal_entries', 'paper_sync_state',
  ];
  for (const table of tables) {
    assert(script.includes(`'${table}'`), `apply script omits ${table}`);
    assert(tablesMigration.includes(`public.${table}`), `table bootstrap omits ${table}`);
    assert(policyMigration.includes(`'${table}'`), `policy bootstrap omits ${table}`);
    assert(migration.includes(`public.${table}`), `migration omits ${table}`);
  }
  assert(script.includes("const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq'"), 'exact Production project binding missing');
  assert(script.includes("'begin isolation level repeatable read;'"), 'stable Production snapshot is missing');
  assert(script.includes('__PAPER_JOURNAL_PHASE__:preflight'), 'safe preflight failure marker missing');
  assert(script.includes('__PAPER_JOURNAL_PHASE__:table_bootstrap'), 'safe table bootstrap marker missing');
  assert(script.includes('__PAPER_JOURNAL_PHASE__:policy_repair'), 'safe policy repair marker missing');
  assert(script.includes('__PAPER_JOURNAL_PHASE__:privileges'), 'safe privilege marker missing');
  assert(script.includes('__PAPER_JOURNAL_PHASE__:verification'), 'safe verification failure marker missing');
  assert(script.includes("lines.findLast((line) => line.startsWith('{') && line.endsWith('}'))"),
    'sanitized artifact parser must tolerate trailing phase markers');
  assert(script.includes('classifyProductionPaperJournalPrivilegeFailure(result)'), 'sanitized database failure classifier missing');
  assert(!classifier.includes('console.'), 'failure classifier must not print database stderr');
  assert(classifyProductionPaperJournalPrivilegeFailure({ stderr: 'ERROR: PAPER_JOURNAL_ROWS_CHANGED' })
    === 'paper_journal_rows_changed_in_transaction', 'row drift classification mismatch');
  assert(classifyProductionPaperJournalPrivilegeFailure({ stderr: 'ERROR: PAPER_JOURNAL_PARTIAL_SCHEMA:3' })
    === 'paper_journal_partial_schema', 'partial schema classification mismatch');
  assert(classifyProductionPaperJournalPrivilegeFailure({ stderr: 'ERROR: PAPER_JOURNAL_POLICY_CONTRACT_INVALID:25:24' })
    === 'paper_journal_policy_contract_invalid', 'policy contract classification mismatch');
  assert(classifyProductionPaperJournalPrivilegeFailure({ stderr: 'ERROR: canceling statement due to lock timeout' })
    === 'database_lock_timeout', 'lock timeout classification mismatch');
  assert(classifyProductionPaperJournalPrivilegeFailure({ stdout: '__PAPER_JOURNAL_PHASE__:table_bootstrap\n', stderr: 'ERROR: unknown' })
    === 'atomic_table_bootstrap_failed', 'phase fallback classification mismatch');
  assert(classifyProductionPaperJournalPrivilegeFailure({ error: new Error('spawn failed') })
    === 'psql_process_failed', 'process failure classification mismatch');
  assert(script.includes('PAPER_JOURNAL_ROWS_CHANGED'), 'row-invariance assertion missing');
  assert(script.includes('PAPER_JOURNAL_POLICY_CONTRACT_INVALID'), 'membership policy verification missing');
  assert(script.includes('PAPER_JOURNAL_COLUMN_CONTRACT_INVALID'), 'column verification missing');
  assert(script.includes('PAPER_JOURNAL_PRIMARY_KEY_INVALID'), 'primary key verification missing');
  assert(script.includes("'authenticated_crud_grants',24"), 'authenticated CRUD verification missing');
  assert(script.includes("'anonymous_crud_grants',0"), 'anonymous denial verification missing');
  assert(script.includes("'public_crud_grants',0"), 'PUBLIC denial verification missing');
  assert(script.includes('privilege.grantee = 0'), 'PUBLIC ACL verification missing');
  assert(script.includes("'order_submitted',false"), 'zero-order evidence missing');
  assert(script.includes("'withdrawal_submitted',false"), 'zero-withdrawal evidence missing');
  assert(!/console\.(?:log|error)\([^\n]*(?:PROD_DATABASE_URL|PGPASSWORD)/.test(script), 'database secret may be logged');
  assert(migration.includes('from public, anon;'), 'PUBLIC/anon revoke missing');
  assert(migration.includes('to authenticated;'), 'authenticated grant missing');
  assert(workflow.includes('Require canonical Production trade schema and journal privileges before application mutation'), 'Production deploy apply step missing');
  assert(workflow.includes('ops/apply-production-paper-journal-privileges.mjs'), 'Production deploy invocation missing');
  assert(workflow.includes('ops/classify-production-paper-journal-privilege-failure.mjs'), 'sanitized failure classifier is not packaged');
  assert(workflow.includes('2026080201_journal_sync_analytics_phase7.sql'), 'Production table bootstrap is not packaged');
  assert(workflow.includes('2026080203_phase8_paper_capability_rls.sql'), 'Production policy bootstrap is not packaged');
  assert(workflow.includes('ops/verify-production-paper-journal-privileges.mjs --artifact'), 'artifact verification missing');
  assert(workflow.includes('printf \'%s\\n\' "$PROD_DATABASE_URL" | ssh'), 'database credential must use protected stdin transport');
  assert(workflow.includes('/tmp/paper-journal-privileges.*'), 'remote temporary directory allowlist missing');
  assert(workflow.indexOf('Require canonical Production trade schema and journal privileges before application mutation')
    < workflow.indexOf('Deploy exact approved revision'), 'privilege repair must precede application mutation');
}

function verifyArtifact(filePath) {
  const value = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
  assert(value?.schemaVersion === 'production-paper-journal-storage-v2', 'schema version mismatch');
  assert(value?.status === 'passed', 'status is not passed');
  assert(/^[0-9a-f]{40}$/.test(value?.approved_target_sha), 'approved target SHA invalid');
  const disposableCi = process.env.CI === 'true'
    && process.env.PRODUCTION_PAPER_JOURNAL_ALLOW_DISPOSABLE_CI === 'true';
  if (disposableCi) {
    assert(value?.production_project_match === false && value?.disposable_ci === true
      && value?.database_endpoint_type === 'disposable-ci', 'disposable CI binding mismatch');
  } else {
    assert(value?.production_project_match === true && value?.disposable_ci === false
      && ['direct', 'pooler'].includes(value?.database_endpoint_type), 'Production project mismatch');
  }
  assert(value?.atomic_transaction === true, 'atomic transaction missing');
  assert([0, 6].includes(value?.tables_before), 'preflight table count mismatch');
  assert(value?.tables_created === 6 - value?.tables_before, 'created table count mismatch');
  assert(value?.tables_verified === 6, 'table count mismatch');
  assert(value?.table_contract_verified === true, 'table contract was not verified');
  assert(value?.policy_contract_verified === true, 'policy contract was not verified');
  assert(value?.authenticated_crud_grants === 24, 'authenticated CRUD grants incomplete');
  assert(value?.anonymous_crud_grants === 0 && value?.public_crud_grants === 0, 'anonymous/PUBLIC grants exposed');
  assert(value?.rls_preserved === true, 'RLS not preserved');
  assert(value?.journal_rows_mutated === false, 'journal row mutation detected');
  assert(value?.credentials_read === false && value?.raw_credentials_exposed === false, 'credential safety failed');
  for (const field of ['order_submitted', 'cancel_submitted', 'amend_submitted', 'transfer_submitted', 'withdrawal_submitted']) {
    assert(value?.[field] === false, `${field} must be false`);
  }
  assert(value?.private_trading_api_count === 0, 'private trading API count must be zero');
  assert(value?.live_trading_authority_granted === false, 'LIVE authority was granted');
  assert(value?.auto_trading_authority_granted === false, 'AUTO authority was granted');
  const serialized = JSON.stringify(value);
  assert(!/postgres(?:ql)?:\/\//i.test(serialized), 'database URL exposed');
  assert(!/-----BEGIN .*PRIVATE KEY-----/.test(serialized), 'private key exposed');
}

const [mode, argument] = process.argv.slice(2);
if (mode === '--static' && !argument) {
  verifyStatic();
  console.log('[production-paper-journal-privileges] static contract verified');
} else if (mode === '--artifact' && argument) {
  verifyArtifact(argument);
  console.log('[production-paper-journal-privileges] sanitized artifact verified');
} else {
  throw new Error('usage: verify-production-paper-journal-privileges.mjs --static | --artifact <file>');
}
