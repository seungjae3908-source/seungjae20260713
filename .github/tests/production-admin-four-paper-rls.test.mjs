import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TARGET_SHA = 'a'.repeat(40);
const CHECKER = 'ops/verify-production-admin-four-paper-rls.mjs';
function verify(mode, path) {
  return spawnSync(process.execPath, [CHECKER, mode, ...(path ? [path] : [])], {
    encoding: 'utf8', env: { PATH: process.env.PATH ?? '', TARGET_SHA },
  });
}
test('protected production Paper V2 RLS source contract is scoped and fail closed', () => {
  const r = verify('--static');
  assert.equal(r.status, 0, r.stderr);
});
test('sanitized migration attestation accepts exact SHA only and no user row writes', () => {
  const dir = mkdtempSync(join(tmpdir(),'paper-v2-attest-'));
  try {
    const receipt = {
      schemaVersion:'production-admin-four-paper-rls-v1',
      status:'passed', approvedTargetSha:TARGET_SHA, adminV2RlsVerified:true,
      memberV2RlsVerified:true,memberV2WalletRowsPreserved:true,
      transactional:true,productionProjectMatch:true,
      historicalWalletRowsPreserved:true,paperTradePlanRowsPreserved:true,
      paperJournalRowsPreserved:true,walletsCreated:0,ordersCreated:0,
      privateProviderRequests:0,liveTradingEnabled:false,
    };
    const file = join(dir,'attestation.json');
    writeFileSync(file, JSON.stringify(receipt));
    assert.equal(verify('--artifact',file).status,0);
    for(const invalid of [
      {adminV2RlsVerified:false}, {memberV2RlsVerified:false},
      {memberV2WalletRowsPreserved:false}, {walletsCreated:4}, {ordersCreated:1},
      {liveTradingEnabled:true}, {approvedTargetSha:'b'.repeat(40)},
      {paperJournalRowsPreserved:false},{privateProviderRequests:1},
    ]){
      writeFileSync(file,JSON.stringify({...receipt,...invalid}));
      assert.notEqual(verify('--artifact',file).status,0);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});


test('member RLS and admin RLS share the same atomic protected transaction, never a second unapproved deploy', () => {
  const runner = readFileSync('ops/apply-production-admin-four-paper-rls.mjs','utf8');
  const workflow = readFileSync('.github/workflows/production-deploy.yml','utf8');
  const prerequisite = runner.indexOf('memberPreflightSql,');
  const admin = runner.indexOf('  migration,', prerequisite);
  const member = runner.indexOf('  memberMigration,', admin);
  const verifyAdmin = runner.indexOf('  verifySql,', member);
  const verifyMember = runner.indexOf('  memberVerifySql,', verifyAdmin);
  assert.ok(prerequisite > 0 && admin > prerequisite && member > admin
    && verifyAdmin > member && verifyMember > verifyAdmin);
  assert.match(runner, /PRODUCTION_MEMBER_V2_ADMIN_GUARD_REQUIRED/);
  assert.match(runner, /PRODUCTION_MEMBER_V2_RLS_GUARD_UNVERIFIED/);
  assert.match(runner, /PRODUCTION_MEMBER_V2_WALLET_ROWS_MUTATED/);
  assert.match(runner, /admin_four_paper_wallet_rls_guard_ready\(\)/);
  assert.match(runner, /four_market_paper_wallet_rls_guard_ready\(\)/);
  assert.match(workflow, /api-server\/supabase\/migrations\/2026101001_member_four_market_paper_wallet_guard\.sql/);
  assert.match(workflow, /node ops\/verify-production-admin-four-paper-rls\.mjs --artifact/);
});

test('wrong Production project credential fails before opening a DB connection or printing secrets', () => {
  const wrong = spawnSync(process.execPath, ['ops/apply-production-admin-four-paper-rls.mjs'], {
    encoding:'utf8',
    env: {
      PATH:process.env.PATH??'',
      APPROVED_TARGET_SHA:TARGET_SHA,
      PROD_DATABASE_URL:'postgresql://postgres:DO_NOT_LOG_PASSWORD@wrong.example.net:5432/postgres',
    },
  });
  assert.notEqual(wrong.status,0);
  assert.match(wrong.stderr,/CREDENTIAL_OR_MIGRATION_SOURCE_INVALID/);
  assert.doesNotMatch(wrong.stdout+wrong.stderr,/DO_NOT_LOG_PASSWORD|wrong\.example\.net/);
});
