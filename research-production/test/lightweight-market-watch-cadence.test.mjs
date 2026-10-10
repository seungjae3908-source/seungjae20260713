import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CADENCE_WINDOW_MS, WATCH_CADENCE_CONTRACT, WATCH_CADENCE_AUDIT,
  createPublicWatchCadenceAudit, addPublicWatchCadenceAuditRow,
  makePublicWatchCadenceRecord, summarizePublicWatchCadenceAudit,
} from '../src/lightweight-market-watch-cadence.mjs';

const SHA='a'.repeat(40);
const OTHER='b'.repeat(40);
const NOW=Date.parse('2026-10-10T03:30:00.000Z');
const START=NOW-CADENCE_WINDOW_MS+30_000;
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
function state(at=START,{sha=SHA,budget='RUN',allFour=false}={}) {
  const markets=MARKETS.map((market,i)=>{
    const ready=allFour||i>=2;
    return {
      market,status:budget==='RUN'
        ? ready?'READY':'BLOCKED_PUBLIC_STOCK_FEED_MISSING'
        : 'BLOCKED_HOST_'+budget,
      source:ready?'PUBLIC_TEST':'NONE',observedCount:budget==='RUN'&&ready?100:0,
      listedCount:budget==='RUN'&&ready?100:0,newCandidates:0,
      executionAuthority:'NONE',
    };
  });
  return {
    schemaVersion:'lightweight-market-opportunity-watch-v1',
    researchSha:sha,
    observedAt:new Date(at).toISOString(),
    status:budget==='RUN'?allFour?'OBSERVING_ALL_FOUR':'PARTIAL_MARKET_COVERAGE':budget,
    resourceBudget:{status:budget,reason:budget==='RUN'?'WITHIN_BUDGET':'HOST_PRESSURE'},
    markets,
  };
}
const record=(at=START,opt={})=>makePublicWatchCadenceRecord(state(at,opt));
const audit=(now=NOW,sha=SHA)=>createPublicWatchCadenceAudit({nowMs:now,researchSha:sha});
function seed(a,interval=120_000,n=720,opt={}){
  for(let i=0;i<n;i++)assert.equal(addPublicWatchCadenceAuditRow(a,record(START+i*interval,opt)),true);
  a.filesRead=2;
}
test('720 real-time-shaped records are diagnostic cadence, NEVER verified 24h uptime or profitability',()=>{
  const a=audit();seed(a);
  const v=summarizePublicWatchCadenceAudit(a);
  assert.equal(v.contract,WATCH_CADENCE_AUDIT);
  assert.equal(v.status,'PUBLIC_CADENCE_OBSERVED');
  assert.equal(v.cadenceWindowObserved,true);
  assert.equal(v.sampleCount,720);
  assert.equal(v.maxGapMs,120_000);
  assert.equal(v.allFourMarketReadyCycles,0);
  assert.equal(v.continuous24hProven,false);
  assert.equal(v.completeFourMarketCoverageProven,false);
  assert.equal(v.profitabilityProven,false);
  assert.equal(v.oosCredit,0);
  assert.equal(v.paperCredit,0);
  assert.equal(v.economicEvidenceCredit,0);
  assert.equal(v.executionAuthority,'NONE');
  assert.equal(JSON.stringify(v).includes('BTCUSDT'),false);
});
test('server paused for 20 minutes cannot pass no-gap 24h check',()=>{
  const a=audit();
  for(let i=0;i<710;i++){
    const at=START+i*120_000+(i>320?20*60_000:0);
    if (at<=NOW)addPublicWatchCadenceAuditRow(a,record(at));
  }
  a.filesRead=2;
  const v=summarizePublicWatchCadenceAudit(a);
  assert.equal(v.cadenceWindowObserved,false);
  assert.equal(v.status,'INCOMPLETE_OR_INTERRUPTED');
  assert.ok(v.maxGapMs>6*60_000);
});
test('host HOLD/THROTTLED never counts as healthy uninterrupted cadence',()=>{
  const a=audit();
  for(let i=0;i<720;i++){
    const budget=i===100?'HOLD':i===101?'THROTTLED':'RUN';
    assert.equal(addPublicWatchCadenceAuditRow(a,record(START+i*120_000,{budget})),true);
  }
  const v=summarizePublicWatchCadenceAudit(a);
  assert.equal(v.hostHoldCycles,1);
  assert.equal(v.hostThrottledCycles,1);
  assert.equal(v.cadenceWindowObserved,false);
});
test('same recorded cycle can replay idempotently, conflicting cycle cannot',()=>{
  const a=audit();const one=record();
  assert.equal(addPublicWatchCadenceAuditRow(a,one),true);
  assert.equal(addPublicWatchCadenceAuditRow(a,one),true);
  assert.equal(summarizePublicWatchCadenceAudit(a).duplicateRows,1);
  const other=record(START,{allFour:true});
  assert.equal(addPublicWatchCadenceAuditRow(a,other),false);
  const invalid=summarizePublicWatchCadenceAudit(a);
  assert.equal(invalid.status,'INVALID');
  assert.equal(invalid.sampleCount,null);
});
test('forged order or provider counter cannot be accepted as public liveness',()=>{
  const base=record();
  assert.equal(base.schemaVersion,WATCH_CADENCE_CONTRACT);
  for(const forged of [
    {...base,executionAuthority:'LIVE'},
    {...base,paperCredit:1},
    {...base,economicEvidenceCredit:1},
    {...base,eventId:'0'.repeat(64)},
    {...base,markets:base.markets.map((v,i)=>i===0?{...v,status:'READY',observedCount:100}:v)},
    {...base,resourceBudget:'HOLD'},
  ]){
    const a=audit();
    assert.equal(addPublicWatchCadenceAuditRow(a,forged),false);
    const v=summarizePublicWatchCadenceAudit(a);
    assert.equal(v.status,'INVALID');
    assert.equal(v.cadenceWindowObserved,false);
  }
});
test('missing window, mismatched release and forged future record do not provide uptime proof',()=>{
  const a=audit();
  assert.equal(summarizePublicWatchCadenceAudit(a).status,'MISSING');
  assert.equal(addPublicWatchCadenceAuditRow(a,record(START,{sha:OTHER})),true);
  let result=summarizePublicWatchCadenceAudit(a);
  assert.equal(result.sampleCount,0);
  assert.equal(result.ignoredOtherReleaseRows,1);
  assert.equal(result.cadenceWindowObserved,false);
  assert.equal(addPublicWatchCadenceAuditRow(a,record(NOW+6000)),false);
  result=summarizePublicWatchCadenceAudit(a);
  assert.equal(result.status,'INVALID');
  assert.equal(result.sampleCount,null);
});
test('malformed market source, impossible READY, missing timestamps are rejected before recording',()=>{
  const original=state();
  original.markets[0].status='READY';
  assert.throws(()=>makePublicWatchCadenceRecord(original),/STATUS_MISMATCH/);
  original.markets[0].status='BLOCKED_PUBLIC_STOCK_FEED_MISSING';
  original.observedAt='not-a-timestamp';
  assert.throws(()=>makePublicWatchCadenceRecord(original),/SOURCE_INVALID/);
});
async function temp(fn){
  const root=await mkdtemp(join(tmpdir(),'watch-cadence-'));
  try{
    const dir=join(root,'watch','cadence');
    await mkdir(dir,{recursive:true,mode:0o700});
    return await fn(root,dir);
  }finally{await rm(root,{recursive:true,force:true});}
}
function execute(root){
  const exe=new URL('../bin/lightweight-market-watch-cadence-status.mjs',import.meta.url).pathname;
  return spawnSync(process.execPath,[exe],{encoding:'utf8',env:{
    ...process.env,RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:SHA,
  }});
}
async function persist(dir,rows){
  const days=new Map();
  for(const v of rows){
    const day=v.observedAt.slice(0,10);
    if(!days.has(day))days.set(day,[]);
    days.get(day).push(JSON.stringify(v));
  }
  for(const [day,lines] of days)
    await writeFile(join(dir,day+'.jsonl'),lines.join('\n')+'\n',{mode:0o600});
}
test('read-only CLI audits two UTC days with 720 synthetic fixture records, without activating services',async()=>{
  await temp(async(root,dir)=>{
    const empty=execute(root);
    assert.equal(empty.status,0,empty.stdout);
    assert.equal(JSON.parse(empty.stdout).status,'MISSING');
    const now=Date.now();
    const start=now-CADENCE_WINDOW_MS+30_000;
    const rows=Array.from({length:720},(_,i)=>record(start+i*120_000));
    await persist(dir,rows);
    const before=(await readFile(join(dir,rows[0].observedAt.slice(0,10)+'.jsonl'),'utf8'));
    const result=execute(root);
    assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.sampleCount,720);
    assert.equal(report.cadenceWindowObserved,true);
    assert.equal(report.continuous24hProven,false);
    assert.equal(report.executionAuthority,'NONE');
    assert.equal(JSON.stringify(report).includes(root),false);
    assert.equal((await readFile(join(dir,rows[0].observedAt.slice(0,10)+'.jsonl'),'utf8')),before);
  });
});
test('read-only CLI fails closed for bad symlinks, truncated JSON and permissions',async()=>{
  await temp(async(root,dir)=>{
    const now=Date.now();
    const day=new Date(now).toISOString().slice(0,10);
    const file=join(dir,day+'.jsonl');
    await symlink(join(root,'secret'),file);
    let result=execute(root);
    assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).status,'INVALID');
    await rm(file);
    await writeFile(file,'{"broken":', {mode:0o600});
    result=execute(root);
    assert.equal(result.status,2);
    await writeFile(file,JSON.stringify(record(now-60_000))+'\n',{mode:0o600});
    await chmod(file,0o666);
    result=execute(root);
    assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).continuous24hProven,false);
  });
});
test('worker writes one bounded trace only after successful state and readback publication',async()=>{
  const worker=await readFile(new URL('../bin/lightweight-market-watch.mjs',import.meta.url),'utf8');
  const storage=await readFile(new URL('../src/lightweight-market-watch-storage.mjs',import.meta.url),'utf8');
  const stateLine=worker.indexOf("atomicDurableWatchJson(join(root, 'watch', 'state-v1.json')");
  const publicLine=worker.indexOf("atomicDurableWatchJson(join(root, 'latest', 'lightweight-market-watch.json')");
  const cadenceLine=worker.indexOf("appendBoundedWatchEvents(root, [makePublicWatchCadenceRecord(state)]");
  assert.ok(stateLine>=0 && publicLine>stateLine && cadenceLine>publicLine);
  assert.match(storage,/category !== 'cadence'/u);
  assert.match(worker,/mkdir\(join\(root, 'watch', 'cadence'\)/u);
  assert.doesNotMatch(worker,/LIVE_TRADING\s*=\s*true|AUTO_TRADING\s*=\s*true|placeOrder\(/u);
});
