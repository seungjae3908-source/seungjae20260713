import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {persistResearchMinuteSessionV1} from "../src/research-minute-archive-v1.js";
import {digestPITMembershipRowsV1} from "../src/historical-pit-venue-universe-gate-v1.js";
import {runFourMarketOriginalMinuteReplayV1 as replay} from
  "../src/four-market-original-minute-replay-v1.js";

const D=Date.parse("2026-09-18T00:00:00Z"),DAY=86_400_000,MIN=60_000;
const POLICY=Object.freeze({
  KR_STOCK:{symbol:"005930",venue:"KRX",zone:"Asia/Seoul",
    start:D,min:120,kind:"REGULAR"},
  US_STOCK:{symbol:"AAPL",venue:"US_SIP",zone:"America/New_York",
    start:Date.parse("2026-09-18T13:30:00Z"),min:120,kind:"REGULAR"},
  CRYPTO_SPOT:{symbol:"KRW-BTC",venue:"UPBIT_KRW",zone:"UTC",
    start:D,min:1440,kind:"UTC_24H"},
  CRYPTO_FUTURES:{symbol:"BTCUSDT",venue:"BITGET_USDT_FUTURES",zone:"UTC",
    start:D,min:1440,kind:"UTC_24H"},
});
const hash=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const root=()=>mkdtempSync(join(tmpdir(),"four-market-replay-draft-"));
function fixture(market,{retro=false,missing=false}={}){
  const p=POLICY[market],start=p.start,sourceId="TEST_ONLY_PRIVATE_ORIGINAL_1M";
  const minuteBars=Array.from({length:p.min},(_,i)=>{
    const open=100+0.025*i+Math.sin(i/6);
    const close=100+0.025*(i+1)+Math.sin((i+1)/6);
    return {market,venue:p.venue,symbol:p.symbol,sourceId,
      timestampMs:start+i*MIN,
      availableAtMs:retro?start+p.min*MIN+5*DAY:start+(i+1)*MIN,
      open,high:Math.max(open,close)+0.1,low:Math.min(open,close)-0.1,
      close,volume:100+i};
  });
  if(missing)minuteBars.splice(8,1);
  const session={startMs:start,endMs:start+p.min*MIN,kind:p.kind, timeZone:p.zone,
    calendarSourceId:"TEST_PRIVATE_HISTORIC_SESSION_NOT_OFFICIAL"};
  const source={market,venue:p.venue,symbol:p.symbol,sourceId,session,
    minuteBars,sourceMinuteRowsSha256:hash(minuteBars),
    asOfMs:start+p.min*MIN+5*DAY};
  const memberships=[
    {symbol:p.symbol,listedAtMs:D-150*DAY,removedAtMs:null,
      halts:[],sourceId:"TEST_HISTORIC_ROSTER",evidenceSha256:"a".repeat(64)},
    {symbol:"DELISTED",listedAtMs:D-140*DAY,removedAtMs:D-120*DAY,
      halts:[],sourceId:"TEST_HISTORIC_ROSTER",evidenceSha256:"a".repeat(64)},
  ];
  const manifest={
    schemaVersion:"historical-venue-pit-roster-v1",
    market,venue:p.venue,sourceClass:"TEST_FIXTURE",testOnly:true,
    sourceId:"TEST_HISTORIC_ROSTER",
    coverageStartMs:D-300*DAY,coverageEndMs:D+30*DAY,retrievedAtMs:D+40*DAY,
    allListedAndRemovedAttested:true,suspensionsAttested:true,
    relistedIdentifiersResolved:true,memberships,
    rawMembershipDigestSha256:digestPITMembershipRowsV1(memberships),
  };
  const sessionSources=[{
    date:"2026-09-18",startMs:session.startMs,endMs:session.endMs,
    zone:p.zone,kind:p.kind,
  }];
  const stockCalendar=market.endsWith("STOCK")?{
    market,tradingDates:["2015-01-05","2026-09-18","2028-01-03"],
  }:null;
  const request=(folder,override={})=>({
    root:folder,market,symbol:p.symbol,manifest,sessionSources,
    stockCalendar,asOfMs:D+35*DAY,
    researchWindow:{startDate:"2026-09-18",endDate:"2026-09-18"},
    timeframe:"5m",direction:"LONG",initialCapitalKRW:1_000_000,
    leverage:market==="CRYPTO_FUTURES"?7:1,
    // USD/USDT denominated candles need an EXPLICIT non-authoritative KRW model.
    fxRateKRWPerQuote:market==="US_STOCK"||market==="CRYPTO_FUTURES"
      ?1300:null,
    strategy:{kind:"EMA_TREND",fast:2,slow:5,stopPercent:0.8,targetPercent:1.4},
    costModel:{entryFeeRate:0.0006,exitFeeRate:0.0006,
      spreadRate:0.0004,slippageRate:0.0006,latencyRate:0.0001,
      taxRate:0,fundingRatePerSession:0},
    ...override,
  });
  return {source,request,manifest,sessionSources};
}
test("all four venues replay source-only EMA with next-bar execution and zero economic authority",async()=>{
  const folder=root();
  try{
    for(const market of Object.keys(POLICY)){
      const x=fixture(market);await persistResearchMinuteSessionV1({root:folder,source:x.source});
      const result=await replay(x.request(folder));
      assert.equal(result.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC",market);
      assert.equal(result.fixtureOnly,true,market);
      assert.equal(result.sourceDaysRead,1,market);
      assert.equal(result.sourceSessionsRead,1,market);
      assert.ok(result.modeledTradeCount>=0,market);
      assert.ok(Number.isFinite(result.modeledReturnPercent),market);
      assert.equal(result.sourceDigestChainSha256.length,64);
      assert.equal(result.historicalFullMarketPopulationIndependentlyVerified,false);
      assert.equal(result.historicalPITUniverseIndependentlyVerified,false);
      assert.equal(result.officialStockCalendarIndependentlyVerified,false);
      assert.equal(result.originalHistoricalScannerAvailabilityVerified,false);
      assert.equal(result.OOSPassCount,0);
      assert.equal(result.actualFillCount,null);
      assert.equal(result.netProfitPct,null);
      assert.equal(result.trueMarketWideRecall,null);
      assert.equal(result.profitabilityProven,false);
      assert.equal(result.paperAdmissionAllowed,false);
      assert.equal(result.modeledPeriodReturns["1d"].independentOOSProven,false);
      assert.equal(result.modeledPeriodReturns["1w"].modeledReturnPercent,null);
      assert.equal(result.modeledPeriodReturns["3m"].modeledReturnPercent,null);
      assert.equal(result.fxEvidenceStatus,"STATIC_FX_MODEL_ONLY_NOT_HISTORICAL");
      assert.equal(result.automaticPaperExecution,false);
      assert.equal(result.executionAuthority,"NONE");
      assert.equal(result.orderSubmitted,false);
      for(const trade of result.modeledTradePreview){
        assert.ok(trade.entryMs>=trade.signalMs);
        assert.ok(trade.exitMs>trade.entryMs);
        assert.equal(trade.actualFillVerified,false);
      }
    }
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("missing or partial source rejects modeled profits instead of inventing zero opportunity",async()=>{
  const folder=root(),x=fixture("CRYPTO_SPOT");
  try{
    const absent=await replay(x.request(folder));
    assert.equal(absent.status,"BLOCKED_DATA");
    assert.equal(absent.modeledReturnPercent,null);
    assert.equal(absent.actualMarketWideOpportunityCount,null);
    const gap=fixture("CRYPTO_SPOT",{missing:true});
    await persistResearchMinuteSessionV1({root:folder,source:gap.source});
    const partial=await replay(gap.request(folder));
    assert.equal(partial.reason,"ORIGINAL_ONE_MINUTE_SESSION_PARTIAL_OR_UNAVAILABLE");
    assert.equal(partial.modeledNetPnlKRW,null);
    const noTomorrow=await replay(x.request(folder,{
      researchWindow:{startDate:"2026-09-18",endDate:"2026-09-19"},
    }));
    assert.equal(noTomorrow.status,"BLOCKED_DATA");
    assert.equal(noTomorrow.missingSourceDays,1);
    assert.equal(noTomorrow.modeledTradeCount,null);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("multi-decade user selection is not silently capped to 3 years",async()=>{
  const x=fixture("CRYPTO_FUTURES"),folder=root();
  try{
    const r=await replay(x.request(folder,{
      researchWindow:{startDate:"2016-01-01",endDate:"2025-12-31"},
      sessionSources:[],
    }));
    assert.equal(r.status,"BLOCKED_DATA");
    assert.equal(r.missingSourceDays,3653);
    assert.equal(r.modeledReturnPercent,null);
    assert.equal(r.sourceSessionsRead,0);
    assert.equal(r.profitabilityProven,false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("source first seen retrospectively cannot become original scanner signal or an OOS PASS",async()=>{
  const folder=root(),x=fixture("US_STOCK",{retro:true});
  try{
    await persistResearchMinuteSessionV1({root:folder,source:x.source});
    const r=await replay(x.request(folder));
    assert.equal(r.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
    assert.equal(r.retrospectiveUnavailableRows,24);
    assert.equal(r.originalHistoricalScannerAvailabilityVerified,false);
    assert.equal(r.candidateStatus,"RESEARCH_ONLY_NO_ADOPTION");
    assert.equal(r.OOSPassCount,0);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("stock and spot short, stock leverage, futures >7, or malformed costs fail closed",async()=>{
  const folder=root();
  try{
    for(const market of ["KR_STOCK","US_STOCK","CRYPTO_SPOT"]){
      const x=fixture(market);
      await assert.rejects(()=>replay(x.request(folder,{direction:"SHORT"})),
        /PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID/);
      await assert.rejects(()=>replay(x.request(folder,{leverage:2})),
        /PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID/);
    }
    const future=fixture("CRYPTO_FUTURES");
    await assert.rejects(()=>replay(future.request(folder,{leverage:8})),
      /PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID/);
    await assert.rejects(()=>replay(future.request(folder,{
      costModel:{entryFeeRate:-0.1},
    })),/PRIVATE_REPLAY_COST_RATES_INVALID/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("invalid PIT digest and spoofed unknown market are rejected before any file reads",async()=>{
  const folder=root(),x=fixture("KR_STOCK");
  try{
    await assert.rejects(()=>replay(x.request(folder,{
      manifest:{...x.manifest,rawMembershipDigestSha256:"f".repeat(64)},
    })),/PRIVATE_REPLAY_HISTORIC_PIT_ROSTER_REQUIRED/);
    await assert.rejects(()=>replay(x.request(folder,{market:"BINANCE"})),
      /PRIVATE_REPLAY_MARKET_OR_RISK_POLICY_INVALID/);
    await assert.rejects(()=>replay(x.request(folder,{
      stockCalendar:{market:"KR_STOCK",tradingDates:[
        "2028-01-03","2026-09-18",
      ]},
    })),/PRIVATE_REPLAY_STOCK_TRADING_DATES_INVALID/);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
test("cash reserves split modeled positive profits only, without transfers or real Paper calls",async()=>{
  const folder=root(),x=fixture("CRYPTO_FUTURES");
  try{
    await persistResearchMinuteSessionV1({root:folder,source:x.source});
    const r=await replay(x.request(folder,{direction:"SHORT",leverage:3}));
    assert.equal(r.status,"RETROSPECTIVE_SOURCE_ONLY_STRATEGY_DIAGNOSTIC");
    assert.ok(r.paperReserveModeledKRW>=0);
    assert.ok(r.paperCapitalModeledKRW>=0);
    assert.equal(r.automaticPaperExecution,false);
    assert.equal(r.realOrders,false);
    assert.equal(r.orderSubmitted,false);
  }finally{rmSync(folder,{recursive:true,force:true});}
});


test("US and futures require explicit modeled quote-to-KRW FX; missing rate cannot report a PnL",async()=>{
  const folder=root();
  try{
    for(const market of ["US_STOCK","CRYPTO_FUTURES"]){
      const x=fixture(market);
      const noFX=await replay(x.request(folder,{fxRateKRWPerQuote:null}));
      assert.equal(noFX.status,"BLOCKED_DATA");
      assert.equal(noFX.reason,"HISTORICAL_QUOTE_TO_KRW_FX_MISSING");
      assert.equal(noFX.modeledReturnPercent,null);
      assert.equal(noFX.actualFillCount,null);
      await assert.rejects(()=>replay(x.request(folder,{fxRateKRWPerQuote:-1300})),
        /PRIVATE_REPLAY_MODELED_FX_RATE_INVALID/);
    }
  }finally{rmSync(folder,{recursive:true,force:true});}
});
