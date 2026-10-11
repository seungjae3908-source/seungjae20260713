import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizePublicCycleHealth,createPublicOnlyCycleController} from '../src/public-cycle-supervisor.mjs';
const SHA='a'.repeat(40),START=Date.parse('2026-10-11T00:00:00Z');
const MARKETS=['KR_STOCK','US_STOCK','CRYPTO_SPOT','CRYPTO_FUTURES'];
const PROFILES=['SCALPING','SWING','MID_LONG'];
function snapshot(now=START){
 return {serviceSha:SHA,publicDataOnly:true,safety:{executionAuthority:'NONE'},
  generatedAt:new Date(now).toISOString(),profile:{fullStrategyCoverage:true},
  coverage:MARKETS.flatMap(market=>PROFILES.map(strategy=>({
    market,strategy,status:'VALID_NO_TRADE',providerErrors:0,timeouts:0,
    eligibleIndexProgress:{lastRound:{allEligibleIndexPagesVerified:false,fullMarketConstituentProof:false}}
  })))};
}
test('a repeated 24-hour VIRTUAL clock cannot claim a real 24-hour provider observation',()=>{
 let current=START,invoked=0;
 const clock=()=>current,c=createPublicOnlyCycleController({serviceSha:SHA,now:clock,
   minIntervalMs:120000,maxHistory:20});
 for(let i=0;i<720;i++){
   const started=c.start();assert.equal(started.allowed,true);
   assert.equal(c.start().reason,'IN_FLIGHT');
   current+=5000;
   const done=c.finish({snapshot:snapshot(current)});
   assert.equal(done.ok,true);invoked++;
   assert.equal(c.start().reason,'INTERVAL_NOT_DUE');
   current+=120000;
 }
 const h=c.health();
 assert.equal(invoked,720);
 assert.equal(h.completed,720);
 assert.equal(h.failed,0);
 assert.ok(h.observationsInPast24h<=20);
 assert.equal(h.actualContinuous24hVerified,false);
 assert.equal(h.fullMarketVerified,false);
 assert.equal(h.noRealOrders,true);
});
test('bad source identities, stale cycles and missing lanes are fail-closed without a success mark',()=>{
 let current=START,c=createPublicOnlyCycleController({serviceSha:SHA,now:()=>current});
 c.start();
 assert.equal(c.finish({snapshot:{...snapshot(),serviceSha:'b'.repeat(40)}}).ok,false);
 assert.equal(c.health().completed,0);
 assert.equal(c.health().failed,1);
 current+=120001;c.start();
 assert.equal(c.finish({snapshot:{...snapshot(current),coverage:snapshot(current).coverage.slice(1)}}).ok,false);
 assert.equal(c.health().completed,0);
 current+=120001;c.start();
 assert.equal(c.finish({snapshot:{...snapshot(current),safety:{executionAuthority:'LIVE'}}}).ok,false);
 assert.equal(c.health().completed,0);
});
test('completed eligible index pages, blocked and provider errors remain distinct from trade authority',()=>{
 const s=snapshot();
 s.coverage[0].status='BLOCKED_DATA';
 s.coverage[1].status='SEARCH_FAILURE';
 s.coverage[1].providerErrors=2;
 s.coverage[2].eligibleIndexProgress.lastRound.allEligibleIndexPagesVerified=true;
 const h=summarizePublicCycleHealth(s,SHA,START);
 assert.equal(h.markets.KR_STOCK.blockedBatches,1);
 assert.equal(h.markets.KR_STOCK.failedBatches,1);
 assert.equal(h.markets.KR_STOCK.providerErrors,2);
 assert.equal(h.markets.KR_STOCK.sourceEligibleRoundVerifications,1);
 assert.equal(h.profitabilityProven,false);
 assert.equal(h.actualContinuous24hVerified,false);
});

test('a prior successful snapshot less than 15 minutes old cannot be reused as another cycle',()=>{
 let current=START;
 const c=createPublicOnlyCycleController({
  serviceSha:SHA,now:()=>current,minIntervalMs:60000,
 });
 assert.equal(c.start().allowed,true);
 current+=2000;
 assert.equal(c.finish({snapshot:snapshot(current)}).ok,true);
 current+=60001;
 assert.equal(c.start().allowed,true);
 current+=1000;
 const replay=c.finish({snapshot:snapshot(START+2000)});
 assert.equal(replay.ok,false);
 assert.equal(replay.reason,'PUBLIC_SUPERVISOR_OUT_OF_CYCLE_SNAPSHOT');
 assert.equal(c.health().completed,1);
 assert.equal(c.health().failed,1);
 assert.equal(c.health().actualContinuous24hVerified,false);
});
