import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoricalScannerFunnelReadinessV1 as build } from "../src/historical-scanner-evidence-funnel-v1.js";
const MIN=60_000, start=Date.parse("2025-02-03T00:00:00Z"), end=start+1440*MIN;
const sha="a".repeat(64);
function observed({market="CRYPTO_FUTURES",direction="SHORT",crossingAt=109, pct=5,
  events=1,openBeyond=false}={}){
  const venue=market==="CRYPTO_FUTURES"?"BITGET_USDT_FUTURES":"UPBIT_KRW";
  const symbol=market==="CRYPTO_FUTURES"?"BTCUSDT":"KRW-BTC";
  const opportunities=events? [{
    eventId:[market,venue,symbol,start,direction,pct].join(":"),
    market,venue,symbol,direction,thresholdPct:pct,
    firstCrossingBarStartMs:start+crossingAt*MIN,
    firstCrossingBarEndMs:start+(crossingAt+1)*MIN,
    openedAlreadyBeyondThreshold:openBeyond,
    exactTradeTimestampMs:null,
    firstSeenByHistoricalScannerAtMs:null,
    actualExecutableEntryPrice:null,
  }]:[];
  return {
    status:"OBSERVED_DAY_ONLY",market,venue,symbol,
    utcDayStartMs:start,utcDayEndMs:end,
    previousUtcClose:100,observedMinuteCount:1440,priorHourObservedMinuteCount:60,
    baselineDefinition:"PREVIOUS_UTC_DAY_FINAL_1M_CLOSE_SAME_VENUE",
    sourceAcquiredAfterDay:true,rawCandleSha256:sha,
    opportunities,observedDayCrossingCount:opportunities.length,
    fullMarketListedAndDelistedUniverseProven:false,
    historicalScannerAsOfAvailabilityVerified:false,
    trueMarketWideRecall:null,actualFillCount:null,netProfitPct:null,
  };
}
function receipt({futures=observed(),spot=observed({market:"CRYPTO_SPOT",events:0})}={}){
  return {
    schemaVersion:"native-utc-day-historical-public-1m-audit-v1",
    sampledDay:{utcDayStartMs:start,utcDayEndMs:end},
    markets:{
      KR_STOCK:{status:"BLOCKED_DATA",reason:"PIT_STOCK_FEED_MISSING"},
      US_STOCK:{status:"BLOCKED_DATA",reason:"PIT_SIP_MISSING"},
      CRYPTO_SPOT:spot,CRYPTO_FUTURES:futures,
    },
    executionAuthority:"NONE",profitabilityProven:false,
    fullMarketOpportunityDenominatorVerified:false,trueMarketWideRecall:null,
  };
}
function ledger(market="CRYPTO_FUTURES",opts={}){
  const venue=market==="CRYPTO_FUTURES"?"BITGET_USDT_FUTURES":"UPBIT_KRW";
  const symbol=market==="CRYPTO_FUTURES"?"BTCUSDT":"KRW-BTC";
  const watch=opts.watch??true, signalAt=opts.signalAt, stageAt=opts.stageAt;
  const snapshots=Array.from({length:1440},(_,i)=>{
    const minute=start+i*MIN;
    const dataCutoffMs=i===0?minute-1:minute;
    return {
      asOfMs:minute,persistedAtMs:minute+1_000,dataCutoffMs,
      watchedSymbols:watch?[symbol]:[],
      status:opts.staleAt===i?"DATA_DELAYED":"READY",
      signals:signalAt===i?[{
        signalId:"signal-1",symbol,direction:market==="CRYPTO_FUTURES"?"SHORT":"LONG",
        stage:"CANDIDATE",availableAtMs:minute+500,
      }]:stageAt===i?[{
        signalId:"signal-1",symbol,direction:market==="CRYPTO_FUTURES"?"SHORT":"LONG",
        stage:opts.stage??"ENTRY_BLOCKED",availableAtMs:minute+500,
      }]:[],
    };
  });
  return {
    schemaVersion:"historical-scanner-prospective-ledger-v1",
    market,venue,startMs:start,endMs:end,
    sourceId:"unit-test-mock-capture",
    sourceEvidenceSha256:"b".repeat(64),
    captureMode:"TEST_FIXTURE",testOnly:true,snapshots,
  };
}
test("real native observed source without old scanner ledger is UNKNOWN not zero recall",()=>{
  const result=build({nativeUtcDayReport:receipt()});
  const future=result.markets.CRYPTO_FUTURES;
  assert.equal(result.status,"RESEARCH_COHORT_ONLY");
  assert.equal(result.observedOpportunityCountInAvailableSamples,1);
  assert.equal(future.observedOpportunityCount,1);
  assert.equal(future.earlyDetectedCount,null);
  assert.equal(future.observedCohortEarlyRecall,null);
  assert.equal(future.falsePositiveSignals,null);
  assert.equal(future.reasonCounts.SCANNER_LEDGER_NOT_AVAILABLE,1);
  assert.equal(future.opportunities[0].earlyDetected,null);
  assert.equal(result.trueMarketWideRecall,null);
  assert.equal(result.realTradeCount,null);
  assert.equal(result.profitabilityProven,false);
  assert.equal(result.executionAuthority,"NONE");
});
test("missing stock sources are NULL, not zero observed opportunities",()=>{
  const r=build({nativeUtcDayReport:receipt()});
  for(const key of ["KR_STOCK","US_STOCK"]){
    assert.equal(r.markets[key].status,"BLOCKED_DATA");
    assert.equal(r.markets[key].observedOpportunityCount,null);
    assert.equal(r.markets[key].observedCohortEarlyRecall,null);
    assert.equal(r.markets[key].netProfitPct,null);
  }
});
test("only complete 1440 original heartbeats can support fixture cohort detection",()=>{
  const l=ledger("CRYPTO_FUTURES",{signalAt:40,stageAt:41});
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  const item=r.markets.CRYPTO_FUTURES;
  assert.equal(item.status,"TEST_FIXTURE_ONLY");
  assert.equal(item.earlyDetectedCount,1);
  assert.equal(item.observedCohortEarlyRecall,1);
  assert.equal(item.opportunities[0].discoveryStatus,"ENTRY_BLOCKED");
  assert.equal(item.opportunities[0].matchedSignalId,"signal-1");
  assert.equal(item.opportunities[0].observedLeadLowerBoundMs,(109*MIN)-(40*MIN+1000));
  assert.equal(item.metrics.evidenceClassification,"SYNTHETIC_CONTRACT_TEST_ONLY");
  assert.equal(r.trueMarketWideRecall,null);
  assert.equal(item.actualFillCount,null);
});
test("never count a signal timestamped after first crossing as early detection",()=>{
  const l=ledger("CRYPTO_FUTURES",{signalAt:109});
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  assert.equal(r.markets.CRYPTO_FUTURES.earlyDetectedCount,0);
  assert.equal(r.markets.CRYPTO_FUTURES.opportunities[0].discoveryStatus,"SIGNAL_MISSED");
});
test("watchlist omitted from every prospective minute is universe missing, not false signal",()=>{
  const l=ledger("CRYPTO_FUTURES",{watch:false});
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  assert.equal(r.markets.CRYPTO_FUTURES.opportunities[0].discoveryStatus,"UNIVERSE_MISSING");
  assert.equal(r.markets.CRYPTO_FUTURES.observedCohortEarlyRecall,0);
  assert.equal(r.trueMarketWideRecall,null);
});
test("missing one genuine scanner heartbeat blocks counts instead of inventing 0%",()=>{
  const l=ledger();l.snapshots.splice(42,1);
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  const f=r.markets.CRYPTO_FUTURES;
  assert.equal(f.status,"SCANNER_LEDGER_BLOCKED");
  assert.equal(f.earlyDetectedCount,null);
  assert.equal(f.observedCohortEarlyRecall,null);
  assert.equal(f.reason,"HISTORICAL_SCANNER_LEDGER_UNVERIFIED");
});
test("retrospectively persisted old signals cannot become a time-machine detection",()=>{
  const l=ledger("CRYPTO_FUTURES",{signalAt:40});
  l.snapshots[40].persistedAtMs=end+MIN;
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  assert.equal(r.markets.CRYPTO_FUTURES.status,"SCANNER_LEDGER_BLOCKED");
  assert.equal(r.markets.CRYPTO_FUTURES.reason,"SCANNER_HEARTBEAT_OR_ASOF_GAP");
});
test("stale source labeled READY is rejected even if candidate is present",()=>{
  const l=ledger("CRYPTO_FUTURES",{signalAt:40});
  l.snapshots[40].dataCutoffMs=start+35*MIN;
  const r=build({nativeUtcDayReport:receipt(),scannerLedgers:{CRYPTO_FUTURES:l}});
  assert.equal(r.markets.CRYPTO_FUTURES.reason,"SCANNER_STALE_DATA_MISLABELED_READY");
});
test("spot SHORT and duplicated event IDs are not valid ground truth",()=>{
  const bad=observed({market:"CRYPTO_SPOT",direction:"SHORT"});
  const a=build({nativeUtcDayReport:receipt({spot:bad})});
  assert.equal(a.markets.CRYPTO_SPOT.status,"BLOCKED_DATA");
  assert.equal(a.markets.CRYPTO_SPOT.reason,"OBSERVED_EVENT_CONTRACT_INVALID");
  const duplicate=observed();
  duplicate.opportunities=[duplicate.opportunities[0],duplicate.opportunities[0]];
  duplicate.observedDayCrossingCount=2;
  const b=build({nativeUtcDayReport:receipt({futures:duplicate})});
  assert.equal(b.markets.CRYPTO_FUTURES.status,"BLOCKED_DATA");
});
test("opening already past target is not a genuine same-day advance detection",()=>{
  const o=observed({crossingAt:0,openBeyond:true});
  const l=ledger();
  const r=build({nativeUtcDayReport:receipt({futures:o}),scannerLedgers:{CRYPTO_FUTURES:l}});
  assert.equal(r.markets.CRYPTO_FUTURES.opportunities[0].discoveryStatus,"OPEN_ALREADY_BEYOND_THRESHOLD");
});
test("invalid gross-profit and live receipt fails closed at root",()=>{
  const x=receipt();x.profitabilityProven=true;
  assert.throws(()=>build({nativeUtcDayReport:x}),/RESEARCH_SAFETY_RECEIPT_INVALID/);
});
