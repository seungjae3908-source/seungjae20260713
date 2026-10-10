import test from "node:test";
import assert from "node:assert/strict";
import { auditHistoricalIntradayOpportunitiesV1 as audit } from "../src/historical-intraday-opportunity-audit-v1.js";

const M = 60_000;
const S = Date.parse("2025-01-02T09:00:00Z");
const E = S + 120 * M;
const SESSION = { id:"2025-01-02-REGULAR", startMs:S, endMs:E };
const VENUES = {KR_STOCK:"KRX",US_STOCK:"US_SIP",CRYPTO_SPOT:"UPBIT_KRW",CRYPTO_FUTURES:"BITGET_USDT_FUTURES"};

function universe(symbols=["A","B"], overrides={}) {
  return {
    sourceId:"test-only-PIT-fixture",
    pointInTimeVerified:true, delistedIncluded:true,
    suspendedIncluded:true, expectedActiveSymbols:symbols.length,
    symbols:symbols.map((symbol) => ({symbol,priorClose:100,baselineAvailableAtMs:S-M})),
    ...overrides,
  };
}
function coverage(symbols=["A","B"], status="VERIFIED_COMPLETE") {
  return symbols.map((symbol) => ({
    symbol,status,sourceId:"test-only-provider-fixture",
    startMs:S,endMs:E,noTradeGapsChecked:true,
  }));
}
function candle(symbol,min,{open=100,high=101,low=99,close=100,volume=100,delay=0}={}) {
  return {symbol,timestampMs:S+min*M,availableAtMs:S+(min+1)*M+delay,
    open,high,low,close,volume};
}
function observation(symbol,direction,state,atMin,signalId) {
  return {symbol,direction,state,availableAtMs:S+atMin*M,
    dataCutoffMs:S+(atMin-1)*M,signalId};
}
function run(market="US_STOCK", options={}) {
  return audit({
    market,venue:VENUES[market],session:SESSION,
    universe:universe(),coverage:coverage(),watchedSymbols:["A","B"],
    bars:[
      candle("A",0),
      candle("A",10,{open:101,high:104,low:100,close:102}),
      candle("A",20,{open:105,high:111,low:103,close:108}),
      candle("A",30,{open:108,high:122,low:107,close:120}),
      candle("B",0),
      candle("B",20),
    ],
    scannerObservations:[
      observation("A","LONG","CANDIDATE",12,"sA"),
      observation("B","LONG","CANDIDATE",12,"sB"),
    ], ...options,
  });
}

test("first minute HIGH crossing is a bounded interval, not a fabricated tick", () => {
  const report=run();
  assert.equal(report.status,"OBSERVED_COHORT_ONLY");
  assert.equal(report.observedOpportunityCount,3);
  const ten=report.opportunities.find((e) => e.symbol==="A" && e.thresholdPct===10);
  assert.equal(ten.firstCrossingBarStartMs,S+20*M);
  assert.equal(ten.firstCrossingBarEndMs,S+21*M);
  assert.equal(ten.firstCrossingExactTickTimestampMs,null);
  assert.equal(ten.firstPreCrossingSignalAtMs,S+12*M);
  assert.equal(ten.discoveredBeforeCrossing,true);
  assert.equal(ten.tMinusFeatures.T_MINUS_5.lastBarStartMs,S+10*M);
  assert.equal(ten.tMinusFeatures.T_MINUS_5.lastClose,102);
  assert.equal(ten.tMinusFeatures.T_MINUS_15.lastBarStartMs,S);
  assert.equal(ten.tMinusFeatures.T_MINUS_60,null);
  assert.equal(report.intrabarFirstCrossingTimestampKnown,false);
  assert.equal(report.trueMarketWideRecall,null);
  assert.equal(report.actualFillCount,null);
  assert.equal(report.profitabilityProven,false);
  assert.equal(report.executionAuthority,"NONE");
});

test("canonical search quality sees missed candidates and false positives, not fictitious fills", () => {
  const result=run();
  for (const pct of [5,10,20]) {
    const quality=result.quality.byHorizon["FIRST_"+pct+"PCT"];
    assert.equal(quality.groundTruthOpportunityCount,1);
    assert.equal(quality.matchedOpportunityCount,1);
    assert.equal(quality.signalCount,2);
    assert.equal(quality.falsePositiveCount,1);
    assert.equal(quality.recall,1);
    assert.equal(quality.precision,.5);
  }
  assert.equal(result.quality.overall?.hitCount ?? 3,3);
});

test("missing PIT proof or data coverage blocks instead of reporting zero return", () => {
  assert.equal(run("US_STOCK",{universe:universe(["A","B"],{pointInTimeVerified:false})}).status,"BLOCKED_DATA");
  const result=run("US_STOCK",{coverage:coverage(["A"])});
  assert.equal(result.status,"BLOCKED_DATA");
  assert.equal(result.reason,"INTRADAY_SOURCE_COVERAGE_MISSING");
  assert.deepEqual(result.details.blockedSymbols,["B"]);
  assert.equal(result.observedOpportunityCount,null);
  assert.equal(result.quality,null);
});

test("cross-venue substitutes never get credit for target venue", () => {
  const spot=run("CRYPTO_SPOT",{venue:"BINANCE_USDT"});
  assert.equal(spot.status,"BLOCKED_DATA");
  assert.equal(spot.reason,"EXECUTION_VENUE_MISMATCH");
  assert.equal(run("CRYPTO_FUTURES",{venue:"BINANCE_FUTURES"}).status,"BLOCKED_DATA");
});

test("same-bar detection is not early detection, even if a candle high reaches target", () => {
  const result=run("KR_STOCK",{
    scannerObservations:[observation("A","LONG","CANDIDATE",20,"not-yet-early")],
  });
  const ten=result.opportunities.find((e)=>e.thresholdPct===10);
  assert.equal(ten.discoveredBeforeCrossing,false);
  assert.equal(result.quality.byHorizon.FIRST_10PCT.recall,0);
  assert.equal(ten.missingOrEntryReason,"SCANNER_EVIDENCE_MISSING");
});

test("scanner future cutoff is rejected and late-discovered signals cannot earn early credit", () => {
  assert.throws(()=>run("US_STOCK",{
    scannerObservations:[{symbol:"A",direction:"LONG",state:"CANDIDATE",
      availableAtMs:S+12*M,dataCutoffMs:S+13*M,signalId:"lookahead"}],
  }),/SCANNER_CAUSAL_PROVENANCE_INVALID/);
  const result=run("US_STOCK",{
    scannerObservations:[observation("A","LONG","CANDIDATE",25,"late")],
  });
  assert.equal(result.opportunities.find((e)=>e.thresholdPct===10).discoveredBeforeCrossing,false);
  assert.equal(result.quality.byHorizon.FIRST_10PCT.recall,0);
});

test("futures SHORT is scored independently, and stock/spot SHORT is forbidden", () => {
  const result=run("CRYPTO_FUTURES",{
    universe:universe(["BTCUSDT"]),
    coverage:coverage(["BTCUSDT"]),
    watchedSymbols:["BTCUSDT"],
    bars:[candle("BTCUSDT",0),candle("BTCUSDT",20,{open:99,high:100,low:89,close:92})],
    scannerObservations:[observation("BTCUSDT","SHORT","CANDIDATE",12,"btc-short")],
  });
  const short=result.opportunities.filter((e)=>e.direction==="SHORT");
  assert.equal(short.length,2);
  assert.deepEqual(short.map((e)=>e.thresholdPct),[5,10]);
  assert.equal(result.quality.byHorizon.FIRST_10PCT.recall,1);
  assert.throws(()=>run("CRYPTO_SPOT",{
    scannerObservations:[observation("A","SHORT","CANDIDATE",12,"forbidden")],
  }),/MARKET_DIRECTION_NOT_ALLOWED/);
});

test("primary missed-opportunity reasons distinguish watchlist, signal and entry", () => {
  const missing=run("KR_STOCK",{
    watchedSymbols:["B"],
    scannerObservations:[],
  });
  assert.equal(missing.opportunities[0].missingOrEntryReason,"UNIVERSE_MISSING");
  const missed=run("KR_STOCK",{
    scannerObservations:[observation("A","LONG","OBSERVED_NO_SIGNAL",12)],
  });
  assert.equal(missed.opportunities[0].missingOrEntryReason,"SIGNAL_MISSED");
  const blocked=run("KR_STOCK",{
    scannerObservations:[observation("A","LONG","ENTRY_BLOCKED",12,"sA")],
  });
  assert.equal(blocked.opportunities[0].discoveredBeforeCrossing,true);
  assert.equal(blocked.opportunities[0].missingOrEntryReason,"ENTRY_BLOCKED");
});

test("opening gap beyond threshold is labeled rather than credited as early entry", () => {
  const result=run("KR_STOCK",{
    universe:universe(["A"]),
    coverage:coverage(["A"]),
    bars:[candle("A",0,{open:111,high:115,low:110,close:112})],
    scannerObservations:[],
  });
  const ten=result.opportunities.find((e)=>e.thresholdPct===10);
  assert.equal(ten.openedAlreadyBeyondThreshold,true);
  assert.equal(ten.discoveredBeforeCrossing,false);
});

test("duplicate bars and unverifiable no-trade gaps fail closed", () => {
  const row=candle("A",0);
  assert.equal(run("US_STOCK",{bars:[row,row]}).reason,"DUPLICATE_MINUTE_CANDLE");
  assert.equal(run("US_STOCK",{coverage:coverage().map((r)=>({...r,noTradeGapsChecked:false}))}).status,"BLOCKED_DATA");
});

test("all four markets remain research-only under venue-aligned inputs", () => {
  for (const market of Object.keys(VENUES)) {
    const result=run(market);
    assert.equal(result.venueMatched,true);
    assert.equal(result.statusNotEligibleForLivePromotion,true);
    assert.equal(result.costAdjustedProfitabilityProven,false);
    assert.equal(result.fullMarketOpportunityDenominatorVerified,false);
  }
});
