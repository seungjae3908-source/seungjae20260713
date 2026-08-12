import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecializedCandidateFilters, runMarketSpecializedBacktest } from '../src/market-specialized-research-adapter.js';

function candles(count=50) {
  return Array.from({length:count},(_,i)=>({timestamp:i,open:100,high:101,low:99,close:100,volume:100,sessionDate:'2026-08-12',sessionMinute:i*15}));
}

const parameters={atrPeriod:14,stopAtrMultiple:1.5,targetRiskMultiple:2};
const period={startTime:1,endTime:40,includeFinalHoldout:false};

test('adapter exposes only bounded specialized candidate families',()=>{
  assert.equal(buildSpecializedCandidateFilters('V7').length,36);
  assert.equal(buildSpecializedCandidateFilters('V10').length,48);
  assert.throws(()=>buildSpecializedCandidateFilters('V11'),/unsupported market-specialized version/);
});

test('adapter forbids final holdout from selection path',()=>{
  assert.throws(()=>runMarketSpecializedBacktest({version:'V7',backtestInput:{market:'CRYPTO_SPOT',side:'long',timeframe:'15m',candles:candles()},parameters,filter:{vwapLookback:20,stretchAtr:1,reclaimAtr:.25,maxEntryRvol:2},period:{...period,includeFinalHoldout:true}}),/FINAL_HOLDOUT_SELECTION_FORBIDDEN/);
});

test('V8 blocks incomplete exchange-local session metadata before runner',()=>{
  let called=0;
  const rows=candles(); delete rows[10].sessionMinute;
  const output=runMarketSpecializedBacktest({version:'V8',backtestInput:{market:'US_STOCK',side:'long',timeframe:'15m',candles:rows},parameters,filter:{openingRangeMinutes:30,breakoutRecencyBars:1,breakoutBufferAtr:0,retestToleranceAtr:.5,minRvol:1},period,runner:()=>{called+=1;return{};}});
  assert.equal(output.status,'blocked_data');
  assert.ok(output.reasons.includes('complete_exchange_session_metadata_required'));
  assert.equal(called,0);
});

test('V9 blocks benchmark gaps instead of silently producing low samples',()=>{
  let called=0;
  const rows=candles();
  const benchmark=rows.slice(1).map(({timestamp,close})=>({timestamp,close}));
  const output=runMarketSpecializedBacktest({version:'V9',backtestInput:{market:'US_STOCK',side:'long',timeframe:'1d',candles:rows},parameters,filter:{lookbackBars:20,minRelativeReturn:.02,minAssetReturn:-.02,requireAcceleration:false},period,benchmarkCandles:benchmark,runner:()=>{called+=1;return{};}});
  assert.equal(output.status,'blocked_data');
  assert.ok(output.reasons.includes('exact_benchmark_timestamp_coverage_required'));
  assert.equal(called,0);
});

test('V10 blocks missing same-venue fresh derivatives context before runner',()=>{
  let called=0;
  const output=runMarketSpecializedBacktest({version:'V10',backtestInput:{market:'CRYPTO_FUTURES',side:'long',timeframe:'15m',candles:candles()},parameters,filter:{lookbackBars:4,minOiChange:.01,minDirectionalReturn:.005,maxAbsFunding:.001,maxAbsBasis:.01},period,derivatives:null,runner:()=>{called+=1;return{};}});
  assert.equal(output.status,'blocked_data');
  assert.equal(called,0);
});

test('V7 ready path delegates to independent backtest runner and preserves safety flags',()=>{
  let received=null;
  const output=runMarketSpecializedBacktest({version:'V7',backtestInput:{market:'CRYPTO_SPOT',side:'long',timeframe:'15m',candles:candles()},parameters,filter:{vwapLookback:20,stretchAtr:1,reclaimAtr:.25,maxEntryRvol:2},period,runner:(input)=>{received=input;return{totalTrades:3};}});
  assert.equal(output.status,'evaluated');
  assert.equal(output.result.totalTrades,3);
  assert.equal(typeof received.signalEvaluator,'function');
  assert.equal(output.finalHoldoutUsedForSelection,false);
  assert.equal(output.liveOrderAllowed,false);
  assert.equal(output.orderSubmitted,false);
});
