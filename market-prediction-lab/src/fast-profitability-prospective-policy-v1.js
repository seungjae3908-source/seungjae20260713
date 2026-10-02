import { createHash } from 'node:crypto';

export const FAST_PROFITABILITY_PROSPECTIVE_POLICY_V1 =
  'fast-profitability-prospective-policy-v1';
export const FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS = 24 * 60 * 60 * 1000;
export const FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N = 30;
export const FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N = 30;

export const FAST_PROFITABILITY_FULL_COST_COMPONENTS = Object.freeze([
  'commission',
  'tax',
  'spread',
  'slippage',
  'funding',
  'latency',
  'liquidityImpact',
  'partialFillImpact',
]);

const CANDIDATE_FIELDS = Object.freeze([
  'candidateId',
  'strategyId',
  'strategyVersion',
  'parameterHash',
  'researchCodeSha',
  'market',
  'symbol',
  'timeframe',
  'side',
  'riskPolicyRef',
  'costPolicyRef',
  'exitPolicyRef',
]);

const FORBIDDEN_ALLOCATION_FIELDS = Object.freeze([
  'outcome',
  'result',
  'label',
  'netPnl',
  'pnl',
  'returnPercent',
  'profitFactor',
  'winRate',
  'futureReturn',
  'targetHit',
  'stopHit',
]);

const NON_GENUINE_FLAGS = Object.freeze([
  'synthetic',
  'replay',
  'backfill',
  'historical',
  'manual',
  'operatorSelected',
  'testOnly',
]);

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function isPlainObject(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactTimestamp(value, code) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function containsForbiddenAllocationKey(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) throw new Error('FAST_PROFITABILITY_ALLOCATION_INPUT_CYCLE_FORBIDDEN');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.some((item) => containsForbiddenAllocationKey(item, seen));
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_ALLOCATION_FIELDS.includes(key)) return true;
      if (containsForbiddenAllocationKey(child, seen)) return true;
    }
    return false;
  } finally {
    seen.delete(value);
  }
}

function canonicalize(value, path = 'value') {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalize(item, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) throw new TypeError(`${path} must contain JSON-compatible values only`);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key], `${path}.${key}`)]),
  );
}

export function fastProfitabilityCanonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function fastProfitabilitySha256(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : fastProfitabilityCanonicalJson(value),
  ).digest('hex');
}

function normalizedCandidate(candidate) {
  if (!isPlainObject(candidate)) throw new Error('FAST_PROFITABILITY_CANDIDATE_REQUIRED');
  const normalized = {};
  for (const field of CANDIDATE_FIELDS) {
    if (!nonEmpty(candidate[field])) {
      throw new Error(`FAST_PROFITABILITY_CANDIDATE_${field.toUpperCase()}_REQUIRED`);
    }
    normalized[field] = candidate[field].trim();
  }
  if (!Number.isInteger(candidate.horizon) || candidate.horizon < 1) {
    throw new Error('FAST_PROFITABILITY_CANDIDATE_HORIZON_REQUIRED');
  }
  normalized.horizon = candidate.horizon;
  if (!SHA40.test(normalized.researchCodeSha)) {
    throw new Error('FAST_PROFITABILITY_RESEARCH_SHA_INVALID');
  }
  if (!SHA256.test(normalized.parameterHash)) {
    throw new Error('FAST_PROFITABILITY_PARAMETER_HASH_INVALID');
  }
  if (!['LONG', 'SHORT', 'BUY', 'SELL'].includes(normalized.side)) {
    throw new Error('FAST_PROFITABILITY_SIDE_INVALID');
  }
  return Object.freeze(normalized);
}

function withoutDigest(policy) {
  const { policyDigest: _ignored, ...rest } = policy;
  return rest;
}

function safetyLocks() {
  return Object.freeze({
    existingV3PolicyMutationAllowed: false,
    priorTrainImportedAsValidation: 0,
    priorValidationImportedAsOos: 0,
    historicalCredit: 0,
    replayCredit: 0,
    backfillCredit: 0,
    syntheticCredit: 0,
    manualCredit: 0,
    operatorSelectedCredit: 0,
    testOnlyCredit: 0,
    outcomeAwareAllocationAllowed: false,
    oosOutcomeVisibleBeforeValidationPass: false,
    strategyRetuneFromFastLaneAllowed: false,
    candidateMutationAfterFreezeAllowed: false,
    scheduleActivationAllowed: false,
    runtimeActivationAllowed: false,
    economicCreditCreated: false,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    executionAuthority: 'NONE',
    liveTrading: false,
    autoTrading: false,
    realOrderEnabled: false,
    privateTradingApiAllowed: false,
  });
}

export function buildFastProfitabilityProspectivePolicyV1({
  candidate,
  policyFrozenAtMs,
  eligibleAfterMs,
} = {}) {
  const frozenCandidate = normalizedCandidate(candidate);
  const frozenAt = exactTimestamp(policyFrozenAtMs, 'FAST_PROFITABILITY_POLICY_FROZEN_AT_INVALID');
  const eligibleAt = exactTimestamp(eligibleAfterMs, 'FAST_PROFITABILITY_ELIGIBLE_AFTER_INVALID');
  if (eligibleAt < frozenAt + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS) {
    throw new Error('FAST_PROFITABILITY_FUTURE_BUFFER_TOO_SHORT');
  }

  const candidateDigest = fastProfitabilitySha256(frozenCandidate);
  const policyCore = Object.freeze({
    schemaVersion: FAST_PROFITABILITY_PROSPECTIVE_POLICY_V1,
    status: 'FROZEN_INACTIVE',
    policyFrozenAtMs: frozenAt,
    eligibleAfterMs: eligibleAt,
    minimumFutureBufferMs: FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
    candidate: frozenCandidate,
    candidateDigest,
    splitPolicy: Object.freeze({
      mode: 'DETERMINISTIC_PROSPECTIVE_HASH_SPLIT',
      validationBasisPoints: 5000,
      sealedOosBasisPoints: 5000,
      allocationInput: Object.freeze([
        'policyDigest',
        'candidateDigest',
        'dependencyComponentId',
      ]),
      independenceBeforeSplitRequired: true,
      dependencyComponentIsAllocationAuthority: true,
      publicEventIdentityMayInfluenceSplit: false,
      sourceFrameMayInfluenceSplit: false,
      outcomeMayInfluenceSplit: false,
      reassignmentAllowed: false,
      crossSplitMovementAllowed: false,
    }),
    validationPolicy: Object.freeze({
      minimumEffectiveIndependentN: FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N,
      requiredOutcomeClasses: Object.freeze(['TP', 'SL', 'EXPIRED']),
      durableReadbackRequired: true,
      sameCandidateRequired: true,
    }),
    sealedOosPolicy: Object.freeze({
      minimumEffectiveIndependentN: FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N,
      outcomeQuarantineRequired: true,
      revealRequiresValidationReceipt: true,
      allocationVisibleBeforeReveal: true,
      economicOutcomeVisibleBeforeReveal: false,
    }),
    independencePolicy: Object.freeze({
      candidateBoundForwardIndependenceRequired: true,
      executionCalibrationIndependenceMayDefineStrategySplit: false,
      splitAssignmentAfterIndependenceRequired: true,
      dependencyComponentIsSplitAuthority: true,
      maximumCreditPerDependencyComponent: 1,
      causalGuardWindowRequired: true,
      evaluationWindowDerivedFromFrozenTimeframeAndHorizon: true,
      duplicatePublicEventCrossSplitAllowed: false,
      overlappingObservationWindowIndependentCreditAllowed: false,
    }),
    parallelEvidencePlan: Object.freeze({
      sameCandidateRequired: true,
      lanes: Object.freeze([
        'FORWARD_VALIDATION',
        'SHADOW',
        'NATURAL_PAPER',
        'SETTLEMENT',
        'FULL_COST',
      ]),
      fullCostComponents: FAST_PROFITABILITY_FULL_COST_COMPONENTS,
      allEightFullCostComponentsRequired: true,
      missingCostIsZero: false,
      fullCostCollectionMayRunBeforeValidationDecision: true,
      shadowAndPaperMayRunBeforeValidationDecision: true,
      economicResultsMayRetuneCandidate: false,
    }),
    safety: safetyLocks(),
  });

  const policyDigest = fastProfitabilitySha256(policyCore);
  return Object.freeze({
    ...policyCore,
    policyDigest,
  });
}

export function verifyFastProfitabilityProspectivePolicyV1(policy) {
  const blockers = [];
  const add = (code) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (!isPlainObject(policy)) {
    return Object.freeze({ valid: false, blockers: Object.freeze(['FAST_PROFITABILITY_POLICY_REQUIRED']) });
  }
  if (policy.schemaVersion !== FAST_PROFITABILITY_PROSPECTIVE_POLICY_V1) add('FAST_PROFITABILITY_POLICY_VERSION_INVALID');
  if (policy.status !== 'FROZEN_INACTIVE') add('FAST_PROFITABILITY_POLICY_STATUS_INVALID');
  if (!SHA256.test(String(policy.candidateDigest ?? ''))) add('FAST_PROFITABILITY_CANDIDATE_DIGEST_INVALID');
  else {
    try {
      if (fastProfitabilitySha256(normalizedCandidate(policy.candidate)) !== policy.candidateDigest) {
        add('FAST_PROFITABILITY_CANDIDATE_DIGEST_MISMATCH');
      }
    } catch {
      add('FAST_PROFITABILITY_CANDIDATE_INVALID');
    }
  }
  if (!Number.isSafeInteger(policy.policyFrozenAtMs)
    || !Number.isSafeInteger(policy.eligibleAfterMs)
    || policy.eligibleAfterMs < policy.policyFrozenAtMs + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS) {
    add('FAST_PROFITABILITY_FUTURE_BOUNDARY_INVALID');
  }
  if (policy.minimumFutureBufferMs !== FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS) {
    add('FAST_PROFITABILITY_FUTURE_BUFFER_MUTATED');
  }
  if (policy.splitPolicy?.validationBasisPoints !== 5000
    || policy.splitPolicy?.sealedOosBasisPoints !== 5000
    || policy.splitPolicy?.independenceBeforeSplitRequired !== true
    || policy.splitPolicy?.dependencyComponentIsAllocationAuthority !== true
    || policy.splitPolicy?.publicEventIdentityMayInfluenceSplit !== false
    || policy.splitPolicy?.outcomeMayInfluenceSplit !== false
    || policy.splitPolicy?.sourceFrameMayInfluenceSplit !== false
    || policy.splitPolicy?.reassignmentAllowed !== false
    || policy.splitPolicy?.crossSplitMovementAllowed !== false
    || policy.independencePolicy?.candidateBoundForwardIndependenceRequired !== true
    || policy.independencePolicy?.executionCalibrationIndependenceMayDefineStrategySplit !== false
    || policy.independencePolicy?.splitAssignmentAfterIndependenceRequired !== true
    || policy.independencePolicy?.dependencyComponentIsSplitAuthority !== true
    || policy.independencePolicy?.maximumCreditPerDependencyComponent !== 1
    || policy.independencePolicy?.causalGuardWindowRequired !== true
    || policy.independencePolicy?.evaluationWindowDerivedFromFrozenTimeframeAndHorizon !== true) {
    add('FAST_PROFITABILITY_SPLIT_POLICY_INVALID');
  }
  if (policy.validationPolicy?.minimumEffectiveIndependentN
      !== FAST_PROFITABILITY_VALIDATION_MINIMUM_INDEPENDENT_N
    || policy.sealedOosPolicy?.minimumEffectiveIndependentN
      !== FAST_PROFITABILITY_SEALED_OOS_MINIMUM_INDEPENDENT_N) {
    add('FAST_PROFITABILITY_MINIMUM_N_MUTATED');
  }
  if (fastProfitabilityCanonicalJson(policy.validationPolicy?.requiredOutcomeClasses)
      !== fastProfitabilityCanonicalJson(['TP', 'SL', 'EXPIRED'])) {
    add('FAST_PROFITABILITY_VALIDATION_OUTCOME_CLASSES_INVALID');
  }
  if (fastProfitabilityCanonicalJson(policy.parallelEvidencePlan?.fullCostComponents)
      !== fastProfitabilityCanonicalJson(FAST_PROFITABILITY_FULL_COST_COMPONENTS)
    || policy.parallelEvidencePlan?.allEightFullCostComponentsRequired !== true
    || policy.parallelEvidencePlan?.missingCostIsZero !== false
    || policy.parallelEvidencePlan?.economicResultsMayRetuneCandidate !== false) {
    add('FAST_PROFITABILITY_PARALLEL_EVIDENCE_POLICY_INVALID');
  }
  const safety = policy.safety ?? {};
  if (safety.existingV3PolicyMutationAllowed !== false
    || safety.priorTrainImportedAsValidation !== 0
    || safety.priorValidationImportedAsOos !== 0
    || safety.historicalCredit !== 0
    || safety.replayCredit !== 0
    || safety.backfillCredit !== 0
    || safety.syntheticCredit !== 0
    || safety.manualCredit !== 0
    || safety.operatorSelectedCredit !== 0
    || safety.testOnlyCredit !== 0
    || safety.outcomeAwareAllocationAllowed !== false
    || safety.oosOutcomeVisibleBeforeValidationPass !== false
    || safety.strategyRetuneFromFastLaneAllowed !== false
    || safety.candidateMutationAfterFreezeAllowed !== false
    || safety.scheduleActivationAllowed !== false
    || safety.runtimeActivationAllowed !== false
    || safety.economicCreditCreated !== false
    || safety.profitabilityCredit !== 0
    || safety.profitabilityClaimAllowed !== false
    || safety.championPromotionAllowed !== false
    || safety.executionAuthority !== 'NONE'
    || safety.liveTrading !== false
    || safety.autoTrading !== false
    || safety.realOrderEnabled !== false
    || safety.privateTradingApiAllowed !== false) {
    add('FAST_PROFITABILITY_SAFETY_LOCK_INVALID');
  }
  if (!SHA256.test(String(policy.policyDigest ?? ''))) add('FAST_PROFITABILITY_POLICY_DIGEST_INVALID');
  else if (fastProfitabilitySha256(withoutDigest(policy)) !== policy.policyDigest) {
    add('FAST_PROFITABILITY_POLICY_DIGEST_MISMATCH');
  }
  return Object.freeze({ valid: blockers.length === 0, blockers: Object.freeze(blockers) });
}

function validateAllocationInput(observation) {
  if (!isPlainObject(observation)) throw new Error('FAST_PROFITABILITY_OBSERVATION_REQUIRED');
  if (containsForbiddenAllocationKey(observation)) {
    throw new Error('FAST_PROFITABILITY_OUTCOME_AWARE_ALLOCATION_FORBIDDEN');
  }
  if (!nonEmpty(observation.publicEventIdentity)) {
    throw new Error('FAST_PROFITABILITY_PUBLIC_EVENT_IDENTITY_REQUIRED');
  }
  if (!nonEmpty(observation.sourceFrameIdentity)) {
    throw new Error('FAST_PROFITABILITY_SOURCE_FRAME_IDENTITY_REQUIRED');
  }
  if (!nonEmpty(observation.dependencyComponentId)
    || observation.independenceStatus !== 'PROVEN'
    || observation.dependencyComponentCredit !== 1) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENCE_BEFORE_SPLIT_REQUIRED');
  }
  return Object.freeze({
    publicEventIdentity: observation.publicEventIdentity.trim(),
    sourceFrameIdentity: observation.sourceFrameIdentity.trim(),
    dependencyComponentId: observation.dependencyComponentId.trim(),
    independenceStatus: 'PROVEN',
    dependencyComponentCredit: 1,
    observedAtMs: exactTimestamp(
      observation.observedAtMs,
      'FAST_PROFITABILITY_OBSERVED_AT_INVALID',
    ),
  });
}

export function allocateFastProfitabilitySplit(policy, observation) {
  const verdict = verifyFastProfitabilityProspectivePolicyV1(policy);
  if (!verdict.valid) throw new Error(`FAST_PROFITABILITY_POLICY_INVALID:${verdict.blockers.join(',')}`);
  const input = validateAllocationInput(observation);
  if (input.observedAtMs < policy.eligibleAfterMs) {
    throw new Error('FAST_PROFITABILITY_PRE_BOUNDARY_OBSERVATION_FORBIDDEN');
  }
  const allocationDigest = fastProfitabilitySha256({
    schemaVersion: 'fast-profitability-allocation-v1',
    policyDigest: policy.policyDigest,
    candidateDigest: policy.candidateDigest,
    dependencyComponentId: input.dependencyComponentId,
  });
  const bucket = Number.parseInt(allocationDigest.slice(0, 8), 16) % 10_000;
  const split = bucket < policy.splitPolicy.validationBasisPoints
    ? 'VALIDATION'
    : 'SEALED_OOS';
  return Object.freeze({
    split,
    bucket,
    allocationDigest,
    policyDigest: policy.policyDigest,
    candidateDigest: policy.candidateDigest,
    publicEventIdentity: input.publicEventIdentity,
    sourceFrameIdentity: input.sourceFrameIdentity,
    dependencyComponentId: input.dependencyComponentId,
    observedAtMs: input.observedAtMs,
    outcomeConsulted: false,
    reassignmentAllowed: false,
    profitabilityCredit: 0,
  });
}

export function admitFastProfitabilityIndependentObservation(policy, observation) {
  const allocation = allocateFastProfitabilitySplit(policy, observation);
  if (observation.policyDigest !== policy.policyDigest) {
    throw new Error('FAST_PROFITABILITY_OBSERVATION_POLICY_DIGEST_MISMATCH');
  }
  if (observation.candidateDigest !== policy.candidateDigest) {
    throw new Error('FAST_PROFITABILITY_OBSERVATION_CANDIDATE_DIGEST_MISMATCH');
  }
  for (const flag of NON_GENUINE_FLAGS) {
    if (observation[flag] !== false) {
      throw new Error(`FAST_PROFITABILITY_NON_GENUINE_${flag.toUpperCase()}_FORBIDDEN`);
    }
  }
  if (observation.independenceStatus !== 'PROVEN'
    || observation.dependencyComponentCredit !== 1
    || !nonEmpty(observation.dependencyComponentId)) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENCE_PROOF_REQUIRED');
  }
  if (allocation.split === 'SEALED_OOS' && observation.economicOutcomeVisible !== false) {
    throw new Error('FAST_PROFITABILITY_SEALED_OOS_OUTCOME_LEAK');
  }
  return Object.freeze({
    status: 'ADMITTED',
    split: allocation.split,
    allocationDigest: allocation.allocationDigest,
    dependencyComponentId: observation.dependencyComponentId.trim(),
    effectiveIndependentSampleCredit: 1,
    economicOutcomeVisible: allocation.split === 'VALIDATION'
      ? observation.economicOutcomeVisible === true
      : false,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}

export function evaluateFastProfitabilityReadiness(policy, state = {}) {
  const verdict = verifyFastProfitabilityProspectivePolicyV1(policy);
  if (!verdict.valid) {
    return Object.freeze({
      status: 'BLOCKED',
      blockers: verdict.blockers,
      validationReady: false,
      sealedOosRevealAllowed: false,
      profitabilityClaimAllowed: false,
    });
  }
  const validationN = Number.isInteger(state.validationEffectiveIndependentN)
    ? state.validationEffectiveIndependentN
    : 0;
  const sealedOosN = Number.isInteger(state.sealedOosEffectiveIndependentN)
    ? state.sealedOosEffectiveIndependentN
    : 0;
  const outcomeCounts = isPlainObject(state.validationOutcomeCounts)
    ? state.validationOutcomeCounts
    : {};
  const outcomeClassesComplete = policy.validationPolicy.requiredOutcomeClasses
    .every((name) => Number.isInteger(outcomeCounts[name]) && outcomeCounts[name] > 0);
  const validationReady = validationN >= policy.validationPolicy.minimumEffectiveIndependentN
    && outcomeClassesComplete
    && state.validationReceiptReadbackVerified === true
    && state.validationPassed === true;
  const sealedOosMinimumReached = sealedOosN >= policy.sealedOosPolicy.minimumEffectiveIndependentN;
  const sealedOosRevealAllowed = validationReady && sealedOosMinimumReached;

  const blockers = [];
  if (validationN < policy.validationPolicy.minimumEffectiveIndependentN) {
    blockers.push('FAST_PROFITABILITY_VALIDATION_INDEPENDENT_N_INSUFFICIENT');
  }
  if (!outcomeClassesComplete) blockers.push('FAST_PROFITABILITY_VALIDATION_OUTCOME_CLASSES_INCOMPLETE');
  if (state.validationReceiptReadbackVerified !== true) {
    blockers.push('FAST_PROFITABILITY_VALIDATION_RECEIPT_READBACK_REQUIRED');
  }
  if (state.validationPassed !== true) blockers.push('FAST_PROFITABILITY_VALIDATION_NOT_PASSED');
  if (!sealedOosMinimumReached) blockers.push('FAST_PROFITABILITY_SEALED_OOS_INDEPENDENT_N_INSUFFICIENT');

  return Object.freeze({
    status: sealedOosRevealAllowed ? 'SEALED_OOS_REVEAL_READY' : 'COLLECTING',
    blockers: Object.freeze(blockers),
    validationReady,
    sealedOosMinimumReached,
    sealedOosRevealAllowed,
    parallelEvidenceCollectionAllowed: true,
    fullCostComponentsRequired: FAST_PROFITABILITY_FULL_COST_COMPONENTS,
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    championPromotionAllowed: false,
    executionAuthority: 'NONE',
  });
}
