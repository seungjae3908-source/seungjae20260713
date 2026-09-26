import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createResearchFailureObservationV1,
} from '../../market-prediction-lab/src/autonomous-alpha-factory-phase3-v1.js';
import {
  appendResearchFailureObservationV1,
  assertResearchFailureMemoryV1,
  buildResearchFailureDecisionV1,
  createResearchFailureMemoryV1,
  summarizeResearchFailureMemoryV1,
} from '../src/research-failure-memory.mjs';

const SHA='a'.repeat(40);
const ID1='1'.repeat(64);
const ID2='2'.repeat(64);
const CASE_ID='ab'.repeat(32);

function failure(overrides={}){
  return createResearchFailureObservationV1({
    strategyIdentityDigest:ID1,
    stage:'SHADOW',
    status:'FAIL',
    failureCodes:['SHADOW_DATA_FRESHNESS_FAILURE'],
    observedAt:'2026-09-20T00:10:00.000Z',
    evidence:{source:'canonical-shadow'},
    ...overrides,
  });
}

test('canonical Phase3 failure observation is stored without raw evidence or economic authority',()=>{
  const empty=createResearchFailureMemoryV1({researchSha:SHA});
  const memory=appendResearchFailureObservationV1(empty,failure());
  assertResearchFailureMemoryV1(memory);
  assert.equal(memory.observations.length,1);
  assert.equal(memory.observations[0].failureObservation.strategyIdentityDigest,ID1);
  assert.equal(Object.hasOwn(memory.observations[0].failureObservation,'evidence'),false);
  assert.equal(memory.safety.executionAuthority,'NONE');
  assert.equal(memory.safety.automaticSameStrategyRetryAllowed,false);
});

test('exact duplicate failure is idempotent instead of double-counting',()=>{
  const row=failure();
  const once=appendResearchFailureObservationV1(createResearchFailureMemoryV1({researchSha:SHA}),row);
  const twice=appendResearchFailureObservationV1(once,row);
  assert.equal(twice.observations.length,1);
  assert.equal(twice.memoryDigest,once.memoryDigest);
});

test('tampered canonical failure observation is rejected',()=>{
  const row=failure();
  const tampered={...row,stage:'PAPER'};
  assert.throws(
    ()=>appendResearchFailureObservationV1(createResearchFailureMemoryV1({researchSha:SHA}),tampered),
    /RESEARCH_FAILURE_OBSERVATION_INVALID/,
  );
});

test('known failed identity cannot be automatically retried or mutated in place',()=>{
  const memory=appendResearchFailureObservationV1(createResearchFailureMemoryV1({researchSha:SHA}),failure());
  const decision=buildResearchFailureDecisionV1(memory,{strategyIdentityDigest:ID1});
  assert.equal(decision.status,'AUTOMATIC_SAME_IDENTITY_RETRY_BLOCKED');
  assert.equal(decision.automaticSameStrategyRetryAllowed,false);
  assert.equal(decision.newHypothesisRequired,true);
  assert.equal(decision.newFormulaCandidateRequired,true);
  assert.equal(decision.newStrategyIdentityRequired,true);
  assert.equal(decision.tournamentRestartRequired,true);
  assert.equal(decision.priorPerformanceInheritanceAllowed,false);
  assert.equal(decision.executionAuthority,'NONE');
});

test('failure identity digest case cannot bypass retry block or inflate strategy count',()=>{
  let memory=createResearchFailureMemoryV1({researchSha:SHA});
  memory=appendResearchFailureObservationV1(memory,failure({
    strategyIdentityDigest:CASE_ID.toUpperCase(),
    observedAt:'2026-09-20T00:20:00.000Z',
  }));
  const firstDecision=buildResearchFailureDecisionV1(memory,{strategyIdentityDigest:CASE_ID});
  assert.equal(firstDecision.status,'AUTOMATIC_SAME_IDENTITY_RETRY_BLOCKED');
  assert.equal(firstDecision.failureCount,1);
  assert.equal(firstDecision.automaticSameStrategyRetryAllowed,false);

  memory=appendResearchFailureObservationV1(memory,failure({
    strategyIdentityDigest:CASE_ID,
    stage:'PAPER',
    status:'MISSING_EVIDENCE',
    failureCodes:['SETTLEMENT_EVIDENCE_MISSING'],
    observedAt:'2026-09-20T00:30:00.000Z',
  }));
  const secondDecision=buildResearchFailureDecisionV1(memory,{strategyIdentityDigest:CASE_ID.toUpperCase()});
  const summary=summarizeResearchFailureMemoryV1(memory);
  assert.equal(secondDecision.status,'AUTOMATIC_SAME_IDENTITY_RETRY_BLOCKED');
  assert.equal(secondDecision.failureCount,2);
  assert.equal(summary.observationCount,2);
  assert.equal(summary.strategyIdentityCount,1);
});

test('unseen identity is not falsely labeled failed',()=>{
  const memory=appendResearchFailureObservationV1(createResearchFailureMemoryV1({researchSha:SHA}),failure());
  const decision=buildResearchFailureDecisionV1(memory,{strategyIdentityDigest:ID2});
  assert.equal(decision.status,'NO_KNOWN_FAILURE');
  assert.equal(decision.failureCount,0);
  assert.equal(decision.automaticSameStrategyRetryAllowed,true);
  assert.equal(decision.priorPerformanceInheritanceAllowed,false);
});

test('summary exposes only failure counts and never economic metrics or credit',()=>{
  let memory=createResearchFailureMemoryV1({researchSha:SHA});
  memory=appendResearchFailureObservationV1(memory,failure());
  memory=appendResearchFailureObservationV1(memory,failure({
    strategyIdentityDigest:ID2,
    stage:'NATURAL_PAPER',
    status:'MISSING_EVIDENCE',
    failureCodes:['SETTLEMENT_EVIDENCE_MISSING'],
    observedAt:'2026-09-20T01:10:00.000Z',
  }));
  const summary=summarizeResearchFailureMemoryV1(memory);
  assert.equal(summary.observationCount,2);
  assert.equal(summary.strategyIdentityCount,2);
  assert.equal(summary.byStage.SHADOW,1);
  assert.equal(summary.byStage.NATURAL_PAPER,1);
  assert.equal(summary.economicMetricsIncluded,false);
  assert.equal(summary.performanceCreditCreated,false);
  assert.equal(summary.sampleCreditCreated,false);
  assert.equal(summary.executionAuthority,'NONE');
});
