import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DIRECTIONS, candlesAtOrBefore, simulateRunner, summarizeRunnerTrials } from '../src/engine.mjs';
import { summarizeThreeYearProfileReadiness, MOVE_HUNTER_AUDIT_START_MS, MOVE_HUNTER_AUDIT_END_MS } from '../src/readiness.mjs';
import { ADAPTIVE_MULTI_MARKET_PROFILES_V1 } from '../../../market-prediction-lab/src/adaptive-multi-market-tournament-orchestrator-v1.js';

function candles({start=1_700_000_000_000,count=80,drift=.002}={}){
  const out=[]; let price=100;
  for(let i=0;i<count;i+=1){ const open=price,close=open*(1+drift); out.push({ts:start+i*60000,open,high:Math.max(open,close)*1.004,low:Math.min(open,close)*.996,close,volume:1000}); price=close; }
  return out;
}

test('past-only slicing never exposes future candles',()=>{
  const data=candles({count:40}),asOf=data[20].ts,past=candlesAtOrBefore(data,asOf);
  assert.equal(past.at(-1).ts,asOf); assert.equal(past.length,21);
});

test('next-bar entry and active stop are conservative',()=>{
  const data=candles({count:50,drift:.001}),signalAtMs=data[34].ts,entry=data[35].open;
  data[35]={...data[35],high:entry*1.12,low:entry*.90,close:entry*1.01};
  const r=simulateRunner({candles:data,signalAtMs,maxBars:5});
  assert.equal(r.entryTs,data[35].ts); assert.match(r.exitReason,/STOP/); assert.equal(r.targetHitTs.pct3,null); assert.ok(r.ambiguousBars>=1);
});

test('long runner can hold beyond +10 percent without fixed take profit',()=>{
  const data=candles({count:70,drift:.001}),signalAtMs=data[34].ts; let p=data[35].open;
  for(let i=35;i<45;i+=1){ const open=p,close=open*1.02; data[i]={...data[i],open,high:close*1.003,low:open*.997,close}; p=close; }
  for(let i=45;i<data.length;i+=1){ const open=p,close=open*.985; data[i]={...data[i],open,high:open*1.002,low:close*.995,close}; p=close; }
  const r=simulateRunner({candles:data,signalAtMs,maxBars:30,trailActivateAtR:2,trailAtrMult:2});
  assert.ok(r.mfe>.10); assert.notEqual(r.targetHitTs.pct10,null); assert.ok(r.maxR>2);
});

test('short futures runner supports asymmetric downside capture',()=>{
  const data=candles({count:70,drift:0}),signalAtMs=data[34].ts; let p=data[35].open;
  for(let i=35;i<45;i+=1){ const open=p,close=open*.985; data[i]={...data[i],open,high:open*1.003,low:close*.997,close}; p=close; }
  for(let i=45;i<data.length;i+=1){ const open=p,close=open*1.012; data[i]={...data[i],open,high:close*1.003,low:open*.998,close}; p=close; }
  const r=simulateRunner({candles:data,signalAtMs,direction:DIRECTIONS.SHORT,maxBars:30});
  assert.ok(r.mfe>.10); assert.notEqual(r.targetHitTs.pct10,null); assert.ok(r.initialStop>r.entry);
});

test('runner has no 10 percent ceiling and records 100 percent milestone',()=>{
  const data=candles({count:90,drift:0}),signalAtMs=data[34].ts; let p=data[35].open;
  for(let i=35;i<55;i+=1){ const open=p,close=open*1.04; data[i]={...data[i],open,high:close*1.002,low:open*.998,close}; p=close; }
  for(let i=55;i<data.length;i+=1){ const open=p,close=open*.98; data[i]={...data[i],open,high:open*1.002,low:close*.998,close}; p=close; }
  const result=simulateRunner({candles:data,signalAtMs,maxBars:45,trailActivateAtR:2,trailAtrMult:2});
  assert.ok(result.peakReturn>1);
  assert.notEqual(result.milestoneHitTs['1'],null);
  assert.notEqual(result.targetHitTs.pct10,null);
  assert.ok(result.grossCaptureRatio>=0&&result.grossCaptureRatio<=1);
  assert.ok(result.givebackFromPeak>=0);
});

test('costs reduce net return',()=>{
  const data=candles({count:60,drift:.0015}),signalAtMs=data[34].ts;
  const gross=simulateRunner({candles:data,signalAtMs,maxBars:10,costs:{}});
  const net=simulateRunner({candles:data,signalAtMs,maxBars:10,costs:{feeBps:5,slippageBps:3,spreadBps:2}});
  assert.ok(net.netReturn<gross.netReturn);
});

test('summary reports hit rates and risk-adjusted results',()=>{
  const data=candles({count:60,drift:.0015}),signalAtMs=data[34].ts;
  const trial=simulateRunner({candles:data,signalAtMs,maxBars:10});
  const s=summarizeRunnerTrials([trial]); assert.equal(s.n,1); assert.ok(Number.isFinite(s.avgNetR)); assert.ok(Number.isFinite(s.avgGrossCaptureRatio)); assert.ok(Number.isFinite(s.avgGivebackFromPeak));
});

test('adapter source reuses merged canonical replay, settlement and dataset owners',async()=>{
  const source=await readFile(new URL('../src/replay.mjs',import.meta.url),'utf8');
  assert.match(source,/historical-market-replay-v1\.js/);
  assert.match(source,/historical-discovery-settlement-v1\.js/);
  assert.match(source,/research-dataset-snapshot-store\.mjs/);
  assert.doesNotMatch(source,/function\s+discoverCandidates/);
  assert.doesNotMatch(source,/function\s+buildWalkForward/);
});


test('three-year readiness blocks missing dataset manifests even when canonical cells claim READY',()=>{
  const readiness={profiles:ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(p=>({...p,status:'READY',missingRequirements:[]}))};
  const result=summarizeThreeYearProfileReadiness({readiness,datasetManifestsByProfile:{}});
  assert.equal(result.fourMarketReady,false);
  assert.equal(result.readyMarketCount,0);
  assert.equal(result.blockedMarketCount,4);
  for(const market of Object.values(result.markets)) assert.ok(market.blockers.includes('DATASET_MANIFEST_MISSING'));
});

test('three-year readiness requires every canonical profile to cover the exact audit range',()=>{
  const readiness={profiles:ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(p=>({...p,status:'READY',missingRequirements:[]}))};
  const manifests=Object.fromEntries(ADAPTIVE_MULTI_MARKET_PROFILES_V1.map(p=>[p.profileId,{
    profileId:p.profileId,market:p.market,datasetSnapshotHash:'a'.repeat(64),
    scope:{startTime:MOVE_HUNTER_AUDIT_START_MS,endTime:MOVE_HUNTER_AUDIT_END_MS,timeframe:p.timeframe},
  }]));
  const result=summarizeThreeYearProfileReadiness({readiness,datasetManifestsByProfile:manifests});
  assert.equal(result.fourMarketReady,true);
  assert.equal(result.readyMarketCount,4);
  assert.equal(result.blockedMarketCount,0);
});


test('indicator INVALID state exits only on the next bar open',()=>{
  const data=candles({count:60,drift:.001});
  const signalAtMs=data[34].ts;
  const invalidTs=data[37].ts;
  const expectedExitTs=data[38].ts;
  const expectedExitPrice=data[38].open;
  const result=simulateRunner({
    candles:data,
    signalAtMs,
    maxBars:20,
    trailActivateAtR:999,
    runnerControlByTs:{
      [String(invalidTs)]:{state:'INVALID',trailAtrMult:1.5,exitNextOpen:true},
    },
    indicatorExitEnabled:true,
  });
  assert.equal(result.exitReason,'INDICATOR_INVALID_NEXT_OPEN');
  assert.equal(result.exitTs,expectedExitTs);
  assert.equal(result.exitPrice,expectedExitPrice);
  assert.equal(result.controlHistory.length,1);
  assert.equal(result.controlHistory[0].ts,invalidTs);
});
