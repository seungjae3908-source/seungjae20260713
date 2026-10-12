import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {planV3FourMarketDataRecovery} from '../src/public-v3-data-recovery-plan.mjs';
const EPOCH='11111111-1111-4111-8111-111111111111';
const MARKETS={KR_STOCK:['KR','krx-symbol-master'],
 US_STOCK:['US','nasdaq-trader-public-directory'],
 CRYPTO_SPOT:['SPOT','upbit-public'],
 CRYPTO_FUTURES:['FUTURES','bitget-public']};
const SLOTS=[['SCALPING_15M','SCALPING','15m'],
 ['SWING_60M','SWING','60m'],['MID_LONG_1D','MID_LONG','1D']];
function receipts(){
 return Object.entries(MARKETS).flatMap(([market,[prefix,source]])=>
  SLOTS.map(([frame,strategy,timeframe])=>{
   const good=market==='CRYPTO_FUTURES'
    ||market==='US_STOCK'&&timeframe==='1D'
    ||market==='CRYPTO_SPOT'&&timeframe!=='15m';
   return{laneId:prefix+'_'+frame,market,sourceCycleId:EPOCH,strategy,timeframe,
    universeSource:source,universePartial:market==='KR_STOCK',
    universeExplainedExcludedCount:market==='KR_STOCK'?2496:0,
    universeStale:false,universeProviderErrors:0,
    status:good?'CANDIDATES_AVAILABLE':'BLOCKED_DATA',
    scannedCards:1,retainedFromBatch:good?1:0,
    lastGoodPreserved:!good,cursorRotatedBlockedOnly:!good,
    responseDataState:good?'complete':'untrusted',
    cursorBefore:0,cursorAfter:5,totalUniverse:200,
    providerErrors:0,timeouts:0,
    publicExecutionDiagnostic:{state:'PAGE_EXECUTION_COMPLETE',requested:5,
     started:5,completed:5,partial:false,timedOut:false,
     providerErrors:0,timeouts:0,failuresObserved:0},
    publicStockQualityDiagnostic:market.endsWith('STOCK')
     ?{stateCounts:{DATA_UNTRUSTED:good?0:1},
       issueCounts:{'MISSING_CANDLE:blocking':good?0:2}}:null,
    publicCryptoQualityDiagnostic:market==='CRYPTO_SPOT'
     ?{qualityStates:{DATA_UNTRUSTED:good?0:1},
       qualityIssues:{'MISSING_CANDLE:blocking':good?0:1}}:null,
   };
  }));
}
test('original four-market source gap plan is honest about 6 ready pages, not full history',()=>{
 const report=planV3FourMarketDataRecovery(receipts());
 assert.equal(report.sourceReadyPages,6);
 assert.equal(report.markets.KR_STOCK.sourceReadyPages,0);
 assert.equal(report.markets.KR_STOCK.knownRosterExcluded,2496);
 assert.equal(report.markets.US_STOCK.sourceReadyPages,1);
 assert.equal(report.markets.CRYPTO_SPOT.sourceReadyPages,2);
 assert.equal(report.markets.CRYPTO_FUTURES.sourceReadyPages,3);
 assert.equal(report.markets.CRYPTO_FUTURES.historicalPITVerified,false);
 assert.equal(report.archivedMinuteBarsDownloaded,0);
 assert.equal(report.addedProviderRequests,0);
 assert.equal(report.profitabilityProven,false);
 assert.equal(report.executionAuthority,'NONE');
});
test('missing/duplicated lane cannot count as source coverage',()=>{
 assert.throws(()=>planV3FourMarketDataRecovery(receipts().slice(0,11)));
 const wrong=receipts();wrong[1].laneId=wrong[0].laneId;
 assert.throws(()=>planV3FourMarketDataRecovery(wrong));
});
test('producer contains real optional economic join and environment is forced OFF',()=>{
 const code=readFileSync(new URL('../scripts/run-public-scanner-cycle.ts',import.meta.url),'utf8');
 assert.match(code,/planV3FourMarketDataRecovery\(coverage\)/u);
 assert.match(code,/loadV3SignedResearchBundle\(/u);
 assert.match(code,/attachV3SignedResearchEvidence\(card,\{lane,bridge:profitBridge\}\)/u);
 const service=readFileSync(new URL('../../signal-intelligence-release/deploy/activate-server.sh',
   import.meta.url),'utf8');
 assert.match(service,/export SIGNAL_INTELLIGENCE_V3_ECONOMIC_BRIDGE_ENABLED=false/u);
 assert.equal((service.match(/Environment=SIGNAL_INTELLIGENCE_V3_ECONOMIC_BRIDGE_ENABLED=false/gu)||[]).length,2);
});

test('unrelated source cycles may not be merged into a purported healthy four-market result',()=>{
 const lanes=receipts();
 lanes[1].sourceCycleId='22222222-2222-4222-8222-222222222222';
 assert.throws(()=>planV3FourMarketDataRecovery(lanes),
   /V3_RECOVERY_MIXED_SOURCE_CYCLES/);
});
