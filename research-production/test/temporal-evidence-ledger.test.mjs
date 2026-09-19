import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendTemporalEvidenceBatchV1,
  appendTemporalEvidenceV1,
  assertTemporalEvidenceLedgerV1,
  createTemporalEvidenceLedgerV1,
  projectTemporalFeatureProviderV1,
  readTemporalFeatureAtV1,
  summarizeTemporalFeatureCoverageV1,
} from '../src/temporal-evidence-ledger.mjs';

const SHA='a'.repeat(40);
const T=Date.UTC(2026,8,19,0,0,0);

function row(overrides={}){
  return {
    market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestChange',value:0.01,
    observedAt:T,availableAt:T,recordedAt:T,source:'bitget-public-v2',producerSha:SHA,publicDataOnly:true,
    synthetic:false,replay:false,backfill:false,manual:false,...overrides,
  };
}

test('ledger is append-only, deterministic and idempotent for exact duplicate observations',()=>{
  const empty=createTemporalEvidenceLedgerV1({researchSha:SHA});
  const once=appendTemporalEvidenceV1(empty,row());
  const twice=appendTemporalEvidenceV1(once,row());
  assert.equal(once.observations.length,1);
  assert.equal(twice.observations.length,1);
  assert.equal(twice.ledgerDigest,once.ledgerDigest);
});

test('persisted ledger tampering is detected before any new evidence is accepted',()=>{
  const valid=appendTemporalEvidenceV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),row());
  const tampered={...valid,observations:[{...valid.observations[0],value:999}]};
  assert.throws(()=>assertTemporalEvidenceLedgerV1(tampered),/digest mismatch/);
  assert.throws(()=>appendTemporalEvidenceV1(tampered,row({observedAt:T+3600000,availableAt:T+3600000,recordedAt:T+3600000})),/digest mismatch/);
});

test('conflicting observation identity fails closed',()=>{
  const ledger=appendTemporalEvidenceV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),row());
  assert.throws(()=>appendTemporalEvidenceV1(ledger,row({value:0.02})),/conflicting temporal observation identity/);
});

test('future or not-yet-available evidence cannot leak into an earlier anchor',()=>{
  const ledger=appendTemporalEvidenceBatchV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),[
    row({observedAt:T,availableAt:T,value:0.01}),
    row({observedAt:T+3600000,availableAt:T+7200000,value:0.03}),
  ]);
  const early=readTemporalFeatureAtV1(ledger,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestChange',anchorTimestamp:T+5400000,maxAgeMs:7200000});
  assert.equal(early.value,0.01);
  const later=readTemporalFeatureAtV1(ledger,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestChange',anchorTimestamp:T+10800000,maxAgeMs:7200000});
  assert.equal(later.value,0.03);
});

test('stale current observations are never carried indefinitely into history',()=>{
  const ledger=appendTemporalEvidenceV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),row());
  const result=readTemporalFeatureAtV1(ledger,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestChange',anchorTimestamp:T+10*3600000,maxAgeMs:2*3600000});
  assert.equal(result.status,'MISSING');
});

test('coverage is measured from genuine admissible anchors, not observation count',()=>{
  const ledger=appendTemporalEvidenceBatchV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),[
    row({observedAt:T,value:0.01}),
    row({observedAt:T+3600000,availableAt:T+3600000,recordedAt:T+3600000,value:0.02}),
  ]);
  const summary=summarizeTemporalFeatureCoverageV1(ledger,{
    market:'CRYPTO_FUTURES',symbol:'BTCUSDT',feature:'openInterestChange',
    anchors:[T,T+3600000,T+2*3600000,T+6*3600000],maxAgeMs:2*3600000,
  });
  assert.equal(summary.anchorCount,4);
  assert.equal(summary.presentCount,3);
  assert.equal(summary.coverage,0.75);
});

test('synthetic replay backfill and manual observations are refused',()=>{
  for(const key of ['synthetic','replay','backfill','manual']){
    assert.throws(()=>appendTemporalEvidenceV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),row({[key]:true})),/genuine observations only/);
  }
});

test('provider projection returns only evidence available at each anchor',()=>{
  const ledger=appendTemporalEvidenceBatchV1(createTemporalEvidenceLedgerV1({researchSha:SHA}),[
    row({feature:'fundingRate',value:0.0001}),
    row({feature:'longShortRatio',value:1.25}),
  ]);
  const provider=projectTemporalFeatureProviderV1(ledger,{market:'CRYPTO_FUTURES',symbol:'BTCUSDT',featureMap:{fundingRate:12*3600000,longShortRatio:2*3600000}});
  const result=provider({anchorTimestamp:T+3600000});
  assert.equal(result.values.fundingRate,0.0001);
  assert.equal(result.values.longShortRatio,1.25);
  assert.equal(result.featureAvailability.fundingRateKnown,true);
  assert.equal(result.featureAvailability.longShortRatioKnown,true);
});
