import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeV3BlockerTriage} from '../src/public-v3-blocker-triage.mjs';
const markets={KR:'KR_STOCK',US:'US_STOCK',SPOT:'CRYPTO_SPOT',FUTURES:'CRYPTO_FUTURES'};
const EPOCH='11111111-1111-4111-8111-111111111111';
const cover=()=>Object.entries(markets).flatMap(([prefix,market])=>
  [['SCALPING_15M','SCALPING','15m'],['SWING_60M','SWING','60m'],['MID_LONG_1D','MID_LONG','1D']]
    .map(([id,strategy,timeframe])=>({
      laneId:prefix+'_'+id,market,strategy,timeframe,sourceCycleId:EPOCH,
      universeSource:market==='KR_STOCK'?'krx-symbol-master'
        :market==='US_STOCK'?'nasdaq-trader-public-directory'
          :market==='CRYPTO_SPOT'?'upbit-public':'bitget-public',
      status:'VALID_NO_TRADE',lastGoodPreserved:false,cursorRotatedBlockedOnly:false,
      universePartial:false,universeStale:false,responseDataState:'complete',
      universeProviderErrors:0,providerErrors:0,timeouts:0,
      scannedCards:0,retainedFromBatch:0,
      cursorBefore:0,cursorAfter:20,totalUniverse:100,
      publicExecutionDiagnostic:{
        state:'PAGE_EXECUTION_COMPLETE',requested:20,started:20,completed:20,
        partial:false,timedOut:false,providerErrors:0,timeouts:0,
        failuresObserved:0,
      },
    })));
const evidence=()=>({
  schemaVersion:'public-v3-economic-readiness-v1',totalRows:1,
  byMarket:Object.fromEntries(Object.values(markets).map(m=>[m,{
    examined:m==='KR_STOCK'?1:0,canonicalProofAbsent:m==='KR_STOCK'?1:0,
    backtestIdentityMissing:m==='KR_STOCK'?1:0,
    backtestEvidenceMissing:m==='KR_STOCK'?1:0,
    backtestOosOrWalkForwardMissing:0,
    backtestFullCostIncomplete:0,
  }])),
});
test('valid twelve-lane market source diagnosis does not claim OOS or all-symbol coverage',()=>{
  const rows=cover(),economics=evidence();
  const s=summarizeV3BlockerTriage(rows,economics);
  assert.equal(s.sourceReadyLanes,12);
  assert.equal(s.sourceBlockedLanes,0);
  assert.equal(s.byMarket.KR_STOCK.proofInputs,1);
  assert.equal(s.byMarket.KR_STOCK.backtestQualityMissing,1);
  assert.equal(s.claims.independentOosPassProven,false);
  assert.equal(s.claims.eligibleCursorPassIsAllSymbolCoverage,false);
  assert.equal(s.economicAuthority,'NONE');
});
test('partially excluded KRX roster is counted once, not per timeframe',()=>{
  const rows=cover();
  for(const row of rows.filter(x=>x.market==='KR_STOCK')){
    row.status='BLOCKED_DATA';row.universePartial=true;
    row.universeExplainedExcludedCount=2496;
    row.lastGoodPreserved=true;
  }
  rows[3].status='SEARCH_FAILURE';rows[3].providerErrors=13;
  rows[4].status='BLOCKED_DATA';rows[4].publicStockQualityDiagnostic={
    issueCounts:{'MISSING_CANDLE:blocking':14},
    stateCounts:{DATA_UNTRUSTED:14},
  };
  rows[6].status='BLOCKED_DATA';rows[6].publicCryptoQualityDiagnostic={
    qualityIssues:{'MISSING_CANDLE:blocking':1},
    qualityStates:{DATA_UNTRUSTED:1},
  };
  const s=summarizeV3BlockerTriage(rows,evidence());
  assert.equal(s.byMarket.KR_STOCK.rosterExcludedKnown,2496);
  assert.equal(s.byMarket.KR_STOCK.rosterPartialLanes,3);
  assert.equal(s.byMarket.US_STOCK.providerErrorLanes,1);
  assert.equal(s.byMarket.US_STOCK.missingCandleBlockingCards,14);
  assert.equal(s.byMarket.CRYPTO_SPOT.missingCandleBlockingCards,1);
  assert.equal(s.sourceBlockedLanes,6);
  assert.equal(s.addedProviderRequests,0);
});
test('malformed or duplicate source lanes fail closed rather than fabricate a complete report',()=>{
  const a=cover();
  a[0].laneId=a[1].laneId;
  assert.throws(()=>summarizeV3BlockerTriage(a,evidence()),/LANE_INVALID/);
  assert.throws(()=>summarizeV3BlockerTriage(cover().slice(1),evidence()),/INPUT_INVALID/);
  const e=evidence();e.byMarket.US_STOCK.examined=2;
  assert.throws(()=>summarizeV3BlockerTriage(cover(),e),/ECONOMIC_INVALID/);
});
test('source instrumentation never exports redacted ticker or candle contents',()=>{
  const rows=cover();
  rows[0].providerRawSymbol='PRIVATE_UNDISTRIBUTABLE_TICKER';
  rows[0].publicStockQualityDiagnostic={issueCounts:{'MISSING_CANDLE:blocking':1,
    'SECRET_SENSITIVE_OHLC':100},secret:'SECRET_CANDLE'};
  const report=JSON.stringify(summarizeV3BlockerTriage(rows,evidence()));
  assert.ok(!report.includes('PRIVATE_UNDISTRIBUTABLE_TICKER'));
  assert.ok(!report.includes('SECRET_CANDLE'));
  assert.ok(!report.includes('SECRET_SENSITIVE_OHLC'));
});

test('triage uses the exact canonical page proof, never just green status metadata',()=>{
  const base=cover();
  assert.equal(summarizeV3BlockerTriage(base,evidence()).sourceReadyLanes,12);
  const absent=cover();
  delete absent[0].publicExecutionDiagnostic;
  assert.equal(summarizeV3BlockerTriage(absent,evidence()).sourceReadyLanes,11);
  const incomplete=cover();
  incomplete[1].publicExecutionDiagnostic.completed=19;
  assert.equal(summarizeV3BlockerTriage(incomplete,evidence()).sourceReadyLanes,11);
  const wrongProvider=cover();
  wrongProvider[3].universeSource='bitget-public';
  assert.equal(summarizeV3BlockerTriage(wrongProvider,evidence()).sourceReadyLanes,11);
  const greenButNoCards=cover();
  greenButNoCards[1].status='CANDIDATES_AVAILABLE';
  assert.equal(summarizeV3BlockerTriage(greenButNoCards,evidence()).sourceReadyLanes,11);
});
test('cross-cycle stale source rows and cross-market input counts cannot claim 12 healthy current pages',()=>{
  const old=cover();
  old[0].sourceCycleId='22222222-2222-4222-8222-222222222222';
  assert.throws(()=>summarizeV3BlockerTriage(old,evidence()),/LANE_INVALID/);
  const missing=cover();
  delete missing[0].sourceCycleId;
  assert.throws(()=>summarizeV3BlockerTriage(missing,evidence()),/SOURCE_CYCLE_INVALID/);
  const total=evidence();
  total.totalRows=2;
  assert.throws(()=>summarizeV3BlockerTriage(cover(),total),/ECONOMIC_INVALID/);
});
