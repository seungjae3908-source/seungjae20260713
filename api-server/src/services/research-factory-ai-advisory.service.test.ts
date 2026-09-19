import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResearchFactoryDualAiGateV1,
  runResearchFactoryDualAiAdvisoryV1,
} from './research-factory-ai-advisory.service';

const SHA='a'.repeat(40);
const DIGEST='b'.repeat(64);

function factory(status='READY_NON_ACTIVATING') {
  return {
    schemaVersion: 1,
    contract: 'research-factory-runtime-status/v1',
    generatedAt: '2026-09-20T00:00:00.000Z',
    researchSha: SHA,
    status,
    firstZero: status === 'READY_NON_ACTIVATING'
      ? 'ADAPTIVE_TOURNAMENT_RUNTIME_EXECUTION_AUTHORITY_NOT_GRANTED'
      : status,
    policy: {
      present: status !== 'BLOCKED_POLICY_MISSING',
      valid: !['BLOCKED_POLICY_MISSING','BLOCKED_POLICY_INVALID'].includes(status),
      policyDigest: ['BLOCKED_POLICY_MISSING','BLOCKED_POLICY_INVALID'].includes(status) ? null : DIGEST,
    },
    dataFactory: { readyMarketCount: 2, blockedMarketCount: 2 },
    canonicalAdaptive: {
      readyProfileCount: status === 'BLOCKED_NO_READY_PROFILES' ? 0 : 3,
      blockedProfileCount: status === 'BLOCKED_NO_READY_PROFILES' ? 12 : 9,
      runtimeStatus: status === 'READY_NON_ACTIVATING' ? 'READY_NON_ACTIVATING' : status,
      nextFirstZero: status,
    },
    controlPlaneDigest: DIGEST,
    safety: {
      runtimeExecutionAttempted: false,
      runtimeActivationAllowed: false,
      scheduleMutationAllowed: false,
      deploymentAllowed: false,
      databaseMutationAllowed: false,
      secretMutationAllowed: false,
      liveTrading: false,
      autoTrading: false,
      privateTradingApi: false,
      realOrder: false,
      profitabilityClaim: false,
      executionAuthority: 'NONE',
    },
  };
}

function aiAnswer(kind:'proposer'|'critic') {
  if (kind === 'proposer') {
    return JSON.stringify({
      summary: 'A structural hypothesis is suitable for falsifiable research.',
      findings: ['Market structure evidence should be separated by regime.'],
      hypotheses: [{
        hypothesisId: 'regimeBreakout',
        thesis: 'Trend persistence may differ after structural volatility transitions.',
        requiredEvidence: ['Point in time market structure and regime provenance.'],
        falsification: 'Reject when the structural relation is absent outside development evidence.',
        intendedRegime: 'Volatility transition regime.',
        independenceRationale: 'The mechanism uses a distinct structural feature family.',
      }],
      risks: ['Selection leakage and duplicated feature families require review.'],
      disposition: 'RESEARCH_PROPOSAL_ONLY',
    });
  }
  return JSON.stringify({
    summary: 'The proposal requires strict provenance and independent falsification.',
    findings: ['Leakage controls and duplicate family checks remain necessary.'],
    hypotheses: [],
    risks: ['Weak causal stories should be rejected before tournament admission.'],
    disposition: 'NEEDS_REVIEW',
  });
}

test('Factory blockers prevent all free-provider calls', async () => {
  for (const status of ['BLOCKED_POLICY_MISSING','BLOCKED_POLICY_INVALID','BLOCKED_NO_READY_PROFILES','BLOCKED_RUNTIME_BINDINGS']) {
    const gate=buildResearchFactoryDualAiGateV1({factoryStatus:factory(status)});
    let calls=0;
    const result=await runResearchFactoryDualAiAdvisoryV1({
      gate,
      invokers:{
        gemini:async()=>{calls+=1;return{answer:aiAnswer('proposer'),model:'gemini-free'};},
        groq:async()=>{calls+=1;return{answer:aiAnswer('critic'),model:'groq-free'};},
      },
    });
    assert.equal(result.status,'BLOCKED');
    assert.equal(result.providerCallCount,0);
    assert.equal(calls,0);
  }
});

test('READY_NON_ACTIVATING runs Gemini proposer then Groq critic exactly once each', async () => {
  const gate=buildResearchFactoryDualAiGateV1({factoryStatus:factory()});
  const calls:string[]=[];
  let criticPrompt='';
  const result=await runResearchFactoryDualAiAdvisoryV1({
    gate,
    invokers:{
      gemini:async(message)=>{calls.push('gemini'); assert.match(message,/role=PROPOSER/); return{answer:aiAnswer('proposer'),model:'gemini-free'};},
      groq:async(message)=>{calls.push('groq'); criticPrompt=message; return{answer:aiAnswer('critic'),model:'groq-free'};},
    },
  });
  assert.deepEqual(calls,['gemini','groq']);
  assert.equal(result.status,'READY');
  assert.equal(result.providerCallCount,2);
  assert.equal(result.proposer?.authority.numericPerformanceAuthority,false);
  assert.equal(result.critic?.authority.orderAllowed,false);
  assert.match(criticPrompt,/regimeBreakout/);
  assert.equal(result.authority.candidateSelectionAuthority,false);
  assert.equal(result.authority.championPromotionAuthority,false);
  assert.equal(result.authority.executionAuthority,'NONE');
});

test('invalid Factory authority blocks before any provider call', async () => {
  const unsafe=factory();
  unsafe.safety.runtimeExecutionAttempted=true;
  const gate=buildResearchFactoryDualAiGateV1({factoryStatus:unsafe});
  assert.equal(gate.status,'BLOCKED_FACTORY_INVALID');
  let calls=0;
  const result=await runResearchFactoryDualAiAdvisoryV1({
    gate,
    invokers:{
      gemini:async()=>{calls+=1;return{answer:aiAnswer('proposer'),model:'gemini-free'};},
      groq:async()=>{calls+=1;return{answer:aiAnswer('critic'),model:'groq-free'};},
    },
  });
  assert.equal(calls,0);
  assert.equal(result.providerCallCount,0);
});

test('failure memory is reduced to qualitative state and digest-bound evidence only', () => {
  const gate=buildResearchFactoryDualAiGateV1({
    factoryStatus:factory(),
    failureSummary:{
      schemaVersion:1,
      contract:'research-failure-memory-summary/v1',
      observationCount:2,
      strategyIdentityCount:2,
      byStage:{SHADOW:1,NATURAL_PAPER:1},
      byStatus:{FAIL:1,MISSING_EVIDENCE:1},
      latestObservedAt:'2026-09-20T00:00:00.000Z',
      economicMetricsIncluded:false,
      performanceCreditCreated:false,
      sampleCreditCreated:false,
      executionAuthority:'NONE',
    },
  });
  assert.equal(gate.status,'READY');
  assert.match(gate.evidenceSummary,/known_failure_memory_present/);
  assert.doesNotMatch(gate.evidenceSummary,/observationCount|strategyIdentityCount|SHADOW:|NATURAL_PAPER:/);
  assert.match(gate.evidenceSummary,/Numeric performance/);
  assert.equal(gate.authority.numericPerformanceAuthority,false);
});
