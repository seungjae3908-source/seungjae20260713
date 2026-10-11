import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,link,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readV3StageOneWatch,classifyV3WatchReadError} from '../src/public-watch-v3-readonly.mjs';
import {verifyV3WatchHandoff,installV3WithinPageWatchPriority,
  prioritizeV3CurrentCryptoPage,v3WithinPagePriorityDiagnostic}
  from '../src/public-watch-v3-priority.mjs';
const SHA='a'.repeat(40),NOW=Date.parse('2026-10-12T00:10:00.000Z');
const WATCH=new Date(NOW-30_000).toISOString();
const MARKET=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
function fixture(){
  const markets=MARKET.map(m=>({
    market:m,
    status:m==='CRYPTO_SPOT'||m==='CRYPTO_FUTURES'?'READY':'BLOCKED_INPUT_NOT_CONFIGURED',
    source:m==='CRYPTO_SPOT'?'UPBIT_PUBLIC_TICKERS'
      :m==='CRYPTO_FUTURES'?'BITGET_PUBLIC_TICKERS':'NONE',
    listedCount:m==='CRYPTO_SPOT'||m==='CRYPTO_FUTURES'?2:0,
    observedCount:m==='CRYPTO_SPOT'||m==='CRYPTO_FUTURES'?2:0,
    newCandidates:1*(m==='CRYPTO_SPOT'||m==='CRYPTO_FUTURES'),
    sourceCappedCount:0,
    qualifyingCandidateCount:1*(m==='CRYPTO_SPOT'||m==='CRYPTO_FUTURES'),
    candidateCappedCount:0,executionAuthority:'NONE',
  }));
  return {schemaVersion:'lightweight-market-opportunity-watch-v1',
    researchSha:SHA,observedAt:WATCH,status:'PARTIAL_MARKET_COVERAGE',
    resourceBudget:{status:'RUN',reason:'WITHIN_BUDGET'},
    markets,newCandidateCount:2,
    statistics:{dayUtc:WATCH.slice(0,10),cyclesToday:1,
      candidatesToday:2,cyclesSinceRelease:1},
    safety:{researchOnly:true,orderAuthority:'NONE',liveTrading:false,
      privateProviderApi:false,paperAdmissionAllowed:false,
      profitabilityProven:false,aiPassInvented:false}};
}
function event({market='CRYPTO_SPOT',symbol='BTC',direction='UP',
  source,movePercent=1.2}={}){
  const s=source??(market==='CRYPTO_SPOT'
    ?'UPBIT_PUBLIC_TICKERS':'BITGET_PUBLIC_TICKERS');
  const obj={schemaVersion:'lightweight-market-opportunity-watch-v1',
    market,symbol,direction,source:s,universeStatus:'READY',
    kind:'PROVISIONAL_PRICE_ACCELERATION',
    observedAt:WATCH,priorObservedAt:new Date(NOW-150_000).toISOString(),
    comparisonMinutes:2,sourceAtMs:NOW-60_000,
    priorSourceAtMs:NOW-180_000,
    movePercent,change24hPercent:3,turnover24h:15_000_000_000,
    score:Math.abs(movePercent),executionAuthority:'NONE',
    isTradingSignal:false,aiReviewed:false,oosPassed:false,
    paperAdmitted:false,researchSha:SHA};
  obj.eventId=createHash('sha256').update(JSON.stringify({
    researchSha:obj.researchSha,market:obj.market,symbol:obj.symbol,
    direction:obj.direction,source:obj.source,sourceAtMs:obj.sourceAtMs,
    priorSourceAtMs:obj.priorSourceAtMs,
  })).digest('hex');
  return obj;
}
test('verified Stage-1 events reprioritize only an existing V3 crypto cursor page',()=>{
  const src=fixture(),a=event(),b=event({
    market:'CRYPTO_FUTURES',symbol:'ETHUSDT',direction:'DOWN',movePercent:-2,
  });
  const result=verifyV3WatchHandoff(src,[a,b],{nowMs:NOW,expectedResearchSha:SHA});
  assert.equal(result.status,'PARTIAL_SOURCE');
  assert.equal(result.priorities.length,2);
  assert.equal(result.report.priorityReviewCandidates,2);
  assert.equal(result.report.oosPassProven,false);
  installV3WithinPageWatchPriority(result);
  const page=[{symbol:'ADA'},{symbol:'BTC'},{symbol:'ETH'}];
  assert.deepEqual(prioritizeV3CurrentCryptoPage(page,'spot').map(v=>v.symbol),
    ['BTC','ADA','ETH']);
  assert.deepEqual(prioritizeV3CurrentCryptoPage([
    {symbol:'BTCUSDT'},{symbol:'ETHUSDT'},
  ],'futures').map(v=>v.symbol),['ETHUSDT','BTCUSDT']);
  const diag=v3WithinPagePriorityDiagnostic();
  assert.equal(diag.matchedWithinCursorPages,2);
  assert.equal(diag.extraProviderRequests,0);
  assert.equal(diag.cursorSkipped,0);
  assert.equal(result.report.stageTwoOutsideCursorInjected,false);
  assert.ok(!JSON.stringify(result.report).includes('ETHUSDT'));
  installV3WithinPageWatchPriority(null);
  assert.deepEqual(prioritizeV3CurrentCryptoPage(page,'spot'),page);
});
test('four current READY watch feeds cannot invent all-market or OOS proof',()=>{
  const src=fixture(),a=event(),b=event({market:'CRYPTO_FUTURES',
    symbol:'ETHUSDT',direction:'DOWN',movePercent:-2});
  for(const row of src.markets){
    if(row.market==='KR_STOCK'||row.market==='US_STOCK'){
      row.status='READY';row.source=row.market==='KR_STOCK'
        ?'KRX_DOCUMENTED_PUBLIC':'US_LICENSED_PUBLIC';
      row.listedCount=2;row.observedCount=2;
    }
  }
  src.status='OBSERVING_ALL_FOUR';
  const result=verifyV3WatchHandoff(src,[a,b],{
    nowMs:NOW,expectedResearchSha:SHA,
  });
  assert.equal(result.status,'VALIDATED');
  assert.equal(result.report.currentWatchReadyMarketCount,4);
  assert.equal(result.report.fullMarketCoverageProven,false);
  assert.equal(result.report.oosPassProven,false);
  assert.equal(result.report.tradingSignalCount,0);
});

test('bad digest, wrong market, stale tick, unsafe authority and count mismatch fail closed',()=>{
  const a=event(),b=event({market:'CRYPTO_FUTURES',symbol:'ETHUSDT',
    direction:'DOWN',movePercent:-2});
  const fail=events=>verifyV3WatchHandoff(fixture(),events,{
    nowMs:NOW,expectedResearchSha:SHA});
  assert.equal(fail([a,{...b,score:999}]).status,'EVENT_PROOF_INVALID');
  assert.equal(fail([a,{...b,paperAdmitted:true}]).status,'EVENT_PROOF_INVALID');
  assert.equal(fail([a,{...b,market:'CRYPTO_SPOT'}]).status,'EVENT_PROOF_INVALID');
  assert.equal(fail([a,{...b,sourceAtMs:NOW-400_000}]).status,'EVENT_PROOF_INVALID');
  assert.equal(fail([a]).status,'EVENT_COUNT_MISMATCH');
  assert.equal(fail([a,{...b,eventId:'b'.repeat(64)}]).status,'EVENT_PROOF_INVALID');
  assert.equal(verifyV3WatchHandoff(fixture(),[a,b],{
    nowMs:NOW+400_000,expectedResearchSha:SHA}).status,'SOURCE_STALE');
  assert.equal(verifyV3WatchHandoff(fixture(),[a,b],{
    nowMs:NOW,expectedResearchSha:'b'.repeat(40)}).status,'SOURCE_INVALID');
});
test('cash-market DOWN is retained as context and never a sell/short priority',()=>{
  const src=fixture(),a=event({market:'CRYPTO_SPOT',direction:'DOWN',
    movePercent:-1.2}),b=event({market:'CRYPTO_FUTURES',symbol:'BTCUSDT'});
  const result=verifyV3WatchHandoff(src,[a,b],{nowMs:NOW,expectedResearchSha:SHA});
  assert.equal(result.report.byMarket.CRYPTO_SPOT.downsideContextOnly,1);
  assert.equal(result.report.byMarket.CRYPTO_SPOT.stageTwoEligible,0);
  assert.equal(result.priorities.length,1);
});
test('read-only file handoff enforces private files, exact SHA, and no activation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'v3-watch-test-'));
  try{
    await mkdir(join(root,'latest'),{mode:0o700});
    await mkdir(join(root,'watch','events'),{recursive:true,mode:0o700});
    const src=fixture(),a=event(),b=event({market:'CRYPTO_FUTURES',
      symbol:'ETHUSDT',direction:'DOWN',movePercent:-2});
    const statusPath=join(root,'latest','lightweight-market-watch.json');
    const eventPath=join(root,'watch','events',WATCH.slice(0,10)+'.jsonl');
    await writeFile(statusPath,JSON.stringify(src)+'\n',{mode:0o600});
    await writeFile(eventPath,[a,b].map(JSON.stringify).join('\n')+'\n',{mode:0o600});
    assert.equal((await readV3StageOneWatch({
      enabled:false,root,nowMs:NOW,expectedResearchSha:SHA})).status,'DISABLED');
    const good=await readV3StageOneWatch({
      enabled:true,root,nowMs:NOW,expectedResearchSha:SHA});
    assert.equal(good.status,'PARTIAL_SOURCE');
    assert.equal(good.priorities.length,2);
    assert.equal((await readV3StageOneWatch({enabled:true,root,nowMs:NOW,
      expectedResearchSha:'b'.repeat(40)})).priorities.length,0);
    await rm(eventPath);
    await symlink(statusPath,eventPath);
    assert.equal((await readV3StageOneWatch({enabled:true,root,nowMs:NOW,
      expectedResearchSha:SHA})).status,'WATCH_INPUT_UNSAFE');
    await rm(eventPath);
    await link(statusPath,eventPath);
    assert.equal((await readV3StageOneWatch({enabled:true,root,nowMs:NOW,
      expectedResearchSha:SHA})).status,'WATCH_INPUT_UNSAFE');
  }finally{await rm(root,{recursive:true,force:true});}
});

test('watch read-only failures distinguish missing inputs and V3 service permission denial',()=>{
 for(const code of ['EACCES','EPERM'])
   assert.equal(classifyV3WatchReadError({code,message:'secret-private-path'}),
     'WATCH_PERMISSION_DENIED');
 assert.equal(classifyV3WatchReadError({code:'ENOENT'}),'WATCH_NOT_PUBLISHED');
 for(const message of ['PUBLIC_WATCH_PATH_UNSAFE','PUBLIC_WATCH_FILE_UNSAFE',
   'PUBLIC_WATCH_FILE_CHANGED','PUBLIC_WATCH_EVENT_LOG_TRUNCATED'])
   assert.equal(classifyV3WatchReadError({message}),'WATCH_INPUT_UNSAFE');
 assert.equal(classifyV3WatchReadError(new SyntaxError('PRIVATE_PAYLOAD')),'WATCH_INPUT_INVALID_JSON');
 assert.equal(classifyV3WatchReadError(new Error('secret db hostname')),'SOURCE_UNAVAILABLE');
 assert.ok(!JSON.stringify(classifyV3WatchReadError({code:'EPERM',message:'secrets'})).includes('secret'));
});
