import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createPublicReadOnlyRuntimeReceipt} from '../src/public-runtime-receipt-window.mjs';
const SHA='a'.repeat(40),START=Date.parse('2026-10-10T00:00:00.000Z');
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const STRATEGIES=['SCALPING','SWING','MID_LONG'];
const cli=fileURLToPath(new URL('../scripts/audit-public-24h-receipts.mjs',import.meta.url));
function makeReceipt(at){
 return createPublicReadOnlyRuntimeReceipt({
  serviceSha:SHA,startedAtMs:at-3000,finishedAtMs:at,producerSucceeded:true,
  snapshot:{serviceSha:SHA,publicDataOnly:true,safety:{executionAuthority:'NONE'},
   generatedAt:new Date(at).toISOString(),profile:{fullStrategyCoverage:true,surface:'RESEARCH_V3'},
   coverage:MARKETS.flatMap(market=>STRATEGIES.map(strategy=>({
    market,strategy,status:'VALID_NO_TRADE',providerErrors:0,timeouts:0,
    rawSymbol:'DO_NOT_LOG',
   })))},
 });
}
test('offline 24-hour receipt CLI reads sanitized JSONL without issuing network or certifying real uptime',()=>{
 const folder=mkdtempSync(join(tmpdir(),'read-only-cycle-'));
 const file=join(folder,'public-readonly-runtime-receipts.jsonl');
 try{
  const rows=Array.from({length:721},(_,i)=>makeReceipt(START+i*120000));
  writeFileSync(file,rows.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const command=spawnSync(process.execPath,[cli,file,SHA,new Date(START+86400000).toISOString()],{
   encoding:'utf8',timeout:15000,
  });
  assert.equal(command.status,0,command.stderr);
  const result=JSON.parse(command.stdout);
  assert.equal(result.receiptWindowStructurallyContinuous,true);
  assert.equal(result.marketEvidence.KR_STOCK.verifiedBatches,720);
  assert.equal(result.real24hInfrastructureAttested,false);
  assert.equal(result.wholeMarketConstituentCoverageProven,false);
  assert.equal(command.stdout.includes('DO_NOT_LOG'),false);
  writeFileSync(file,JSON.stringify({...rows[0],rawApiKey:'LEAK_ME'})+'\n');
  const denied=spawnSync(process.execPath,[cli,file,SHA,new Date(START+86400000).toISOString()],{
   encoding:'utf8',timeout:15000,
  });
  assert.equal(denied.status,2);
  assert.equal(denied.stdout,'');
  assert.equal(denied.stderr.includes('LEAK_ME'),false);
 }finally{rmSync(folder,{recursive:true,force:true});}
});
