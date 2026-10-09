import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile, stat, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WATCH_COHORT_CONTRACT, createPublicWatchCohort,
  parseWatchCohortDay, addPublicWatchDiscovery, addPublicWatchOutcome,
  summarizePublicWatchCohort,
} from '../src/lightweight-market-watch-cohort.mjs';

const SHA = 'a'.repeat(40);
const BASE = Date.parse('2026-10-08T03:00:00Z');
const DAY = '2026-10-08';
const digest = x => createHash('sha256').update(x).digest('hex');
function event(at = BASE, extra = {}) {
  const e = {
    schemaVersion:'lightweight-market-opportunity-watch-v1',
    researchSha:SHA, market:'CRYPTO_FUTURES', symbol:'BTCUSDT',
    direction:'UP', source:'BITGET_PUBLIC_TICKERS',
    sourceAtMs:at, priorSourceAtMs:at-120_000,
    observedAt:new Date(at+1000).toISOString(),
    kind:'PROVISIONAL_PRICE_ACCELERATION',
    executionAuthority:'NONE', isTradingSignal:false,
    aiReviewed:false, oosPassed:false, paperAdmitted:false,
    ...extra,
  };
  e.eventId = digest(JSON.stringify({
    researchSha:e.researchSha, market:e.market, symbol:e.symbol,
    direction:e.direction, source:e.source, sourceAtMs:e.sourceAtMs,
    priorSourceAtMs:e.priorSourceAtMs,
  }));
  return e;
}
function outcome(e, status = 'OBSERVED_COARSE', extra = {}) {
  const observed = status === 'OBSERVED_COARSE';
  return {
    contract:'public-watch-prospective-price-study-v1',
    eventId:e.eventId,
    outcomeId:digest('public-watch-prospective-price-study-v1:' + e.eventId),
    market:e.market, symbol:e.symbol, direction:e.direction, source:e.source,
    kind:'PUBLIC_PRICE_OBSERVATION_ONLY', status,
    eventAtMs:e.sourceAtMs, evaluatedAtMs:e.sourceAtMs+20*60_000,
    horizonTargetMs:20*60_000,
    sampledFutureN:observed ? 5 : 1,
    sampledElapsedMs:observed ? 19*60_000 : null,
    sampledFavorableExcursionPercent:observed ? 2.5 : null,
    sampledAdverseExcursionPercent:observed ? -1.1 : null,
    referencePrice:100, sourceTimeBound:true,
    economicEvidenceCredit:0, paperCredit:0, oosCredit:0,
    executionAuthority:'NONE', isTradingSignal:false, orderAllowed:false,
    profitabilityProven:false,
    ...extra,
  };
}
function cohort(dayUtc = DAY, sha = SHA) {
  return createPublicWatchCohort({
    dayUtc, researchSha:sha, nowMs:Date.parse('2026-10-10T01:00:00Z'),
  });
}
test('public price cohort deduplicates append-once-or-more crash replay and NEVER proves PnL', () => {
  const s=cohort(); s.fileCount=3;
  const e=event();
  assert.equal(addPublicWatchDiscovery(s,e),true);
  assert.equal(addPublicWatchDiscovery(s,{...e,observedAt:new Date(BASE+2000).toISOString()}),true);
  const o=outcome(e);
  assert.equal(addPublicWatchOutcome(s,o),true);
  assert.equal(addPublicWatchOutcome(s,{...o,evaluatedAtMs:o.evaluatedAtMs+1000}),true);
  const v=summarizePublicWatchCohort(s);
  assert.equal(v.contract,WATCH_COHORT_CONTRACT);
  assert.equal(v.status,'PUBLIC_SAMPLES_ONLY');
  assert.equal(v.rawEventRows,2);
  assert.equal(v.discoveryCount,1);
  assert.equal(v.deduplicatedDiscoveryRows,1);
  assert.equal(v.observedCoarseCount,1);
  assert.equal(v.deduplicatedOutcomeRows,1);
  assert.equal(v.blockedDataCount,0);
  assert.equal(v.missingOutcomeCount,0);
  assert.equal(v.economicEvidenceCredit,0);
  assert.equal(v.oosCredit,0);
  assert.equal(v.paperCredit,0);
  assert.equal(v.profitabilityProven,false);
  assert.equal(v.fullCostReady,false);
  assert.equal(v.continuous24hProven,false);
  assert.equal(v.executionAuthority,'NONE');
  assert.equal(JSON.stringify(v).includes('BTCUSDT'),false);
});
test('unsettled discovery is missing outcome, not a fake positive sample',()=>{
  const s=cohort(); s.fileCount=1;addPublicWatchDiscovery(s,event());
  const v=summarizePublicWatchCohort(s);
  assert.equal(v.missingOutcomeCount,1);
  assert.equal(v.observedCoarseCount,0);
  assert.equal(v.status,'PUBLIC_SAMPLES_ONLY');
});
test('a data-blocked prospective outcome stays blocked without any economic credit',()=>{
  const s=cohort();s.fileCount=2;
  const e=event();addPublicWatchDiscovery(s,e);
  addPublicWatchOutcome(s,outcome(e,'BLOCKED_DATA'));
  const v=summarizePublicWatchCohort(s);
  assert.equal(v.blockedDataCount,1);
  assert.equal(v.observedCoarseCount,0);
  assert.equal(v.economicEvidenceCredit,0);
});
test('duplicate outcome state conflicts and forged monetary authority fail closed',()=>{
  const e=event();
  for(const forged of [
    outcome(e,'OBSERVED_COARSE',{economicEvidenceCredit:1}),
    outcome(e,'OBSERVED_COARSE',{paperCredit:1}),
    outcome(e,'OBSERVED_COARSE',{oosCredit:1}),
    outcome(e,'OBSERVED_COARSE',{executionAuthority:'LIVE'}),
    outcome(e,'OBSERVED_COARSE',{profitabilityProven:true}),
    outcome(e,'OBSERVED_COARSE',{sampledElapsedMs:22*60_000}),
    outcome(e,'OBSERVED_COARSE',{sampledFutureN:1}),
    outcome(e,'BLOCKED_DATA',{sampledFavorableExcursionPercent:10}),
  ]){
    const s=cohort();s.fileCount=2;addPublicWatchDiscovery(s,e);
    assert.equal(addPublicWatchOutcome(s,forged),false);
    const v=summarizePublicWatchCohort(s);
    assert.equal(v.status,'INVALID');
    assert.equal(v.observedCoarseCount,null);
    assert.equal(v.economicEvidenceCredit,0);
  }
  const s=cohort();s.fileCount=3;addPublicWatchDiscovery(s,e);
  addPublicWatchOutcome(s,outcome(e));
  addPublicWatchOutcome(s,outcome(e,'BLOCKED_DATA'));
  assert.equal(summarizePublicWatchCohort(s).status,'INVALID');
});
test('forged event IDs and source timestamps cannot masquerade as discoveries',()=>{
  for(const forged of [
    {...event(),eventId:'f'.repeat(64)},
    event(BASE,{sourceAtMs:BASE+7000,observedAt:new Date(BASE).toISOString()}),
    event(BASE,{kind:'PAPER_PASS'}),
    event(BASE,{paperAdmitted:true}),
    event(BASE,{researchSha:'not_sha'}),
    event(BASE,{symbol:'../../secret'}),
  ]){
    const s=cohort();s.fileCount=1;
    assert.equal(addPublicWatchDiscovery(s,forged),false);
    assert.equal(summarizePublicWatchCohort(s).status,'INVALID');
  }
});
test('release isolation and next-day outcomes cannot create cross-release matches',()=>{
  const s=cohort();s.fileCount=3;
  const old=event(BASE,{researchSha:'b'.repeat(40)});
  assert.equal(addPublicWatchDiscovery(s,old),true);
  const e=event(BASE+600_000);
  addPublicWatchDiscovery(s,e);
  addPublicWatchOutcome(s,outcome(old));
  addPublicWatchOutcome(s,outcome(e));
  const v=summarizePublicWatchCohort(s);
  assert.equal(v.status,'PUBLIC_SAMPLES_ONLY');
  assert.equal(v.otherReleaseEventRows,1);
  assert.equal(v.unpairedOtherDayOutcomeRows,1);
  assert.equal(v.discoveryCount,1);
  assert.equal(v.observedCoarseCount,1);
});
test('malformed calendar dates and SHA do not create an apparently empty healthy cohort',()=>{
  assert.throws(()=>parseWatchCohortDay('2026-02-30'),/DATE_INVALID/);
  assert.throws(()=>parseWatchCohortDay('../secrets'),/DATE_INVALID/);
  assert.throws(()=>createPublicWatchCohort({dayUtc:DAY,researchSha:'bad'}),/IDENTITY_INVALID/);
  const s=cohort();assert.equal(summarizePublicWatchCohort(s).status,'MISSING');
});
async function setUp() {
  const root=await mkdtemp(join(tmpdir(),'watch-cohort-'));
  await mkdir(join(root,'watch','events'),{recursive:true,mode:0o700});
  await mkdir(join(root,'watch','outcomes'),{recursive:true,mode:0o700});
  const exe=new URL('../bin/lightweight-market-watch-cohort.mjs',import.meta.url).pathname;
  const run=(day=DAY)=>spawnSync(process.execPath,[exe,'--day='+day],{
    env:{...process.env,RESEARCH_STATE_ROOT:root,RESEARCH_CODE_SHA:SHA},encoding:'utf8',
  });
  const put=async(category,date,rows)=>{
    const path=join(root,'watch',category,date+'.jsonl');
    await writeFile(path,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
    return path;
  };
  return {root,run,put};
}
test('CLI reads only daily bounded JSONL, including next-day 20m horizon, with no storage mutations',async()=>{
  const t=await setUp();
  try{
    const before=t.run(); assert.equal(before.status,0,before.stderr);
    assert.equal(JSON.parse(before.stdout).status,'MISSING');
    const at=Date.parse('2026-10-08T23:58:00Z');
    const e=event(at);
    await t.put('events',DAY,[e,e]);
    await t.put('outcomes','2026-10-09',[outcome(e)]);
    const a=t.run();assert.equal(a.status,0,a.stderr);
    const report=JSON.parse(a.stdout);
    assert.equal(report.discoveryCount,1);
    assert.equal(report.observedCoarseCount,1);
    assert.equal(report.deduplicatedDiscoveryRows,1);
    assert.equal(report.paperCredit,0);
    assert.equal(report.executionAuthority,'NONE');
    assert.equal(JSON.stringify(report).includes(t.root),false);
    assert.equal(JSON.stringify(report).includes('BTCUSDT'),false);
    assert.equal((await stat(join(t.root,'watch','events',DAY+'.jsonl'))).isFile(),true);
  }finally{await rm(t.root,{recursive:true,force:true})}
});
test('CLI fails closed on symlink, corrupt/truncated JSONL, group-writable input',async()=>{
  const t=await setUp();
  try{
    const file=join(t.root,'watch','events',DAY+'.jsonl');
    await symlink(join(t.root,'secret'),file);
    let result=t.run();assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).status,'INVALID');
    await rm(file);
    await writeFile(file,'{"truncated":',{mode:0o600});
    result=t.run();assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).status,'INVALID');
    await rm(file);
    await writeFile(file,JSON.stringify(event())+'\n',{mode:0o600});
    await chmod(file,0o662);
    result=t.run();assert.equal(result.status,2);
    assert.equal(JSON.parse(result.stdout).status,'INVALID');
  }finally{await rm(t.root,{recursive:true,force:true})}
});
