import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMomentumGuardForwardRecord,
  summarizeMomentumGuardForwardRecords,
} from '../src/forward-momentum-guard.mjs';

function featureSnapshot({roc=.02,rsi=60,macd=.001}={}){
  const identity={
    lineageId:'ADAPTIVE_MULTI_EVIDENCE_V2',
    family:'MOMENTUM',
    market:'CRYPTO_FUTURES',
    symbol:'BTCUSDT',
    timeframe:'60m',
    side:'LONG',
    temporal:{decisionTime:'2026-09-27T00:00:00.000Z'},
  };
  return {
    status:'READY_FOR_SPECIALIST_RESEARCH_ONLY',
    decisionAuthority:'EVIDENCE_ONLY',
    executionAuthority:'NONE',
    decisionTime:'2026-09-27T00:00:00.000Z',
    contentDigest:'a'.repeat(64),
    features:{momentum:{roc,rsi,macdHistogramPct:macd}},
    evidence:{momentum:{status:'ADMISSIBLE',evidence:{identity}}},
  };
}
function observation({status='SETTLED',outcome='WIN'}={}){
  return {
    schemaVersion:'forward-recommendation-observation-v2',
    observationId:'obs-1',
    source:'LIVE_RECOMMENDATION',
    status,
    identity:{
      strategyId:'s',strategyVersion:'v1',parameterHash:'p',researchCodeSha:'b'.repeat(40),
      market:'CRYPTO_FUTURES',symbol:'BTCUSDT',timeframe:'60m',horizon:6,direction:'LONG',
    },
    signalGrade:'A',
    expiresAt:'2026-09-27T06:00:00.000Z',
    dataTimestamp:'2026-09-27T00:00:00.000Z',
    dataMaxAgeMs:60000,
    publicDataOnly:true,
    snapshot:{
      timestamp:'2026-09-27T00:00:00.000Z',
      market:'CRYPTO_FUTURES',
      symbol:'BTCUSDT',
      direction:'LONG',
      executionAuthority:'NONE',
    },
    outcome:status==='SETTLED'?{
      outcome,returnPercent:2.5,mfePercent:5,maePercent:-1,target1Hit:true,target2Hit:false,
      stopLossHit:false,timeToTargetMs:3600000,timeToStopMs:null,conservativeIntrabarConflict:false,
    }:null,
    settledAt:status==='SETTLED'?'2026-09-27T06:00:00.000Z':null,
    executionAuthority:'NONE',
    simulatedOnly:true,
    financialMutationAllowed:false,
    liveOrderAllowed:false,
    privateTradingApiAllowed:false,
    orderSubmitted:false,
    exchangeRequestSent:false,
    profitabilityClaimAllowed:false,
  };
}

test('adapter binds exact Forward identity to canonical momentum evidence',()=>{
  const row=buildMomentumGuardForwardRecord({
    observation:observation(),
    featureSnapshot:featureSnapshot(),
  });
  assert.equal(row.status,'SETTLED');
  assert.equal(row.guardEligible,true);
  assert.equal(row.outcome.classification,'WIN');
  assert.equal(row.economicSampleCredit,0);
  assert.equal(row.executionAuthority,'NONE');
});

test('identity mismatch fails closed',()=>{
  const feature=featureSnapshot();
  feature.evidence.momentum.evidence.identity.symbol='ETHUSDT';
  const row=buildMomentumGuardForwardRecord({observation:observation(),featureSnapshot:feature});
  assert.equal(row.status,'BLOCKED_DATA');
  assert.equal(row.reason,'FORWARD_FEATURE_IDENTITY_MISMATCH');
});

test('pending observations remain pending and cannot create economic credit',()=>{
  const row=buildMomentumGuardForwardRecord({
    observation:observation({status:'PENDING'}),
    featureSnapshot:featureSnapshot(),
  });
  assert.equal(row.status,'PENDING');
  assert.equal(row.outcome,null);
  assert.equal(row.economicSampleCredit,0);
});

test('summary separates eligible and ineligible settled observations descriptively only',()=>{
  const eligible=buildMomentumGuardForwardRecord({observation:observation(),featureSnapshot:featureSnapshot()});
  const ineligible=buildMomentumGuardForwardRecord({
    observation:{...observation(),observationId:'obs-2'},
    featureSnapshot:featureSnapshot({roc:-.01}),
  });
  const summary=summarizeMomentumGuardForwardRecords([eligible,ineligible]);
  assert.equal(summary.settledN,2);
  assert.equal(summary.guardEligible.n,1);
  assert.equal(summary.guardIneligible.n,1);
  assert.equal(summary.selectionThresholdInvented,false);
  assert.equal(summary.automaticPromotionAuthority,false);
});
