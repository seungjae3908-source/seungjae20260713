import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAST_PROFITABILITY_FULL_COST_COMPONENTS,
  FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N,
  FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N,
  admitFastProfitabilityIndependentObservation,
  allocateFastProfitabilitySplit,
  buildFastProfitabilityProspectivePolicyV1,
  evaluateFastProfitabilityReadiness,
  verifyFastProfitabilityProspectivePolicyV1,
} from '../src/fast-profitability-prospective-policy-v1.js';

const FROZEN_AT = Date.parse('2026-09-18T08:00:00.000Z');

function candidate(overrides = {}) {
  return {
    candidateId: 'paper-candidate-v1:fixture',
    strategyId: 'strategy:fast-profitability-fixture',
    strategyVersion: '1.0.0',
    parameterHash: 'a'.repeat(64),
    researchCodeSha: 'b'.repeat(40),
    market: 'CRYPTO_FUTURES',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    side: 'LONG',
    riskPolicyRef: 'risk-policy:fixture-v1',
    costPolicyRef: 'cost-policy:fixture-v1',
    exitPolicyRef: 'exit-policy:fixture-v1',
    ...overrides,
  };
}

function policy() {
  return buildFastProfitabilityProspectivePolicyV1({
    candidate: candidate(),
    policyFrozenAtMs: FROZEN_AT,
    eligibleAfterMs: FROZEN_AT + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  });
}

function allocationInput(p, id, sourceFrameIdentity = 'frame:1') {
  return {
    publicEventIdentity: id,
    sourceFrameIdentity,
    observedAtMs: p.eligibleAfterMs + 1,
  };
}

function findAllocation(p, split) {
  for (let index = 0; index < 10_000; index += 1) {
    const input = allocationInput(p, `event:${index}`, `frame:${index}`);
    const result = allocateFastProfitabilitySplit(p, input);
    if (result.split === split) return { input, result };
  }
  throw new Error(`unable to find deterministic ${split} fixture`);
}

function genuineObservation(p, input, overrides = {}) {
  return {
    ...input,
    policyDigest: p.policyDigest,
    candidateDigest: p.candidateDigest,
    synthetic: false,
    replay: false,
    backfill: false,
    historical: false,
    manual: false,
    operatorSelected: false,
    testOnly: false,
    independenceStatus: 'PROVEN',
    dependencyComponentCredit: 1,
    dependencyComponentId: `component:${input.publicEventIdentity}`,
    economicOutcomeVisible: false,
    ...overrides,
  };
}

test('freezes a future-only inactive policy without mutating or importing canonical V3 evidence', () => {
  const p = policy();
  const verdict = verifyFastProfitabilityProspectivePolicyV1(p);

  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.blockers, []);
  assert.equal(p.status, 'FROZEN_INACTIVE');
  assert.equal(
    p.eligibleAfterMs - p.policyFrozenAtMs,
    FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  );
  assert.equal(
    p.validationPolicy.minimumEffectiveIndependentN,
    FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N,
  );
  assert.equal(
    p.sealedOosPolicy.minimumEffectiveIndependentN,
    FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N,
  );
  assert.deepEqual(p.parallelEvidencePlan.fullCostComponents, FAST_PROFITABILITY_FULL_COST_COMPONENTS);
  assert.equal(p.parallelEvidencePlan.allEightFullCostComponentsRequired, true);
  assert.equal(p.parallelEvidencePlan.fullCostCollectionMayRunBeforeValidationDecision, true);
  assert.equal(p.parallelEvidencePlan.shadowAndPaperMayRunBeforeValidationDecision, true);

  assert.equal(p.safety.existingV3PolicyMutationAllowed, false);
  assert.equal(p.safety.priorTrainImportedAsValidation, 0);
  assert.equal(p.safety.priorValidationImportedAsOos, 0);
  assert.equal(p.safety.scheduleActivationAllowed, false);
  assert.equal(p.safety.runtimeActivationAllowed, false);
  assert.equal(p.safety.economicCreditCreated, false);
  assert.equal(p.safety.profitabilityCredit, 0);
  assert.equal(p.safety.profitabilityClaimAllowed, false);
  assert.equal(p.safety.championPromotionAllowed, false);
  assert.equal(p.safety.executionAuthority, 'NONE');
});

test('rejects a policy that starts before the pre-registered future buffer', () => {
  assert.throws(
    () => buildFastProfitabilityProspectivePolicyV1({
      candidate: candidate(),
      policyFrozenAtMs: FROZEN_AT,
      eligibleAfterMs: FROZEN_AT + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS - 1,
    }),
    /FAST_PROFITABILITY_FUTURE_BUFFER_TOO_SHORT/,
  );
});

test('candidate identity is frozen into the policy digest and tampering fails verification', () => {
  const p = policy();
  const tampered = structuredClone(p);
  tampered.candidate.symbol = 'ETHUSDT';

  const verdict = verifyFastProfitabilityProspectivePolicyV1(tampered);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('FAST_PROFITABILITY_CANDIDATE_DIGEST_MISMATCH'));
  assert.ok(verdict.blockers.includes('FAST_PROFITABILITY_POLICY_DIGEST_MISMATCH'));
});

test('the same public event can never cross Validation and Sealed OOS because source frame is not allocation authority', () => {
  const p = policy();
  const first = allocateFastProfitabilitySplit(p, allocationInput(p, 'public-event:42', 'frame:a'));
  const second = allocateFastProfitabilitySplit(p, allocationInput(p, 'public-event:42', 'frame:b'));

  assert.equal(first.split, second.split);
  assert.equal(first.bucket, second.bucket);
  assert.equal(first.allocationDigest, second.allocationDigest);
  assert.notEqual(first.sourceFrameIdentity, second.sourceFrameIdentity);
  assert.equal(first.outcomeConsulted, false);
});

test('deterministic allocator produces both Validation and Sealed OOS while remaining outcome blind', () => {
  const p = policy();
  const validation = findAllocation(p, 'VALIDATION');
  const sealed = findAllocation(p, 'SEALED_OOS');

  assert.equal(validation.result.split, 'VALIDATION');
  assert.equal(sealed.result.split, 'SEALED_OOS');
  assert.notEqual(validation.result.publicEventIdentity, sealed.result.publicEventIdentity);

  assert.throws(
    () => allocateFastProfitabilitySplit(p, {
      ...validation.input,
      netPnl: 999,
    }),
    /FAST_PROFITABILITY_OUTCOME_AWARE_ALLOCATION_FORBIDDEN/,
  );
});

test('pre-boundary evidence can never enter the fast lane', () => {
  const p = policy();
  assert.throws(
    () => allocateFastProfitabilitySplit(p, {
      publicEventIdentity: 'too-early',
      sourceFrameIdentity: 'frame:too-early',
      observedAtMs: p.eligibleAfterMs - 1,
    }),
    /FAST_PROFITABILITY_PRE_BOUNDARY_OBSERVATION_FORBIDDEN/,
  );
});

test('only genuine independently credited observations are admitted', () => {
  const p = policy();
  const validation = findAllocation(p, 'VALIDATION');

  const admitted = admitFastProfitabilityIndependentObservation(
    p,
    genuineObservation(p, validation.input, { economicOutcomeVisible: true }),
  );
  assert.equal(admitted.status, 'ADMITTED');
  assert.equal(admitted.split, 'VALIDATION');
  assert.equal(admitted.effectiveIndependentSampleCredit, 1);
  assert.equal(admitted.profitabilityCredit, 0);
  assert.equal(admitted.profitabilityClaimAllowed, false);

  assert.throws(
    () => admitFastProfitabilityIndependentObservation(
      p,
      genuineObservation(p, validation.input, { replay: true }),
    ),
    /FAST_PROFITABILITY_NON_GENUINE_REPLAY_FORBIDDEN/,
  );

  assert.throws(
    () => admitFastProfitabilityIndependentObservation(
      p,
      genuineObservation(p, validation.input, {
        independenceStatus: 'DEPENDENT',
        dependencyComponentCredit: 0,
      }),
    ),
    /FAST_PROFITABILITY_INDEPENDENCE_PROOF_REQUIRED/,
  );
});

test('Sealed OOS admission fails closed if economic outcome is visible before Validation passes', () => {
  const p = policy();
  const sealed = findAllocation(p, 'SEALED_OOS');

  assert.throws(
    () => admitFastProfitabilityIndependentObservation(
      p,
      genuineObservation(p, sealed.input, { economicOutcomeVisible: true }),
    ),
    /FAST_PROFITABILITY_SEALED_OOS_OUTCOME_LEAK/,
  );

  const admitted = admitFastProfitabilityIndependentObservation(
    p,
    genuineObservation(p, sealed.input, { economicOutcomeVisible: false }),
  );
  assert.equal(admitted.split, 'SEALED_OOS');
  assert.equal(admitted.economicOutcomeVisible, false);
});

test('Sealed OOS remains quarantined until same-candidate Validation has N>=30, complete outcomes, pass, and durable receipt readback', () => {
  const p = policy();

  const collecting = evaluateFastProfitabilityReadiness(p, {
    validationEffectiveIndependentN: 29,
    sealedOosEffectiveIndependentN: 30,
    validationOutcomeCounts: { TP: 10, SL: 10, EXPIRED: 9 },
    validationReceiptReadbackVerified: true,
    validationPassed: true,
  });
  assert.equal(collecting.validationReady, false);
  assert.equal(collecting.sealedOosRevealAllowed, false);
  assert.ok(collecting.blockers.includes('FAST_PROFITABILITY_VALIDATION_INDEPENDENT_N_INSUFFICIENT'));

  const noReceipt = evaluateFastProfitabilityReadiness(p, {
    validationEffectiveIndependentN: 30,
    sealedOosEffectiveIndependentN: 30,
    validationOutcomeCounts: { TP: 10, SL: 10, EXPIRED: 10 },
    validationReceiptReadbackVerified: false,
    validationPassed: true,
  });
  assert.equal(noReceipt.sealedOosRevealAllowed, false);
  assert.ok(noReceipt.blockers.includes('FAST_PROFITABILITY_VALIDATION_RECEIPT_READBACK_REQUIRED'));

  const ready = evaluateFastProfitabilityReadiness(p, {
    validationEffectiveIndependentN: 30,
    sealedOosEffectiveIndependentN: 30,
    validationOutcomeCounts: { TP: 10, SL: 10, EXPIRED: 10 },
    validationReceiptReadbackVerified: true,
    validationPassed: true,
  });
  assert.equal(ready.status, 'SEALED_OOS_REVEAL_READY');
  assert.equal(ready.validationReady, true);
  assert.equal(ready.sealedOosMinimumReached, true);
  assert.equal(ready.sealedOosRevealAllowed, true);
  assert.equal(ready.parallelEvidenceCollectionAllowed, true);
  assert.deepEqual(ready.fullCostComponentsRequired, FAST_PROFITABILITY_FULL_COST_COMPONENTS);

  // This policy owns evidence collection and reveal authority only. Even the
  // fully satisfied test shape may not manufacture profitability/champion truth.
  assert.equal(ready.profitabilityCredit, 0);
  assert.equal(ready.profitabilityClaimAllowed, false);
  assert.equal(ready.championPromotionAllowed, false);
  assert.equal(ready.executionAuthority, 'NONE');
});

test('mutating minimum N or safety locks invalidates the frozen policy instead of weakening the gate', () => {
  const p = policy();
  const weakened = structuredClone(p);
  weakened.validationPolicy.minimumEffectiveIndependentN = 10;
  weakened.safety.replayCredit = 1;

  const verdict = verifyFastProfitabilityProspectivePolicyV1(weakened);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.blockers.includes('FAST_PROFITABILITY_MINIMUM_N_MUTATED'));
  assert.ok(verdict.blockers.includes('FAST_PROFITABILITY_SAFETY_LOCK_INVALID'));
  assert.ok(verdict.blockers.includes('FAST_PROFITABILITY_POLICY_DIGEST_MISMATCH'));
});
