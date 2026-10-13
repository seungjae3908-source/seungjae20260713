// Frozen Research source graph; financial preservation is checked against the
// actual PR base, not by forever locking unrelated finance code to an old release.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runDurableMinuteBackfillCycle} from '../src/four-market-minute-backfill-queue-v1.mjs';
import {prepareSealedMinuteBacktesterInputV1} from '../src/four-market-minute-backtester-prewire-v1.mjs';
import {importPublicMinutePrewireIntoNativeArchiveV1} from '../../market-prediction-lab/src/research-public-minute-prewire-bridge-v1.js';
import {runFourMarketOriginalMinuteReplayV1} from '../../market-prediction-lab/src/four-market-original-minute-replay-v1.js';
import {ONE_PASS_NATIVE_PINS as pitSourcePins, ONE_PASS_RESEARCH_PINS as researchSourcePins,
  ONE_PASS_PROTECTED_MAIN_PINS as historicalFinancePins} from '../src/research-one-pass-source-pins-v1.mjs';
import financePreservation from '../../.github/scripts/research-financial-base-preservation.cjs';
const {FINANCIAL_PATHS, verifyFinancialPreservation} = financePreservation;
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=path=>readFileSync(resolve(root,path));
const gitBlobSha=b=>createHash('sha1').update('blob '+b.length)
  .update(Buffer.from([0])).update(b).digest('hex');
function checkPins(pins,prefix){for(const [path,expected] of pins){
  assert.equal(gitBlobSha(read(path)),expected,prefix+':'+path);
}}
test('frozen PIT and native replay 49 owner blobs preserved',()=>{
  assert.equal(pitSourcePins.length,49);
  checkPins(pitSourcePins,'PIT_OWNER_SHA_DRIFT');
});
test('frozen Research WebSocket, backfill and AI 62 source blobs preserved',()=>{
  assert.equal(researchSourcePins.length,62);
  checkPins(researchSourcePins,'SOURCE_AI_SHA_DRIFT');
});
test('financial preservation uses the actual PR base and still rejects every protected rollback',()=>{
  assert.deepEqual(historicalFinancePins.map(([path])=>path),FINANCIAL_PATHS);
  for(const path of FINANCIAL_PATHS){
    assert.equal(pitSourcePins.some(row=>row[0]===path),false);
    assert.equal(researchSourcePins.some(row=>row[0]===path),false);
  }
  // Unit coverage of the comparison policy. The real, API-bound current-base
  // comparison runs before this suite in the dedicated source QA workflow.
  const entries=FINANCIAL_PATHS.map(path=>({path,sha:gitBlobSha(read(path)),type:'blob',mode:'100644'}));
  const proof={baseSha:'a'.repeat(40),headSha:'b'.repeat(40),baseTreeSha:'c'.repeat(40),headTreeSha:'d'.repeat(40),
    baseTree:{sha:'c'.repeat(40),truncated:false,tree:entries},
    headTree:{sha:'d'.repeat(40),truncated:false,tree:structuredClone(entries)}};
  assert.equal(verifyFinancialPreservation(proof).protectedFilesUnchanged,true);
  for(let i=0;i<entries.length;i++){
    const rollback=structuredClone(proof);
    rollback.headTree.tree[i].sha=entries[i].sha==='f'.repeat(40)?'e'.repeat(40):'f'.repeat(40);
    assert.throws(()=>verifyFinancialPreservation(rollback),/PROTECTED_PATH_CHANGED/u);
  }
  const workflow=read('.github/workflows/research-isolated-release.yml').toString();
  assert.ok(workflow.includes('await authorizeResearchFinancialPreservation({github,context,checkedOutSha})'));
  assert.ok(workflow.includes('Verify actual PR base preserves all five financial files'));
});
test('Research source→native replay→admin PIT API/UI integration exists',()=>{
  assert.equal(typeof runFourMarketOriginalMinuteReplayV1,'function');
  const route=read('api-server/src/routes/research-workspace.ts').toString();
  const page=read('stock-analyzer/src/pages/research-center.tsx').toString();
  const replay=read('market-prediction-lab/src/four-market-original-minute-replay-v1.js').toString();
  const bridge=read('market-prediction-lab/src/research-public-minute-prewire-bridge-v1.js').toString();
  assert.ok(route.includes("'/pit-minute-coverage'"));
  assert.ok(route.includes("requireCapability('canManageMembers')"));
  assert.ok(page.includes('ResearchPITMinuteCoveragePanel'));
  for(const id of ['UPBIT_PUBLIC_1M','BITGET_PUBLIC_FUTURES_1M']){
    assert.ok(replay.includes(id),'native:'+id);
    assert.ok(bridge.includes(id),'sealed:'+id);
  }
});
test('unapproved collection / backtest / import never gain execution authority',async()=>{
  let networkCalls=0;
  const collector=await runDurableMinuteBackfillCycle({enabled:false,
    fetchImpl:()=>{networkCalls++;throw Error('FORBIDDEN_PROVIDER_GET');}});
  const native=await prepareSealedMinuteBacktesterInputV1({enabled:false});
  const bridge=await importPublicMinutePrewireIntoNativeArchiveV1();
  assert.equal(networkCalls,0);
  assert.equal(collector.status,'DISABLED');
  assert.equal(collector.providerCalls,0);
  assert.equal(collector.filesWritten,0);
  assert.equal(collector.executionAuthority,'NONE');
  assert.equal(native.status,'BLOCKED_DATA');
  assert.equal(native.profitabilityProven,false);
  assert.equal(native.executionAuthority,'NONE');
  assert.equal(bridge.status,'DISABLED');
  assert.equal(bridge.paperAdmissionAllowed,false);
  assert.equal(bridge.profitabilityProven,false);
  assert.equal(bridge.executionAuthority,'NONE');
});
test('code QA cannot mint unavailable real market, OOS, costs or Paper evidence',()=>{
  const report=read('research-production/docs/activation-readiness-matrix-20261012.md').toString();
  for(const marker of ['Original KR/US 1m feed','Crypto 1m collection',
    'Storage and recovery','Candidate economic proof','NO_GO'])
    assert.ok(report.includes(marker),marker);
  assert.equal(report.includes('PROFITABILITY_PROVEN=true'),false);
});
test('one-pass security reviewer keeps all original rejections',()=>{
  const v=read('.github/scripts/verify-research-workspace-sync-v3.mjs').toString();
  for(const m of ['PIT_READONLY_UNRELATED_OWNER_SCOPE_FORBIDDEN:','PROTECTED_PATH_CHANGED:',
    'AUTOMATIC_TRADING_RESEARCH_SCOPE_FORBIDDEN:','RESEARCH_ONE_PASS_UNREVIEWED_PATH:',
    'RESEARCH_ONE_PASS_IMMUTABLE_SOURCE_CHANGED:','RESEARCH_ONE_PASS_LIVE_PROTECTION_DRIFT:'])
    assert.ok(v.includes(m),m);
});
