import { readFileSync } from 'node:fs';
import process from 'node:process';
const mode = process.argv[2] ?? '';
function fail(code) { console.error('[verify-production-admin-four-paper-rls] ' + code); process.exit(1); }
if (mode === '--static') {
  const workflow = readFileSync('.github/workflows/production-deploy.yml', 'utf8');
  const helper = readFileSync('ops/apply-production-admin-four-paper-rls.mjs','utf8');
  const migration = readFileSync('api-server/supabase/migrations/2026100901_admin_four_paper_wallet_rls_guard.sql','utf8');
  for (const token of [
    'ops/apply-production-admin-four-paper-rls.mjs',
    'node ops/verify-production-admin-four-paper-rls.mjs --artifact',
    'admin_paper_rls_artifact=',
    'production-admin-four-paper-rls-',
  ]) if (!workflow.includes(token)) fail('PRODUCTION_DEPLOY_GUARD_MISSING');
  for (const token of [
    'PRODUCTION_DATABASE_IDENTITY_INVALID','lock_timeout','statement_timeout',
    'pg_advisory_xact_lock', 'set transaction isolation level repeatable read',
    'production-admin-four-paper-rls-v1','adminV2RlsVerified',
    'ATOMIC_MIGRATION_FAILED_ROLLED_BACK','APPROVED_TARGET_SHA_REQUIRED',
    'privateProviderRequests','historicalWalletRowsPreserved',
  ]) if (!helper.includes(token)) fail('MIGRATION_RUNNER_GUARD_MISSING');
  for (const token of [
    'security invoker','admin_four_paper_wallet_rls_guard_ready',
    'as restrictive','revoke truncate','automatic-paper-admin-v2:',
    'begin;','commit;',
  ]) if (!migration.toLowerCase().includes(token.toLowerCase())) fail('MIGRATION_SQL_GUARD_MISSING');
  if (!workflow.includes('node ops/verify-production-admin-four-paper-rls.mjs --static')) fail('STATIC_GATE_NOT_REGISTERED');
  console.log('PRODUCTION_ADMIN_PAPER_V2_RLS_STATIC_SAFE');
} else if (mode === '--artifact') {
  const path = process.argv[3];
  if (!path) fail('RECEIPT_PATH_REQUIRED');
  let artifact;
  try { artifact=JSON.parse(readFileSync(path,'utf8')); } catch { fail('RECEIPT_INVALID'); }
  const sha = String(process.env.TARGET_SHA ?? '').toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha) ||
    artifact?.schemaVersion !== 'production-admin-four-paper-rls-v1' ||
    artifact?.status !== 'passed' || artifact?.approvedTargetSha !== sha ||
    artifact?.adminV2RlsVerified !== true || artifact?.transactional !== true ||
    artifact?.productionProjectMatch !== true ||
    artifact?.historicalWalletRowsPreserved !== true ||
    artifact?.paperTradePlanRowsPreserved !== true ||
    artifact?.paperJournalRowsPreserved !== true ||
    artifact?.walletsCreated !== 0 || artifact?.ordersCreated !== 0 ||
    artifact?.privateProviderRequests !== 0 || artifact?.liveTradingEnabled !== false) {
    fail('PRODUCTION_ADMIN_V2_ATTESTATION_INVALID');
  }
  console.log('PRODUCTION_ADMIN_PAPER_V2_RLS_VERIFIED');
} else fail('USAGE_STATIC_OR_ARTIFACT');
