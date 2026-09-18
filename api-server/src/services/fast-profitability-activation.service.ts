import { createHash } from 'node:crypto';
import {
  FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  buildFastProfitabilityProspectivePolicyV1,
  fastProfitabilitySha256,
  verifyFastProfitabilityProspectivePolicyV1,
} from '../../../market-prediction-lab/src/fast-profitability-prospective-policy-v1.js';
import {
  buildFastProfitabilityForwardIndependenceProjection,
  fastProfitabilityEconomicEvidenceFromForwardObservation,
  routeFastProfitabilityForwardRepresentative,
  type FastProfitabilityPolicy,
} from './fast-profitability-evidence-runtime.service';
import {
  StrategyPromotionService,
  strategyCandidateId,
  type StrategyDirection,
  type StrategyIdentity,
  type StrategyPromotionRecord,
} from './strategy-promotion.service';
import {
  FORWARD_OBSERVATION_SOURCE,
  forwardObservationIdentityKey,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';
import type { ForwardObserverRuntimeState } from './forward-recommendation-observer-runtime.service';

export const FAST_PROFITABILITY_ACTIVATION_BINDING_V1 =
  'fast-profitability-activation-binding-v1' as const;
export const FAST_PROFITABILITY_ACTIVATION_SELECTION_RULE_V1 =
  'pending-unexpired-canonical-promotion-lexicographic-v1' as const;
export const FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES = 15;
export const FAST_PROFITABILITY_EXIT_POLICY_REF =
  'natural-paper-position-settlement-lifecycle-v1' as const;

const SHA40 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ACTIVATION_COMMAND = /^\/activate-fast-profitability-v1 ([0-9a-f]{40})$/u;

export type FastProfitabilityActivationApproval = Readonly<{
  issueNumber: 1102;
  commentId: string;
  actor: string;
  command: string;
}>;

export type FastProfitabilityActivationBinding = Readonly<{
  schemaVersion: 1;
  contract: typeof FAST_PROFITABILITY_ACTIVATION_BINDING_V1;
  status: 'ACTIVE_FUTURE_ONLY';
  targetSha: string;
  activationFrozenAtMs: number;
  eligibleAfterMs: number;
  sourceObservationId: string;
  sourceObservationIdentityKey: string;
  sourceObservationTimestamp: string;
  candidateId: string;
  policyDigest: string;
  candidateDigest: string;
  selectionRule: typeof FAST_PROFITABILITY_ACTIVATION_SELECTION_RULE_V1;
  collectorCadenceMinutes: typeof FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES;
  approval: Readonly<{
    issueNumber: 1102;
    commentId: string;
    actor: string;
    commandSha256: string;
  }>;
  ownerRefs: Readonly<{
    forward: '#371/#519/#719';
    validationReceipt: '#1096';
    shadow: 'CANONICAL_SHADOW_OWNER';
    naturalPaper: 'CANONICAL_PAPER_OWNER_CHAIN';
    settlement: '#828';
    fullCost: '#765/#809/#854/#861/#891';
  }>;
  safety: Readonly<{
    publicDataOnly: true;
    existingForwardObserverOnly: true;
    policyMutationAllowed: false;
    existingV3MutationAllowed: false;
    replayCredit: 0;
    backfillCredit: 0;
    syntheticCredit: 0;
    manualCredit: 0;
    outcomeAwareSelectionAllowed: false;
    scheduleCollectionAuthorized: true;
    futureEvidenceCollectionAuthorized: true;
    liveTrading: false;
    autoTrading: false;
    realOrderEnabled: false;
    privateTradingApiAllowed: false;
    executionAuthority: 'NONE';
    profitabilityClaimAllowed: false;
    championPromotionAllowed: false;
  }>;
  economicTruth: Readonly<{
    activationCreatesValidationCredit: 0;
    activationCreatesOosCredit: 0;
    activationCreatesProfitabilityCredit: 0;
    profitabilityProven: false;
    champion: 'NONE';
  }>;
  activationDigest: string;
}>;

export type FastProfitabilityActivationBundle = Readonly<{
  binding: FastProfitabilityActivationBinding;
  policy: FastProfitabilityPolicy;
}>;

export type FastProfitabilityCollectionResult = Readonly<{
  schemaVersion: 1;
  contract: 'fast-profitability-forward-collector-cycle-v1';
  activationDigest: string;
  policyDigest: string;
  candidateDigest: string;
  targetSha: string;
  observedMatchingCount: number;
  eligibleMatchingCount: number;
  settledMatchingCount: number;
  independentComponentCount: number;
  guardRejectedCount: number;
  admittedValidationRecords: number;
  admittedSealedOosRecords: number;
  pendingRepresentativeCount: number;
  blockers: readonly string[];
  profitabilityCredit: 0;
  profitabilityClaimAllowed: false;
  executionAuthority: 'NONE';
}>;

type EvidenceStore = Readonly<{
  recordValidation(input: {
    policy: unknown;
    allocation: any;
    evidence: any;
    recordedAtMs: number;
  }): Promise<unknown>;
  recordSealedOos(input: {
    policy: unknown;
    allocation: any;
    evidence: any;
    recordedAtMs: number;
  }): Promise<unknown>;
}>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactSha40(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA40.test(normalized)) throw new Error(code);
  return normalized;
}

function exactSha256(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function positiveSafeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
}

function exactActivationCommand(approval: FastProfitabilityActivationApproval, targetSha: string): void {
  if (approval.issueNumber !== 1102
    || typeof approval.commentId !== 'string'
    || !approval.commentId.trim()
    || typeof approval.actor !== 'string'
    || !approval.actor.trim()) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_APPROVAL_INVALID');
  }
  const match = ACTIVATION_COMMAND.exec(approval.command.trim());
  if (!match || match[1] !== targetSha) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_COMMAND_MISMATCH');
  }
}

function assetClassForMarket(market: string): StrategyIdentity['assetClass'] {
  if (market === 'CRYPTO_FUTURES') return 'CRYPTO_FUTURES';
  if (market === 'CRYPTO_SPOT') return 'CRYPTO_SPOT';
  if (market === 'KR_STOCK' || market === 'US_STOCK') return 'STOCK';
  throw new Error('FAST_PROFITABILITY_ACTIVATION_MARKET_INVALID');
}

function exactPromotionForObservation(
  observation: ForwardRecommendationObservation,
): StrategyPromotionRecord {
  const identity = observation.identity;
  const service = new StrategyPromotionService({ sourceSha: identity.researchCodeSha });
  const list = service.list({
    market: identity.market as any,
    strategyHorizon: 'SWING',
  });
  const matches = list.items.filter((record) => {
    const candidate = record.identity;
    return candidate.strategyFamily === 'CANONICAL_SCANNER_PROFILE'
      && candidate.strategyId === identity.strategyId
      && candidate.strategyVersion === identity.strategyVersion
      && candidate.parameterHash === identity.parameterHash
      && candidate.market === identity.market
      && candidate.timeframe === identity.timeframe
      && candidate.direction === identity.direction
      && candidate.researchCodeSha.toLowerCase() === identity.researchCodeSha.toLowerCase()
      && candidate.assetClass === assetClassForMarket(identity.market);
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? 'FAST_PROFITABILITY_ACTIVATION_CANONICAL_PROMOTION_REQUIRED'
      : 'FAST_PROFITABILITY_ACTIVATION_CANONICAL_PROMOTION_AMBIGUOUS');
  }
  const record = matches[0]!;
  if (record.executionAuthority !== 'NONE'
    || record.liveTradingAuthority !== false
    || record.privateTradingApiCount !== 0) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_PROMOTION_SAFETY_INVALID');
  }
  return record;
}

function observationSafetyValid(observation: ForwardRecommendationObservation): boolean {
  return observation.source === FORWARD_OBSERVATION_SOURCE
    && observation.executionAuthority === 'NONE'
    && observation.simulatedOnly === true
    && observation.financialMutationAllowed === false
    && observation.liveOrderAllowed === false
    && observation.privateTradingApiAllowed === false
    && observation.orderSubmitted === false
    && observation.exchangeRequestSent === false
    && observation.profitabilityClaimAllowed === false;
}

function validateObserverState(state: ForwardObserverRuntimeState, targetSha: string): void {
  if (state?.schemaVersion !== 1
    || state.researchCodeSha?.toLowerCase() !== targetSha
    || !Array.isArray(state.observations)
    || state.safety?.publicDataOnly !== true
    || state.safety?.artifactOnly !== true
    || state.safety?.executionAuthority !== 'NONE'
    || state.safety?.financialMutationAllowed !== false
    || state.safety?.liveOrderAllowed !== false
    || state.safety?.privateTradingApiAllowed !== false
    || state.safety?.profitabilityClaimAllowed !== false) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_FORWARD_STATE_INVALID');
  }
}

function candidateFromObservation(
  observation: ForwardRecommendationObservation,
  promotion: StrategyPromotionRecord,
) {
  const identity = observation.identity;
  const promotionIdentity = promotion.identity;
  const candidateId = strategyCandidateId(promotionIdentity);
  if (!/^paper-candidate-v1:[0-9a-f]{64}$/u.test(candidateId)) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_CANDIDATE_ID_INVALID');
  }
  return Object.freeze({
    candidateId,
    strategyId: identity.strategyId,
    strategyVersion: identity.strategyVersion,
    parameterHash: identity.parameterHash,
    researchCodeSha: identity.researchCodeSha.toLowerCase(),
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    horizon: identity.horizon,
    side: identity.direction as StrategyDirection,
    riskPolicyRef: promotionIdentity.riskPolicyVersion,
    costPolicyRef: promotionIdentity.costPolicyVersion,
    exitPolicyRef: FAST_PROFITABILITY_EXIT_POLICY_REF,
  });
}

function activationCandidateRows(
  state: ForwardObserverRuntimeState,
  targetSha: string,
  frozenAtMs: number,
) {
  validateObserverState(state, targetSha);
  const rows = state.observations.flatMap((observation) => {
    if (!observationSafetyValid(observation)
      || observation.status !== 'PENDING'
      || observation.identity.researchCodeSha.toLowerCase() !== targetSha) return [];
    const signalAtMs = Date.parse(observation.snapshot.timestamp);
    const expiresAtMs = Date.parse(observation.expiresAt);
    if (!Number.isFinite(signalAtMs)
      || !Number.isFinite(expiresAtMs)
      || signalAtMs > frozenAtMs
      || expiresAtMs <= frozenAtMs) return [];
    try {
      const promotion = exactPromotionForObservation(observation);
      return [{
        observation,
        promotion,
        candidate: candidateFromObservation(observation, promotion),
        identityKey: forwardObservationIdentityKey(observation.identity),
      }];
    } catch {
      return [];
    }
  });
  rows.sort((left, right) =>
    left.identityKey.localeCompare(right.identityKey)
    || left.observation.observationId.localeCompare(right.observation.observationId));
  return rows;
}

export function buildFastProfitabilityActivationBundleV1(input: Readonly<{
  targetSha: string;
  observerState: ForwardObserverRuntimeState;
  frozenAtMs: number;
  approval: FastProfitabilityActivationApproval;
}>): FastProfitabilityActivationBundle {
  const targetSha = exactSha40(input.targetSha, 'FAST_PROFITABILITY_ACTIVATION_TARGET_SHA_INVALID');
  const frozenAtMs = positiveSafeInteger(
    input.frozenAtMs,
    'FAST_PROFITABILITY_ACTIVATION_FROZEN_AT_INVALID',
  );
  exactActivationCommand(input.approval, targetSha);
  const rows = activationCandidateRows(input.observerState, targetSha, frozenAtMs);
  if (rows.length === 0) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_PENDING_CANONICAL_CANDIDATE_MISSING');
  }
  const selected = rows[0]!;
  const policy = buildFastProfitabilityProspectivePolicyV1({
    candidate: selected.candidate,
    policyFrozenAtMs: frozenAtMs,
    eligibleAfterMs: frozenAtMs + FAST_PROFITABILITY_MINIMUM_FUTURE_BUFFER_MS,
  }) as FastProfitabilityPolicy;
  const policyVerdict = verifyFastProfitabilityProspectivePolicyV1(policy);
  if (policyVerdict.valid !== true) {
    throw new Error(`FAST_PROFITABILITY_ACTIVATION_POLICY_INVALID:${policyVerdict.blockers.join(',')}`);
  }

  const core = Object.freeze({
    schemaVersion: 1 as const,
    contract: FAST_PROFITABILITY_ACTIVATION_BINDING_V1,
    status: 'ACTIVE_FUTURE_ONLY' as const,
    targetSha,
    activationFrozenAtMs: frozenAtMs,
    eligibleAfterMs: policy.eligibleAfterMs,
    sourceObservationId: selected.observation.observationId,
    sourceObservationIdentityKey: selected.identityKey,
    sourceObservationTimestamp: selected.observation.snapshot.timestamp,
    candidateId: selected.candidate.candidateId,
    policyDigest: policy.policyDigest,
    candidateDigest: policy.candidateDigest,
    selectionRule: FAST_PROFITABILITY_ACTIVATION_SELECTION_RULE_V1,
    collectorCadenceMinutes: FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES,
    approval: Object.freeze({
      issueNumber: 1102 as const,
      commentId: input.approval.commentId.trim(),
      actor: input.approval.actor.trim(),
      commandSha256: sha256Text(input.approval.command.trim()),
    }),
    ownerRefs: Object.freeze({
      forward: '#371/#519/#719' as const,
      validationReceipt: '#1096' as const,
      shadow: 'CANONICAL_SHADOW_OWNER' as const,
      naturalPaper: 'CANONICAL_PAPER_OWNER_CHAIN' as const,
      settlement: '#828' as const,
      fullCost: '#765/#809/#854/#861/#891' as const,
    }),
    safety: Object.freeze({
      publicDataOnly: true as const,
      existingForwardObserverOnly: true as const,
      policyMutationAllowed: false as const,
      existingV3MutationAllowed: false as const,
      replayCredit: 0 as const,
      backfillCredit: 0 as const,
      syntheticCredit: 0 as const,
      manualCredit: 0 as const,
      outcomeAwareSelectionAllowed: false as const,
      scheduleCollectionAuthorized: true as const,
      futureEvidenceCollectionAuthorized: true as const,
      liveTrading: false as const,
      autoTrading: false as const,
      realOrderEnabled: false as const,
      privateTradingApiAllowed: false as const,
      executionAuthority: 'NONE' as const,
      profitabilityClaimAllowed: false as const,
      championPromotionAllowed: false as const,
    }),
    economicTruth: Object.freeze({
      activationCreatesValidationCredit: 0 as const,
      activationCreatesOosCredit: 0 as const,
      activationCreatesProfitabilityCredit: 0 as const,
      profitabilityProven: false as const,
      champion: 'NONE' as const,
    }),
  });
  const binding: FastProfitabilityActivationBinding = Object.freeze({
    ...core,
    activationDigest: fastProfitabilitySha256(core),
  });
  return Object.freeze({ binding, policy });
}

export function verifyFastProfitabilityActivationBundleV1(
  bundle: FastProfitabilityActivationBundle,
): void {
  const { binding, policy } = bundle;
  if (binding?.schemaVersion !== 1
    || binding.contract !== FAST_PROFITABILITY_ACTIVATION_BINDING_V1
    || binding.status !== 'ACTIVE_FUTURE_ONLY'
    || !SHA40.test(binding.targetSha)
    || !SHA256.test(binding.activationDigest)
    || !SHA256.test(binding.policyDigest)
    || !SHA256.test(binding.candidateDigest)
    || binding.collectorCadenceMinutes !== FAST_PROFITABILITY_COLLECTOR_CADENCE_MINUTES
    || binding.safety?.executionAuthority !== 'NONE'
    || binding.safety?.liveTrading !== false
    || binding.safety?.autoTrading !== false
    || binding.safety?.realOrderEnabled !== false
    || binding.safety?.privateTradingApiAllowed !== false
    || binding.safety?.policyMutationAllowed !== false
    || binding.safety?.existingV3MutationAllowed !== false
    || binding.economicTruth?.activationCreatesValidationCredit !== 0
    || binding.economicTruth?.activationCreatesOosCredit !== 0
    || binding.economicTruth?.activationCreatesProfitabilityCredit !== 0
    || binding.economicTruth?.profitabilityProven !== false
    || binding.economicTruth?.champion !== 'NONE') {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_BINDING_INVALID');
  }
  const { activationDigest: _digest, ...core } = binding;
  if (fastProfitabilitySha256(core) !== binding.activationDigest) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_BINDING_DIGEST_MISMATCH');
  }
  const verdict = verifyFastProfitabilityProspectivePolicyV1(policy);
  if (verdict.valid !== true
    || policy.policyDigest !== binding.policyDigest
    || policy.candidateDigest !== binding.candidateDigest
    || policy.candidate.candidateId !== binding.candidateId
    || policy.candidate.researchCodeSha !== binding.targetSha
    || policy.policyFrozenAtMs !== binding.activationFrozenAtMs
    || policy.eligibleAfterMs !== binding.eligibleAfterMs) {
    throw new Error('FAST_PROFITABILITY_ACTIVATION_POLICY_BINDING_MISMATCH');
  }
}

function exactCandidateObservation(
  policy: FastProfitabilityPolicy,
  observation: ForwardRecommendationObservation,
): boolean {
  const expectedDirection = policy.candidate.side;
  return observationSafetyValid(observation)
    && observation.identity.strategyId === policy.candidate.strategyId
    && observation.identity.strategyVersion === policy.candidate.strategyVersion
    && observation.identity.parameterHash === policy.candidate.parameterHash
    && observation.identity.researchCodeSha.toLowerCase() === policy.candidate.researchCodeSha
    && observation.identity.market === policy.candidate.market
    && observation.identity.symbol === policy.candidate.symbol
    && observation.identity.timeframe === policy.candidate.timeframe
    && observation.identity.horizon === policy.candidate.horizon
    && observation.identity.direction === expectedDirection;
}

export async function collectFastProfitabilityForwardEvidenceV1(input: Readonly<{
  bundle: FastProfitabilityActivationBundle;
  observerState: ForwardObserverRuntimeState;
  store: EvidenceStore;
  recordedAtMs: number;
}>): Promise<FastProfitabilityCollectionResult> {
  verifyFastProfitabilityActivationBundleV1(input.bundle);
  const { binding, policy } = input.bundle;
  validateObserverState(input.observerState, binding.targetSha);
  const recordedAtMs = positiveSafeInteger(
    input.recordedAtMs,
    'FAST_PROFITABILITY_COLLECTION_RECORDED_AT_INVALID',
  );

  const matching = input.observerState.observations
    .filter((observation) => exactCandidateObservation(policy, observation));
  const eligible = matching.filter((observation) => {
    const signalAtMs = Date.parse(observation.snapshot.timestamp);
    return Number.isFinite(signalAtMs) && signalAtMs >= binding.eligibleAfterMs;
  });
  if (eligible.length === 0) {
    return Object.freeze({
      schemaVersion: 1,
      contract: 'fast-profitability-forward-collector-cycle-v1',
      activationDigest: binding.activationDigest,
      policyDigest: binding.policyDigest,
      candidateDigest: binding.candidateDigest,
      targetSha: binding.targetSha,
      observedMatchingCount: matching.length,
      eligibleMatchingCount: 0,
      settledMatchingCount: 0,
      independentComponentCount: 0,
      guardRejectedCount: 0,
      admittedValidationRecords: 0,
      admittedSealedOosRecords: 0,
      pendingRepresentativeCount: 0,
      blockers: Object.freeze(['FAST_PROFITABILITY_FUTURE_BOUNDARY_NOT_REACHED_OR_NO_MATCHING_OBSERVATION']),
      profitabilityCredit: 0,
      profitabilityClaimAllowed: false,
      executionAuthority: 'NONE',
    });
  }

  const projection = buildFastProfitabilityForwardIndependenceProjection({
    policy,
    observations: eligible,
  });
  const byId = new Map(eligible.map((observation) => [observation.observationId, observation]));
  let admittedValidationRecords = 0;
  let admittedSealedOosRecords = 0;
  let pendingRepresentativeCount = 0;
  const blockers: string[] = [];

  for (const component of projection.components) {
    const observation = byId.get(component.representativeObservationId);
    if (!observation) {
      blockers.push('FAST_PROFITABILITY_REPRESENTATIVE_OBSERVATION_MISSING');
      continue;
    }
    if (observation.status !== 'SETTLED' || !observation.outcome || !observation.settledAt) {
      pendingRepresentativeCount += 1;
      continue;
    }
    const allocation = routeFastProfitabilityForwardRepresentative({
      policy,
      projection,
      observationId: observation.observationId,
    });
    const economic = fastProfitabilityEconomicEvidenceFromForwardObservation({
      policy,
      allocation,
      observation,
    });
    const storeAtMs = Math.max(recordedAtMs, economic.observedAtMs);
    if (allocation.split === 'VALIDATION') {
      await input.store.recordValidation({
        policy,
        allocation,
        evidence: economic,
        recordedAtMs: storeAtMs,
      });
      admittedValidationRecords += 1;
    } else {
      await input.store.recordSealedOos({
        policy,
        allocation,
        evidence: economic,
        recordedAtMs: storeAtMs,
      });
      admittedSealedOosRecords += 1;
    }
  }

  const settledMatchingCount = eligible.filter((observation) => observation.status === 'SETTLED').length;
  return Object.freeze({
    schemaVersion: 1,
    contract: 'fast-profitability-forward-collector-cycle-v1',
    activationDigest: binding.activationDigest,
    policyDigest: binding.policyDigest,
    candidateDigest: binding.candidateDigest,
    targetSha: binding.targetSha,
    observedMatchingCount: matching.length,
    eligibleMatchingCount: eligible.length,
    settledMatchingCount,
    independentComponentCount: projection.components.length,
    guardRejectedCount: projection.guardRejectedObservationIds.length,
    admittedValidationRecords,
    admittedSealedOosRecords,
    pendingRepresentativeCount,
    blockers: Object.freeze([...new Set(blockers)]),
    profitabilityCredit: 0,
    profitabilityClaimAllowed: false,
    executionAuthority: 'NONE',
  });
}
