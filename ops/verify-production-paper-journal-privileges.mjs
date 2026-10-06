import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assert(condition, message) {
  if (!condition) throw new Error(`[production-paper-journal-privileges] ${message}`);
}

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

function verifyStatic() {
  const script = read('ops/apply-production-paper-journal-privileges.mjs');
  const migration = read('api-server/supabase/migrations/2026080501_paper_journal_authenticated_privileges.sql');
  const workflow = read('.github/workflows/production-deploy.yml');
  const tables = [
    'paper_accounts', 'paper_orders', 'paper_positions', 'paper_fills',
    'paper_journal_entries', 'paper_sync_state',
  ];
  for (const table of tables) {
    assert(script.includes(`'${table}'`), `apply script omits ${table}`);
    assert(migration.includes(`public.${table}`), `migration omits ${table}`);
  }
  assert(script.includes("const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq'"), 'exact Production project binding missing');
  assert(script.includes('PAPER_JOURNAL_ROWS_CHANGED'), 'row-invariance assertion missing');
  assert(script.includes('PAPER_JOURNAL_POLICIES_CHANGED'), 'policy-invariance assertion missing');
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
  assert(workflow.includes('ops/verify-production-paper-journal-privileges.mjs --artifact'), 'artifact verification missing');
  assert(workflow.includes('printf \'%s\\n\' "$PROD_DATABASE_URL" | ssh'), 'database credential must use protected stdin transport');
  assert(workflow.includes('/tmp/paper-journal-privileges.*'), 'remote temporary directory allowlist missing');
  assert(workflow.indexOf('Require canonical Production trade schema and journal privileges before application mutation')
    < workflow.indexOf('Deploy exact approved revision'), 'privilege repair must precede application mutation');
}

function verifyArtifact(filePath) {
  const value = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
  assert(value?.schemaVersion === 'production-paper-journal-privileges-v1', 'schema version mismatch');
  assert(value?.status === 'passed', 'status is not passed');
  assert(/^[0-9a-f]{40}$/.test(value?.approved_target_sha), 'approved target SHA invalid');
  assert(value?.production_project_match === true, 'Production project mismatch');
  assert(value?.atomic_transaction === true, 'atomic transaction missing');
  assert(value?.migration_applied === 1, 'migration count mismatch');
  assert(value?.tables_verified === 6, 'table count mismatch');
  assert(value?.authenticated_crud_grants === 24, 'authenticated CRUD grants incomplete');
  assert(value?.anonymous_crud_grants === 0 && value?.public_crud_grants === 0, 'anonymous/PUBLIC grants exposed');
  assert(value?.rls_preserved === true, 'RLS not preserved');
  assert(value?.policies_mutated === false && value?.journal_rows_mutated === false, 'policy or row mutation detected');
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
