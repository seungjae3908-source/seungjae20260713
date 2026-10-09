import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
      transactional:true,productionProjectMatch:true,
      historicalWalletRowsPreserved:true,paperTradePlanRowsPreserved:true,
      paperJournalRowsPreserved:true,walletsCreated:0,ordersCreated:0,
      privateProviderRequests:0,liveTradingEnabled:false,
    };
    const file = join(dir,'attestation.json');
    writeFileSync(file, JSON.stringify(receipt));
    assert.equal(verify('--artifact',file).status,0);
    for(const invalid of [
      {adminV2RlsVerified:false}, {walletsCreated:4}, {ordersCreated:1},
      {liveTradingEnabled:true}, {approvedTargetSha:'b'.repeat(40)},
      {paperJournalRowsPreserved:false},{privateProviderRequests:1},
    ]){
      writeFileSync(file,JSON.stringify({...receipt,...invalid}));
      assert.notEqual(verify('--artifact',file).status,0);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
