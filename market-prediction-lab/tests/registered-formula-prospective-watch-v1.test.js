import assert from 'node:assert/strict';
import test from 'node:test';
import { compiledMomentumFormula, compiledFuturesMomentumFormula } from './research-bundle-formula-fixture.js';
import { buildFormulaPaperStrategyRegistryV1 } from '../src/formula-auto-backtest-queue-v1.js';
import { observeRegisteredFormulaClosedCandleV1 } from '../src/registered-formula-prospective-watch-v1.js';

const NOW=Date.UTC(2026,9,11,8,0,0);
const STEP=15*60_000;
const SHA='a'.repeat(40);
function candles(values=[100,100,100,100,100,130],volumes=[100,100,100,100,100,500]) {
  return values.map((close,i)=>({
    timestamp:NOW-(values.length-i)*STEP,
    open:close,high:close+0.5,low:Math.max(0.01,close-0.5),
    close,volume:volumes[i],isClosed:true,
  }));
}
function registered({futures=false,direction='LONG'}={}) {
  const {formula,generated}=futures?compiledFuturesMomentumFormula({direction}):compiledMomentumFormula();
  const candidate={
    formulaCandidate:formula,generatedCandidate:generated,
    formulaCandidateId:formula.candidateId,
    generatedCandidateId:generated.generatedCandidateId,
    parameterIdentity:generated.parameterIdentity,
    strategyHash:formula.formulaHash,strategyFamily:formula.strategyFamily,
    market:formula.market,timeframe:formula.timeframe,direction:formula.direction,
    researchSurvivor:true,failure:null,tradingAuthority:false,
    safety:{executionAuthority:'NONE'},
  };
  const registry=buildFormulaPaperStrategyRegistryV1([{
    state:'PASS',itemDigest:'f'.repeat(64),tournament:{candidates:[candidate]},
    evaluatedAt:new Date(NOW-24*60*60_000).toISOString(),
  }],{researchCodeSha:SHA});
  assert.equal(registry.entries.length,1);
  return registry.entries[0];
}
const input=(changes={})=>({
  entry:registered(),researchCodeSha:SHA,market:'US_STOCK',symbol:'AAPL',
  direction:'LONG',timeframe:'15m',evaluatedAtMs:NOW,candles:candles(),
  publicEvidence:{
    publicOnly:true,dataQuality:'READY',source:'TEST_PUBLIC',
    asOfMs:NOW,maxAgeMs:180_000,
  },
  ...changes,
});
function noAuthority(row) {
  assert.equal(row.executionAuthority,'NONE');
  assert.equal(row.paperDispatchAllowed,false);
  assert.equal(row.canonicalPaperAdmissionVerified,false);
  assert.equal(row.independentRegistryProvenanceVerified,false);
  assert.equal(row.independentProviderProvenanceVerified,false);
  assert.equal(row.oosVerified,false);
  assert.equal(row.fullCostReady,false);
  assert.equal(row.profitabilityProven,false);
  assert.equal(row.candidateCredit,0);
  assert.equal(row.economicEvidenceCredit,0);
  assert.equal(row.orderCount,0);
  assert.equal(row.financialMutationCount,0);
  assert.equal(row.privateRequestCount,0);
}
test('real registry DSL on new closed candle may report observation but never Paper order',()=>{
  const params=input(),row=observeRegisteredFormulaClosedCandleV1(params);
  assert.equal(row.status,'OBSERVED_CLOSED_CANDLE_SIGNAL');
  assert.equal(row.observedClosedCandleSignal,true);
  assert.equal(row.observedSignalAtMs,NOW);
  assert.match(row.observationId,/^[a-f0-9]{64}$/u);
  assert.equal(observeRegisteredFormulaClosedCandleV1(params).observationId,row.observationId);
  assert.equal(JSON.stringify(row).includes('selectedParameters'),false);
  noAuthority(row);
});
test('no rules matched means NO_SIGNAL instead of positive simulated profitability',()=>{
  const row=observeRegisteredFormulaClosedCandleV1(input({
    candles:candles([100,100,100,100,100,100],[100,100,100,100,100,100]),
  }));
  assert.equal(row.status,'NO_SIGNAL');
  assert.equal(row.observationId,null);
  noAuthority(row);
});
test('old pre-registration bars, stale quotes, future/open bars and bad OHLC block',()=>{
  const params=input();
  const mutations=[
    {entry:{...params.entry,registeredAt:new Date(NOW+1).toISOString()}},
    {entry:{...params.entry,registeredAt:new Date(NOW-5*60_000).toISOString()}},
    {publicEvidence:{...params.publicEvidence,asOfMs:NOW-300_001}},
    {publicEvidence:{...params.publicEvidence,publicOnly:false}},
    {publicEvidence:{...params.publicEvidence,dataQuality:'PARTIAL'}},
    {publicEvidence:{...params.publicEvidence,maxAgeMs:11*60_000}},
    {publicEvidence:{...params.publicEvidence,asOfMs:NOW+1}},
    {candles:candles().map(c=>({...c,isClosed:false}))},
    {candles:[...params.candles,{...params.candles.at(-1),timestamp:NOW+STEP}]},
    {candles:[...params.candles].reverse()},
    {candles:[...params.candles.slice(0,-1),{...params.candles.at(-1),high:1}]},
  ];
  for(const change of mutations) {
    const row=observeRegisteredFormulaClosedCandleV1(input(change));
    assert.equal(row.status,'BLOCKED_DATA',JSON.stringify(change).slice(0,130));
    assert.equal(row.observedClosedCandleSignal,false);
    noAuthority(row);
  }
});
test('tampered research SHA, digest, DSL, direction and market cannot become Paper',()=>{
  const current=input();
  for(const changed of [
    {researchCodeSha:'b'.repeat(40)},
    {entry:{...current.entry,registryId:'0'.repeat(64)}},
    {entry:{...current.entry,formulaCandidate:{...current.entry.formulaCandidate,formulaHash:'0'.repeat(64)}}},
    {entry:{...current.entry,realOrder:true}},
    {entry:{...current.entry,paperState:'PASS_AND_TRADE'}},
    {market:'KR_STOCK'},{market:'CRYPTO_SPOT',direction:'SHORT'},
    {direction:'SHORT'},{timeframe:'1D'},{symbol:'BTC/USDT'},
  ]) {
    const row=observeRegisteredFormulaClosedCandleV1(input(changed));
    assert.equal(row.status,'BLOCKED_DATA',JSON.stringify(changed).slice(0,120));
    noAuthority(row);
  }
});
test('futures LONG/SHORT formula evaluation never grants leverage or execution rights',()=>{
  for(const direction of ['LONG','SHORT']){
    const entry=registered({futures:true,direction});
    const row=observeRegisteredFormulaClosedCandleV1(input({
      entry,market:'CRYPTO_FUTURES',symbol:'BTCUSDT',direction,
    }));
    assert.ok(['NO_SIGNAL','OBSERVED_CLOSED_CANDLE_SIGNAL'].includes(row.status)
      || row.status==='BLOCKED_DATA');
    noAuthority(row);
    const spot=observeRegisteredFormulaClosedCandleV1(input({
      entry,market:'CRYPTO_SPOT',symbol:'BTC',direction:'SHORT',
    }));
    assert.equal(spot.status,'BLOCKED_DATA');
  }
});
