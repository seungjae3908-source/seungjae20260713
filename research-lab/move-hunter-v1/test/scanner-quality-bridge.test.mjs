import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScannerBacktestQualityFromCanonicalEvidence } from '../src/scanner-quality-bridge.mjs';

const identity=Object.freeze({
  market:'CRYPTO_FUTURES',symbol:'BTCUSDT',timeframe:'60m',direction:'LONG',
  strategyProfileId:'CRYPTO_FUTURES_SWING_V1',strategyVersion:'signal-profile-v1',
  parameterHash:'a'.repeat(64),researchCodeSha:'b'.repeat(40),datasetSnapshotHash:'c'.repeat(64),
});

function trade(id,netPnl,ret){
  return {id,netPnl,netReturnOnMargin:ret,entryNotional:1000};
}
function result(start,end,trades){
  return {
    ok:true,mode:'backtest-only',orderSubmitted:false,privateAccountRequestAllowed:false,
    market:identity.market,symbol:identity.symbol,timeframe:identity.timeframe,side:'long',
    period:{startTime:start,effectiveEndTime:end},
    trades,
    safeguards:{signalUsesClosedCandle:true,entryUsesNextCandleOpen:true,stopFirstOnAmbiguousBar:true,costsIncluded:true},
  };
}
function fold(n,base){
  return {
    fold:n,leakFree:true,
    outOfSample:[
      {anchorTimestamp:base,futureEndTimestamp:base+1000},
      {anchorTimestamp:base+2000,futureEndTimestamp:base+3000},
    ],
    walkForwardTest:[
      {anchorTimestamp:base+4000,futureEndTimestamp:base+5000},
      {anchorTimestamp:base+6000,futureEndTimestamp:base+7000},
    ],
  };
}
function packet(f){
  const oStart=f.outOfSample[0].anchorTimestamp,oEnd=f.outOfSample.at(-1).futureEndTimestamp;
  const wStart=f.walkForwardTest[0].anchorTimestamp,wEnd=f.walkForwardTest.at(-1).futureEndTimestamp;
  const oTrades=Array.from({length:25},(_,i)=>trade(`o${f.fold}-${i}`,i%2===0?20:-10,i%2===0?.02:-.01));
  const wTrades=Array.from({length:25},(_,i)=>trade(`w${f.fold}-${i}`,i%3?18:-9,i%3?.018:-.009));
  return {
    fold:f.fold,binding:identity,
    outOfSampleResult:result(oStart,oEnd,oTrades),
    walkForwardResult:result(wStart,wEnd,wTrades),
  };
}
const costs={
  status:'READY',
  commission:{status:'READY',measuredOrDocumented:true,valuePercent:.1},
  spread:{status:'READY',measuredOrDocumented:true,valuePercent:.02},
  slippage:{status:'READY',measuredOrDocumented:true,valuePercent:.05},
  latency:{status:'READY',measuredOrDocumented:true,valuePercent:.01},
  liquidityImpact:{status:'READY',measuredOrDocumented:true,valuePercent:.01},
  partialFillImpact:{status:'READY',measuredOrDocumented:true,valuePercent:0},
  funding:{status:'READY',measuredOrDocumented:true,valuePercent:.01},
};
const dataset={
  eligible:true,
  safeguards:{lookaheadBlocked:true,survivorshipProtected:true},
};

test('complete exact-bound canonical packet can produce Scanner-compatible verified quality without promotion authority',()=>{
  const folds=[fold(1,1_700_000_000_000),fold(2,1_700_100_000_000)];
  const out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds,foldResults:folds.map(packet),datasetAudit:dataset,costEvidence:costs,minimumTradeCount:40,
  });
  assert.equal(out.status,'VERIFIED_QUALITY_PACKET');
  assert.equal(out.quality.status,'verified');
  assert.equal(out.quality.oos,true);
  assert.equal(out.quality.walkForward,true);
  assert.equal(out.quality.costsIncluded,true);
  assert.equal(out.quality.slippageIncluded,true);
  assert.equal(out.quality.lookaheadGuarded,true);
  assert.equal(out.quality.survivorshipGuarded,true);
  assert.equal(out.quality.tradeCount,50);
  assert.equal(out.automaticPromotionAuthority,false);
  assert.equal(out.activeLaneMutation,false);
  assert.equal(out.executionAuthority,'NONE');
});

test('missing full-cost evidence fails closed instead of minting verified quality',()=>{
  const f=fold(1,1_700_000_000_000);
  const bad={...costs,slippage:{status:'MISSING',measuredOrDocumented:false,valuePercent:null}};
  const out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds:[f],foldResults:[packet(f)],datasetAudit:dataset,costEvidence:bad,
  });
  assert.equal(out.status,'BLOCKED_DATA');
  assert.equal(out.reason,'FULL_COST_EVIDENCE_NOT_READY');
  assert.equal(out.quality.status,'missing');
});

test('leakage or survivorship gaps fail closed',()=>{
  const f=fold(1,1_700_000_000_000);
  const leak={...f,leakFree:false};
  let out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds:[leak],foldResults:[packet(f)],datasetAudit:dataset,costEvidence:costs,
  });
  assert.equal(out.reason,'LEAK_FREE_FOLD_REQUIRED');
  out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds:[f],foldResults:[packet(f)],
    datasetAudit:{eligible:false,safeguards:{lookaheadBlocked:true,survivorshipProtected:false}},costEvidence:costs,
  });
  assert.equal(out.reason,'LOOKAHEAD_OR_SURVIVORSHIP_GUARD_NOT_READY');
});

test('exact identity and exact OOS/WF windows are mandatory',()=>{
  const f=fold(1,1_700_000_000_000);
  const p=packet(f);
  let out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds:[f],foldResults:[{...p,binding:{...identity,symbol:'ETHUSDT'}}],datasetAudit:dataset,costEvidence:costs,
  });
  assert.equal(out.reason,'EVIDENCE_BINDING_MISMATCH');
  const shifted={...p,walkForwardResult:{...p.walkForwardResult,period:{...p.walkForwardResult.period,startTime:p.walkForwardResult.period.startTime-1}}};
  out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity,folds:[f],foldResults:[shifted],datasetAudit:dataset,costEvidence:costs,
  });
  assert.equal(out.reason,'WALK_FORWARD_WINDOW_BINDING_MISMATCH');
});

test('stock verified quality additionally requires PIT removed-name universe audit',()=>{
  const stockIdentity={...identity,market:'KR_STOCK',symbol:'005930',direction:'LONG'};
  const f=fold(1,1_700_000_000_000);
  const p=packet(f);
  const stockPacket={
    ...p,
    binding:stockIdentity,
    outOfSampleResult:{...p.outOfSampleResult,market:'KR_STOCK',symbol:'005930'},
    walkForwardResult:{...p.walkForwardResult,market:'KR_STOCK',symbol:'005930'},
  };
  const stockCosts={...costs,tax:{status:'READY',measuredOrDocumented:true,valuePercent:.2}};
  delete stockCosts.funding;
  let out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity:stockIdentity,folds:[f],foldResults:[stockPacket],datasetAudit:dataset,costEvidence:stockCosts,
  });
  assert.equal(out.reason,'LOOKAHEAD_OR_SURVIVORSHIP_GUARD_NOT_READY');
  out=buildScannerBacktestQualityFromCanonicalEvidence({
    identity:stockIdentity,folds:[f],foldResults:[stockPacket],datasetAudit:dataset,costEvidence:stockCosts,
    stockUniverseBiasAudit:{
      status:'point_in_time_bias_gate_passed',
      safeguards:{currentConstituentListAloneCannotPass:true,missingHistoriesFailClosed:true},
    },
    minimumTradeCount:20,
  });
  assert.equal(out.status,'VERIFIED_QUALITY_PACKET');
});
