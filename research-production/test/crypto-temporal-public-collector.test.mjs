import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCryptoFuturesTemporalObservationsV1, collectCryptoFuturesTemporalEvidenceV1 } from '../src/crypto-temporal-public-collector.mjs';
import { appendTemporalEvidenceV1, createTemporalEvidenceLedgerV1, readTemporalFeatureAtV1 } from '../src/temporal-evidence-ledger.mjs';

const SHA='a'.repeat(40);
const T=Date.UTC(2026,8,19,0,0,0);

test('first OI snapshot is stored but cannot invent an OI change',()=>{
  const ledger=createTemporalEvidenceLedgerV1({researchSha:SHA});
  const observations=buildCryptoFuturesTemporalObservationsV1({
    ledger,symbol:'BTCUSDT',collectedAt:T+1000,
    context:{openInterest:100,openInterestTimestamp:T,fundingRate:0.0001},
    longShortRecords:[],
  });
  assert.ok(observations.some(row=>row.feature==='openInterestRaw'));
  assert.equal(observations.some(row=>row.feature==='openInterestChange'),false);
});

test('OI change is derived only from two genuine snapshots in temporal order',()=>{
  let ledger=createTemporalEvidenceLedgerV1({researchSha:SHA});
  ledger=appendTemporalEvidenceV1(ledger,{
    market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestRaw',value:100,
    observedAt:T,availableAt:T,recordedAt:T,source:'bitget-public-v2',publicDataOnly:true,
  });
  const observations=buildCryptoFuturesTemporalObservationsV1({
    ledger,symbol:'BTCUSDT',collectedAt:T+3600000+1000,
    context:{openInterest:110,openInterestTimestamp:T+3600000},
    longShortRecords:[],
  });
  const change=observations.find(row=>row.feature==='openInterestChange');
  assert.ok(change);
  assert.ok(Math.abs(change.value-0.1)<1e-12);
  assert.equal(change.source,'bitget-public-v2-derived-oi-change');
});

test('retrieved historical long-short rows receive collection-time availability and cannot leak backwards',()=>{
  const ledger=createTemporalEvidenceLedgerV1({researchSha:SHA});
  const observations=buildCryptoFuturesTemporalObservationsV1({
    ledger,symbol:'BTCUSDT',collectedAt:T+10*3600000,
    context:{},longShortRecords:[{timestamp:T,ratio:1.2,ratioRaw:'1.2'}],
  });
  const next=appendTemporalEvidenceV1(ledger,observations[0]);
  const oldAnchor=readTemporalFeatureAtV1(next,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'longShortRatio',anchorTimestamp:T+3600000,maxAgeMs:24*3600000});
  assert.equal(oldAnchor.status,'MISSING');
  const futureAnchor=readTemporalFeatureAtV1(next,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'longShortRatio',anchorTimestamp:T+11*3600000,maxAgeMs:24*3600000});
  assert.equal(futureAnchor.status,'PRESENT');
});

test('collector keeps independent symbols and fails partially without deleting good evidence',async()=>{
  const ledger=createTemporalEvidenceLedgerV1({researchSha:SHA});
  const client={
    get:async(path,params)=>{
      if(params.symbol==='ETHUSDT') throw new Error('provider temporary failure');
      if(path.includes('open-interest')) return {data:{openInterestList:[{size:'100'}]},code:'00000'};
      if(path.includes('current-fund-rate')) return {data:[{fundingRate:'0.0001',fundingRateInterval:'8'}],code:'00000'};
      if(path.includes('history-fund-rate')) return {data:[],code:'00000'};
      if(path.includes('symbol-price')) return {data:[{price:'100',markPrice:'100',indexPrice:'100'}],code:'00000'};
      if(path.includes('long-short')) return {data:[{longShortRatio:'1.1',ts:String(T)}],code:'00000'};
      throw new Error('unexpected endpoint');
    },
  };
  const result=await collectCryptoFuturesTemporalEvidenceV1({
    ledger,symbols:['BTCUSDT','ETHUSDT'],client,now:()=>T+3600000,
  });
  assert.equal(result.status,'partial_failure');
  assert.equal(result.results[0].status,'success');
  assert.equal(result.results[1].status,'failed');
  assert.ok(result.ledger.observations.some(row=>row.symbol==='BTCUSDT'));
  assert.equal(result.ledger.observations.some(row=>row.symbol==='ETHUSDT'),false);
  assert.equal(result.safety.executionAuthority,'NONE');
});
