import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  FAST_PROFITABILITY_FULL_COST_COMPONENTS,
  allocateFastProfitabilitySplit,
  evaluateFastProfitabilityReadiness,
  fastProfitabilitySha256,
  verifyFastProfitabilityProspectivePolicyV1,
} from '../../../market-prediction-lab/src/fast-profitability-prospective-policy-v1.js';
import {
  NATURAL_SETTLEMENT_COST_COMPONENTS,
  adaptNaturalPaperSettlementFullCost,
  advanceNaturalPaperPositionLifecycle,
} from '../../../market-prediction-lab/src/natural-paper-position-settlement-lifecycle-v1.js';
import * as NaturalSettlementCostProducerModule
  from '../../../market-prediction-lab/src/natural-paper-trigger-bound-settlement-cost-producer-v1.js';
import {
  consumeManualSameCandidateValidationReceipt,
  manualPaperEvidenceSha256,
  type ManualPaperCanonicalIdentity,
  type ManualPaperCanonicalReceiptVerification,
  type ManualPaperCanonicalValidationReceipt,
} from './manual-paper-canonical-contract.service';
import {
  createForwardObserverValidationReceiptOwner,
  type ForwardObserverValidationEvidence,
  type ForwardObserverValidationReceiptReadback,
} from './forward-observer-validation-receipt-owner.service';
import {
  forwardObservationIdentityKey,
  type ForwardRecommendationObservation,
} from './forward-recommendation-observer.service';

export const FAST_PROFITABILITY_RUNTIME_V1 = 'fast-profitability-evidence-runtime-v1' as const;
export const FAST_PROFITABILITY_VALIDATION_RECORD_V1 =
  'fast-profitability-validation-record-v1' as const;
export const FAST_PROFITABILITY_SEALED_OOS_RECORD_V1 =
  'fast-profitability-sealed-oos-record-v1' as const;
export const FAST_PROFITABILITY_SEALED_OOS_CIPHER_V1 = 'AES_256_GCM_V1' as const;
export const CANONICAL_INDEPENDENCE_AUDIT_VERSION =
  'public-forward-liquidity-independence-audit-v1' as const;
export const FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1 =
  'fast-profitability-forward-independence-v1' as const;
export const FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS =
  'CANDIDATE_FORWARD_PERFORMANCE' as const;
export const FAST_PROFITABILITY_EXECUTION_CALIBRATION_CLASS =
  'EXECUTION_CALIBRATION_ONLY' as const;

const SHA256 = /^[0-9a-f]{64}$/u;
const PAPER_CANDIDATE = /^paper-candidate-v1:[0-9a-f]{64}$/u;
const PHASE3_CANDIDATE = /^phase3-candidate:sha256:[0-9a-f]{64}$/u;
const DEPENDENCY_COMPONENT = /^dependency-component:[0-9a-f]{64}$/u;
const OUTCOME_CLASSES = Object.freeze(['TP', 'SL', 'EXPIRED'] as const);

type NaturalSettlementProducer = (input?: Readonly<{
  position?: unknown;
  observation?: unknown;
  evaluatedAtMs?: number;
}>) => Promise<unknown>;

type NaturalSettlementProducerFactory = (input?: Readonly<{
  collectAuthoritativeEvidence?: (context: unknown) => Promise<unknown>;
}>) => NaturalSettlementProducer;

const createNaturalPaperTriggerBoundSettlementCostProducer = (
  NaturalSettlementCostProducerModule as unknown as Readonly<{
    createNaturalPaperTriggerBoundSettlementCostProducer: NaturalSettlementProducerFactory;
  }>
).createNaturalPaperTriggerBoundSettlementCostProducer;

if (typeof createNaturalPaperTriggerBoundSettlementCostProducer !== 'function') {
  throw new Error('FAST_PROFITABILITY_CANONICAL_SETTLEMENT_PRODUCER_EXPORT_MISSING');
}

type OutcomeClass = typeof OUTCOME_CLASSES[number];
type AnyRecord = Record<string, unknown>;

export type FastProfitabilityPolicy = Readonly<{
  schemaVersion: string;
  status: string;
  policyDigest: string;
  candidateDigest: string;
  eligibleAfterMs: number;
  candidate: Readonly<{
    candidateId: string;
    strategyId: string;
    strategyVersion: string;
    parameterHash: string;
    researchCodeSha: string;
    market: string;
    symbol: string;
    timeframe: string;
    horizon: number;
    side: string;
    riskPolicyRef: string;
    costPolicyRef: string;
    exitPolicyRef: string;
  }>;
  validationPolicy: Readonly<{
    minimumEffectiveIndependentN: number;
    requiredOutcomeClasses: readonly string[];
  }>;
  sealedOosPolicy: Readonly<{
    minimumEffectiveIndependentN: number;
  }>;
}> & AnyRecord;

export type FastProfitabilityAllocation = Readonly<{
  evidenceClass:
    | typeof FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS
    | typeof FAST_PROFITABILITY_EXECUTION_CALIBRATION_CLASS;
  split: 'VALIDATION' | 'SEALED_OOS';
  bucket: number;
  allocationDigest: string;
  policyDigest: string;
  candidateDigest: string;
  publicEventIdentity: string;
  sourceFrameIdentity: string;
  dependencyComponentId: string;
  independenceAuditDigest: string;
  observedAtMs: number;
  outcomeConsulted: false;
  reassignmentAllowed: false;
  profitabilityCredit: 0;
}>;

export type CanonicalIndependenceAudit = Readonly<{
  schemaVersion: typeof CANONICAL_INDEPENDENCE_AUDIT_VERSION;
  independentObservationRefs: readonly Readonly<{
    observationId: string;
    eventIdentity: string;
    sourceFrameIdentity: string;
    dependencyComponentId: string;
  }>[];
  auditDigest: string;
  dependencyComponents: readonly Readonly<{
    dependencyComponentId: string;
    representativeObservationId: string;
    representativeEventTimestampMs: number;
    memberObservationIds: readonly string[];
    maximumEffectiveIndependentCredit: number;
  }>[];
}>;

export type FastProfitabilityEconomicEvidence = Readonly<{
  sourceClass: typeof FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS;
  sourceObservationId: string;
  outcomeClass: OutcomeClass;
  observedAtMs: number;
  evidence: unknown;
  parallelEvidence?: unknown;
}>;

export type FastProfitabilityParallelEnvelope = Readonly<{
  lane: 'SHADOW' | 'NATURAL_PAPER';
  policyDigest: string;
  candidateDigest: string;
  candidateId: string;
  status: string;
  evidenceDigest: string;
  evidence: unknown;
  synthetic: false;
  replay: false;
  backfill: false;
  executionAuthority: 'NONE';
  profitabilityClaimAllowed: false;
}>;

export type FastProfitabilityValidationStoreRecord = Readonly<{
  schemaVersion: typeof FAST_PROFITABILITY_VALIDATION_RECORD_V1;
  policyDigest: string;
  candidateDigest: string;
  candidateId: string;
  allocation: FastProfitabilityAllocation;
  sourceClass: typeof FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS;
  sourceObservationId: string;
  outcomeClass: OutcomeClass;
  economicObservedAtMs: number;
  economicEvidenceDigest: string;
  economicEvidence: unknown;
  parallelEvidence: unknown | null;
  recordedAtMs: number;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
  recordDigest: string;
}>;

export type FastProfitabilitySealedOosMetadata = Readonly<{
  schemaVersion: typeof FAST_PROFITABILITY_SEALED_OOS_RECORD_V1;
  cipherVersion: typeof FAST_PROFITABILITY_SEALED_OOS_CIPHER_V1;
  policyDigest: string;
  candidateDigest: string;
  candidateId: string;
  allocation: FastProfitabilityAllocation;
  payloadDigest: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  recordedAtMs: number;
  economicOutcomeVisible: false;
  economicCreditCreated: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
  recordDigest: string;
}>;

export const FAST_PROFITABILITY_RUNTIME_SAFETY = Object.freeze({
  existingV3MutationAllowed: false,
  independenceBeforeSplitRequired: true,
  dependencyComponentSplitAuthorityRequired: true,
  validationStoreCreateOnly: true,
  sealedOosEncryptedAtRestRequired: true,
  sealedOosRevealRequiresOwnerVerifiedValidationReceipt: true,
  oosOutcomeVisibleBeforeValidationPass: false,
  sameCandidateRequiredAcrossAllLanes: true,
  allEightFullCostComponentsRequired: true,
  missingCostAsZeroAllowed: false,
  shadowMayCollectInParallel: true,
  naturalPaperMayCollectInParallel: true,
  settlementMayCollectInParallel: true,
  fullCostMayCollectInParallel: true,
  parallelCollectionGrantsEconomicCredit: false,
  runtimeActivationAllowed: false,
  scheduleActivationAllowed: false,
  productionMutationAllowed: false,
  dbMutationAllowed: false,
  secretMutationAllowed: false,
  environmentMutationAllowed: false,
  replayCredit: 0,
  backfillCredit: 0,
  syntheticCredit: 0,
  manualCredit: 0,
  profitabilityCredit: 0,
  profitabilityClaimAllowed: false,
  championPromotionAllowed: false,
  executionAuthority: 'NONE',
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
  privateTradingApiAllowed: false,
});

function record(value: unknown): AnyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('FAST_PROFITABILITY_RECORD_REQUIRED');
  }
  return value as AnyRecord;
}

function optionalRecord(value: unknown): AnyRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as AnyRecord
    : null;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function exactDigest(value: unknown, code: string): string {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(code);
  return normalized;
}

function safePositiveTime(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(code);
  return Number(value);
}

function safeRoot(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new Error(`FAST_PROFITABILITY_${label}_ROOT_INVALID`);
  }
  const normalized = resolved.replaceAll('\\', '/');
  if (normalized === '/opt/stock-app'
    || normalized.startsWith('/opt/stock-app/')
    || normalized.endsWith('/.git')
    || normalized.includes('/.git/')) {
    throw new Error(`FAST_PROFITABILITY_${label}_ROOT_PROTECTED`);
  }
  return resolved;
}

function canonicalText(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function exactOutcome(value: unknown): OutcomeClass {
  if (!OUTCOME_CLASSES.includes(value as OutcomeClass)) {
    throw new Error('FAST_PROFITABILITY_OUTCOME_CLASS_INVALID');
  }
  return value as OutcomeClass;
}

function assertCanonicalCandidateId(candidateId: string): void {
  if (!PAPER_CANDIDATE.test(candidateId) && !PHASE3_CANDIDATE.test(candidateId)) {
    throw new Error('FAST_PROFITABILITY_CANONICAL_CANDIDATE_ID_REQUIRED');
  }
}

function assertPolicy(policyValue: unknown): asserts policyValue is FastProfitabilityPolicy {
  const policy = record(policyValue) as FastProfitabilityPolicy;
  const verdict = verifyFastProfitabilityProspectivePolicyV1(policy);
  if (verdict.valid !== true) {
    throw new Error(`FAST_PROFITABILITY_POLICY_INVALID:${verdict.blockers.join(',')}`);
  }
  exactDigest(policy.policyDigest, 'FAST_PROFITABILITY_POLICY_DIGEST_INVALID');
  exactDigest(policy.candidateDigest, 'FAST_PROFITABILITY_CANDIDATE_DIGEST_INVALID');
  assertCanonicalCandidateId(policy.candidate.candidateId);
}

function manualIdentityPolicySide(policy: FastProfitabilityPolicy): 'LONG' | 'SHORT' {
  if (policy.candidate.market === 'CRYPTO_FUTURES') {
    if (policy.candidate.side !== 'LONG' && policy.candidate.side !== 'SHORT') {
      throw new Error('FAST_PROFITABILITY_FUTURES_SIDE_INVALID');
    }
    return policy.candidate.side;
  }
  if (policy.candidate.side !== 'BUY' && policy.candidate.side !== 'LONG') {
    throw new Error('FAST_PROFITABILITY_CASH_VALIDATION_LONG_ONLY');
  }
  return 'LONG';
}

export function assertFastProfitabilityManualIdentity(
  policyValue: unknown,
  identity: ManualPaperCanonicalIdentity,
): void {
  assertPolicy(policyValue);
  const policy = policyValue as FastProfitabilityPolicy;
  const expectedSide = manualIdentityPolicySide(policy);
  const expected = {
    candidateId: policy.candidate.candidateId,
    strategyId: policy.candidate.strategyId,
    parameterHash: policy.candidate.parameterHash,
    market: policy.candidate.market,
    symbol: policy.candidate.symbol,
    timeframe: policy.candidate.timeframe,
    side: expectedSide,
    researchCodeSha: policy.candidate.researchCodeSha,
  };
  const actual = {
    candidateId: identity.candidateId,
    strategyId: identity.strategyId,
    parameterHash: identity.parameterHash,
    market: identity.market,
    symbol: identity.symbol,
    timeframe: identity.timeframe,
    side: identity.side,
    researchCodeSha: identity.researchCodeSha,
  };
  if (fastProfitabilitySha256(expected) !== fastProfitabilitySha256(actual)) {
    throw new Error('FAST_PROFITABILITY_MANUAL_IDENTITY_MISMATCH');
  }
  if (identity.parameterDigest !== identity.parameterHash || identity.accountMode !== 'PAPER') {
    throw new Error('FAST_PROFITABILITY_MANUAL_IDENTITY_NOT_CANONICAL');
  }
}


function expectedForwardDirection(policy: FastProfitabilityPolicy): 'BUY' | 'LONG' | 'SHORT' {
  if (policy.candidate.market === 'CRYPTO_FUTURES') {
    if (policy.candidate.side !== 'LONG' && policy.candidate.side !== 'SHORT') {
      throw new Error('FAST_PROFITABILITY_FUTURES_SIDE_INVALID');
    }
    return policy.candidate.side;
  }
  if (policy.candidate.side !== 'BUY' && policy.candidate.side !== 'LONG') {
    throw new Error('FAST_PROFITABILITY_CASH_VALIDATION_LONG_ONLY');
  }
  return 'BUY';
}

function timeframeDurationMs(timeframe: string): number {
  const match = /^(\d+)(m|h|d)$/iu.exec(timeframe.trim());
  if (!match) throw new Error('FAST_PROFITABILITY_FORWARD_TIMEFRAME_UNSUPPORTED');
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('FAST_PROFITABILITY_FORWARD_TIMEFRAME_UNSUPPORTED');
  }
  const unit = match[2]!.toLowerCase();
  const multiplier = unit === 'm'
    ? 60_000
    : unit === 'h'
      ? 60 * 60_000
      : 24 * 60 * 60_000;
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error('FAST_PROFITABILITY_FORWARD_TIMEFRAME_UNSUPPORTED');
  }
  return duration;
}

function canonicalForwardObservationId(observation: ForwardRecommendationObservation): string {
  return sha256([
    'LIVE_RECOMMENDATION',
    observation.snapshot.signalId,
    observation.snapshot.timestamp,
    forwardObservationIdentityKey(observation.identity),
  ].join('|'));
}

function validateForwardObservationForFastPolicy(
  policy: FastProfitabilityPolicy,
  observation: ForwardRecommendationObservation,
): Readonly<{
  signalAtMs: number;
  dataAtMs: number;
  evaluationWindowMs: number;
  sourceFrameIdentity: string;
}> {
  const expectedDirection = expectedForwardDirection(policy);
  const expectedIdentity = {
    strategyId: policy.candidate.strategyId,
    strategyVersion: policy.candidate.strategyVersion,
    parameterHash: policy.candidate.parameterHash,
    researchCodeSha: policy.candidate.researchCodeSha.toLowerCase(),
    market: policy.candidate.market,
    symbol: policy.candidate.symbol,
    timeframe: policy.candidate.timeframe,
    horizon: policy.candidate.horizon,
    direction: expectedDirection,
  };
  if (fastProfitabilitySha256(observation.identity) !== fastProfitabilitySha256(expectedIdentity)) {
    throw new Error('FAST_PROFITABILITY_FORWARD_IDENTITY_MISMATCH');
  }
  if (observation.schemaVersion !== 'forward-recommendation-observation-v2'
    || observation.source !== 'LIVE_RECOMMENDATION'
    || (observation.status !== 'PENDING' && observation.status !== 'SETTLED')
    || observation.publicDataOnly !== true
    || observation.executionAuthority !== 'NONE'
    || observation.simulatedOnly !== true
    || observation.financialMutationAllowed !== false
    || observation.liveOrderAllowed !== false
    || observation.privateTradingApiAllowed !== false
    || observation.orderSubmitted !== false
    || observation.exchangeRequestSent !== false
    || observation.profitabilityClaimAllowed !== false) {
    throw new Error('FAST_PROFITABILITY_FORWARD_SAFETY_INVALID');
  }
  if (!SHA256.test(observation.observationId)
    || observation.observationId !== canonicalForwardObservationId(observation)) {
    throw new Error('FAST_PROFITABILITY_FORWARD_OBSERVATION_ID_INVALID');
  }
  if (!nonEmpty(observation.snapshot.signalId)
    || observation.snapshot.immutable !== true
    || observation.snapshot.executionAuthority !== 'NONE'
    || observation.snapshot.market !== observation.identity.market
    || observation.snapshot.symbol !== observation.identity.symbol
    || observation.snapshot.direction !== observation.identity.direction
    || observation.snapshot.strategyProfileVersion !== observation.identity.strategyVersion
    || observation.snapshot.timeframes[0] !== observation.identity.timeframe
    || observation.snapshot.dataTimestamp !== observation.dataTimestamp) {
    throw new Error('FAST_PROFITABILITY_FORWARD_SNAPSHOT_IDENTITY_INVALID');
  }
  const signalAtMs = Date.parse(observation.snapshot.timestamp);
  const dataAtMs = Date.parse(observation.dataTimestamp);
  if (!Number.isFinite(signalAtMs)
    || !Number.isFinite(dataAtMs)
    || signalAtMs < policy.eligibleAfterMs
    || dataAtMs > signalAtMs
    || !Number.isSafeInteger(observation.dataMaxAgeMs)
    || observation.dataMaxAgeMs <= 0
    || signalAtMs - dataAtMs > observation.dataMaxAgeMs) {
    throw new Error('FAST_PROFITABILITY_FORWARD_CAUSAL_TIME_INVALID');
  }
  const timeframeMs = timeframeDurationMs(policy.candidate.timeframe);
  const evaluationWindowMs = timeframeMs * policy.candidate.horizon;
  if (!Number.isSafeInteger(evaluationWindowMs) || evaluationWindowMs <= 0) {
    throw new Error('FAST_PROFITABILITY_FORWARD_EVALUATION_WINDOW_INVALID');
  }
  const sourceFrameIdentity = `forward-source-frame:${fastProfitabilitySha256({
    signalId: observation.snapshot.signalId,
    signalAtMs,
    dataTimestamp: observation.dataTimestamp,
    dataProvenance: observation.snapshot.dataProvenance,
    market: observation.identity.market,
    symbol: observation.identity.symbol,
    timeframe: observation.identity.timeframe,
  })}`;
  return Object.freeze({
    signalAtMs,
    dataAtMs,
    evaluationWindowMs,
    sourceFrameIdentity,
  });
}

export type FastProfitabilityForwardIndependenceProjection = Readonly<{
  schemaVersion: typeof FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1;
  policyDigest: string;
  candidateDigest: string;
  candidateId: string;
  evaluationWindowMs: number;
  guardWindowMs: number;
  components: readonly Readonly<{
    dependencyComponentId: string;
    blockIndex: number;
    blockStartMs: number;
    creditWindowEndExclusiveMs: number;
    blockEndExclusiveMs: number;
    representativeObservationId: string;
    memberObservationIds: readonly string[];
    maximumEffectiveIndependentCredit: 1;
    allocation: FastProfitabilityAllocation;
  }>[];
  guardRejectedObservationIds: readonly string[];
  projectionDigest: string;
  outcomeConsulted: false;
  profitabilityCredit: 0;
  executionAuthority: 'NONE';
}>;

export function buildFastProfitabilityForwardIndependenceProjection(input: Readonly<{
  policy: unknown;
  observations: readonly ForwardRecommendationObservation[];
}>): FastProfitabilityForwardIndependenceProjection {
  assertPolicy(input.policy);
  const policy = input.policy as FastProfitabilityPolicy;
  if (!Array.isArray(input.observations)) {
    throw new Error('FAST_PROFITABILITY_FORWARD_OBSERVATIONS_REQUIRED');
  }

  const prepared = input.observations.map((observation) => {
    const causal = validateForwardObservationForFastPolicy(policy, observation);
    const blockSpanMs = causal.evaluationWindowMs * 2;
    const elapsedMs = causal.signalAtMs - policy.eligibleAfterMs;
    const blockIndex = Math.floor(elapsedMs / blockSpanMs);
    const blockStartMs = policy.eligibleAfterMs + blockIndex * blockSpanMs;
    const offsetMs = causal.signalAtMs - blockStartMs;
    const inCreditWindow = offsetMs >= 0 && offsetMs < causal.evaluationWindowMs;
    const componentDigest = fastProfitabilitySha256({
      schemaVersion: FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1,
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      forwardIdentityKey: forwardObservationIdentityKey(observation.identity),
      blockIndex,
      blockStartMs,
      evaluationWindowMs: causal.evaluationWindowMs,
      guardWindowMs: causal.evaluationWindowMs,
    });
    return Object.freeze({
      observation,
      ...causal,
      blockIndex,
      blockStartMs,
      blockEndExclusiveMs: blockStartMs + blockSpanMs,
      creditWindowEndExclusiveMs: blockStartMs + causal.evaluationWindowMs,
      inCreditWindow,
      dependencyComponentId: `dependency-component:${componentDigest}`,
    });
  });

  const eligible = prepared.filter((item) => item.inCreditWindow);
  const guardRejectedObservationIds = Object.freeze(
    prepared.filter((item) => !item.inCreditWindow).map((item) => item.observation.observationId).sort(),
  );
  const grouped = new Map<string, typeof eligible>();
  for (const item of eligible) {
    const bucket = grouped.get(item.dependencyComponentId) ?? [];
    bucket.push(item);
    grouped.set(item.dependencyComponentId, bucket);
  }

  const components = [...grouped.entries()].map(([dependencyComponentId, members]) => {
    members.sort((left, right) => left.signalAtMs - right.signalAtMs
      || left.observation.observationId.localeCompare(right.observation.observationId));
    const representative = members[0]!;
    const componentProof = Object.freeze({
      schemaVersion: FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1,
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      candidateId: policy.candidate.candidateId,
      dependencyComponentId,
      blockIndex: representative.blockIndex,
      blockStartMs: representative.blockStartMs,
      creditWindowEndExclusiveMs: representative.creditWindowEndExclusiveMs,
      blockEndExclusiveMs: representative.blockEndExclusiveMs,
      evaluationWindowMs: representative.evaluationWindowMs,
      representativeObservationId: representative.observation.observationId,
      memberObservationIds: Object.freeze(members.map((item) => item.observation.observationId)),
      maximumEffectiveIndependentCredit: 1,
      outcomeConsulted: false,
    });
    const independenceAuditDigest = fastProfitabilitySha256(componentProof);
    const baseAllocation = allocateFastProfitabilitySplit(policy, {
      publicEventIdentity: representative.observation.observationId,
      sourceFrameIdentity: representative.sourceFrameIdentity,
      dependencyComponentId,
      independenceStatus: 'PROVEN',
      dependencyComponentCredit: 1,
      observedAtMs: representative.signalAtMs,
    });
    const allocation: FastProfitabilityAllocation = Object.freeze({
      ...baseAllocation,
      evidenceClass: FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS,
      independenceAuditDigest,
    });
    return Object.freeze({
      dependencyComponentId,
      blockIndex: representative.blockIndex,
      blockStartMs: representative.blockStartMs,
      creditWindowEndExclusiveMs: representative.creditWindowEndExclusiveMs,
      blockEndExclusiveMs: representative.blockEndExclusiveMs,
      representativeObservationId: representative.observation.observationId,
      memberObservationIds: componentProof.memberObservationIds,
      maximumEffectiveIndependentCredit: 1 as const,
      allocation,
    });
  }).sort((left, right) => left.blockIndex - right.blockIndex
    || left.representativeObservationId.localeCompare(right.representativeObservationId));

  const projectionCore = Object.freeze({
    schemaVersion: FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1,
    policyDigest: policy.policyDigest,
    candidateDigest: policy.candidateDigest,
    candidateId: policy.candidate.candidateId,
    evaluationWindowMs: prepared[0]?.evaluationWindowMs
      ?? timeframeDurationMs(policy.candidate.timeframe) * policy.candidate.horizon,
    guardWindowMs: prepared[0]?.evaluationWindowMs
      ?? timeframeDurationMs(policy.candidate.timeframe) * policy.candidate.horizon,
    components: Object.freeze(components),
    guardRejectedObservationIds,
    outcomeConsulted: false as const,
    profitabilityCredit: 0 as const,
    executionAuthority: 'NONE' as const,
  });
  return Object.freeze({
    ...projectionCore,
    projectionDigest: fastProfitabilitySha256(projectionCore),
  });
}

export function routeFastProfitabilityForwardRepresentative(input: Readonly<{
  policy: unknown;
  projection: FastProfitabilityForwardIndependenceProjection;
  observationId: string;
}>): FastProfitabilityAllocation {
  assertPolicy(input.policy);
  const policy = input.policy as FastProfitabilityPolicy;
  if (input.projection.schemaVersion !== FAST_PROFITABILITY_FORWARD_INDEPENDENCE_V1
    || input.projection.policyDigest !== policy.policyDigest
    || input.projection.candidateDigest !== policy.candidateDigest
    || input.projection.candidateId !== policy.candidate.candidateId
    || input.projection.outcomeConsulted !== false
    || input.projection.profitabilityCredit !== 0
    || input.projection.executionAuthority !== 'NONE') {
    throw new Error('FAST_PROFITABILITY_FORWARD_PROJECTION_INVALID');
  }
  const { projectionDigest: _providedDigest, ...projectionCore } = input.projection;
  if (_providedDigest !== fastProfitabilitySha256(projectionCore)) {
    throw new Error('FAST_PROFITABILITY_FORWARD_PROJECTION_DIGEST_MISMATCH');
  }
  const matches = input.projection.components.filter(
    (component) => component.representativeObservationId === input.observationId,
  );
  if (matches.length !== 1) {
    throw new Error('FAST_PROFITABILITY_FORWARD_INDEPENDENT_REPRESENTATIVE_REQUIRED');
  }
  return matches[0]!.allocation;
}

export function fastProfitabilityEconomicEvidenceFromForwardObservation(input: Readonly<{
  policy: unknown;
  allocation: FastProfitabilityAllocation;
  observation: ForwardRecommendationObservation;
  parallelEvidence?: unknown;
}>): FastProfitabilityEconomicEvidence {
  assertPolicy(input.policy);
  const policy = input.policy as FastProfitabilityPolicy;
  if (input.allocation.evidenceClass !== FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS
    || input.allocation.publicEventIdentity !== input.observation.observationId) {
    throw new Error('FAST_PROFITABILITY_FORWARD_ALLOCATION_OBSERVATION_MISMATCH');
  }
  validateForwardObservationForFastPolicy(policy, input.observation);
  if (input.observation.status !== 'SETTLED'
    || !input.observation.outcome
    || !nonEmpty(input.observation.settledAt)) {
    throw new Error('FAST_PROFITABILITY_FORWARD_SETTLED_OUTCOME_REQUIRED');
  }
  const settledAtMs = Date.parse(input.observation.settledAt);
  const signalAtMs = Date.parse(input.observation.snapshot.timestamp);
  if (!Number.isFinite(settledAtMs) || settledAtMs < signalAtMs) {
    throw new Error('FAST_PROFITABILITY_FORWARD_SETTLEMENT_TIME_INVALID');
  }
  const outcome = input.observation.outcome;
  let outcomeClass: OutcomeClass;
  if (outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'WIN') {
    outcomeClass = 'TP';
  } else if (outcome.stopLossHit && outcome.outcome === 'LOSS') {
    outcomeClass = 'SL';
  } else if (!outcome.target1Hit && !outcome.stopLossHit && outcome.outcome === 'EXPIRED') {
    outcomeClass = 'EXPIRED';
  } else {
    throw new Error('FAST_PROFITABILITY_FORWARD_OUTCOME_CLASS_UNSUPPORTED');
  }
  return Object.freeze({
    sourceClass: FAST_PROFITABILITY_FORWARD_EVIDENCE_CLASS,
    sourceObservationId: input.observation.observationId,
    outcomeClass,
    observedAtMs: settledAtMs,
    evidence: structuredClone(input.observation),
    parallelEvidence: input.parallelEvidence == null ? null : structuredClone(input.parallelEvidence),
  });
}

function normalizeIndependenceAudit(value: unknown): CanonicalIndependenceAudit {
  const outer = record(value);
  if (outer.status === 'BLOCKED_DATA') throw new Error('FAST_PROFITABILITY_INDEPENDENCE_BLOCKED');
  const audit = optionalRecord(outer.audit) ?? outer;
  if (audit.schemaVersion !== CANONICAL_INDEPENDENCE_AUDIT_VERSION) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENCE_AUDIT_VERSION_INVALID');
  }
  if (!SHA256.test(String(audit.auditDigest ?? ''))) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENCE_AUDIT_DIGEST_INVALID');
  }
  if (!Array.isArray(audit.independentObservationRefs)
    || !Array.isArray(audit.dependencyComponents)) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENCE_AUDIT_INCOMPLETE');
  }
  return audit as unknown as CanonicalIndependenceAudit;
}

export function routeFastProfitabilityCanonicalIndependentObservation(input: Readonly<{
  policy: unknown;
  independenceAudit: unknown;
  observationId: string;
}>): FastProfitabilityAllocation {
  assertPolicy(input.policy);
  const policy = input.policy as FastProfitabilityPolicy;
  const audit = normalizeIndependenceAudit(input.independenceAudit);
  const references = audit.independentObservationRefs.filter(
    (item) => item.observationId === input.observationId,
  );
  if (references.length !== 1) {
    throw new Error('FAST_PROFITABILITY_INDEPENDENT_REPRESENTATIVE_REQUIRED');
  }
  const reference = references[0]!;
  if (!DEPENDENCY_COMPONENT.test(reference.dependencyComponentId)) {
    throw new Error('FAST_PROFITABILITY_DEPENDENCY_COMPONENT_ID_INVALID');
  }
  const components = audit.dependencyComponents.filter(
    (item) => item.dependencyComponentId === reference.dependencyComponentId
      && item.representativeObservationId === reference.observationId,
  );
  if (components.length !== 1) {
    throw new Error('FAST_PROFITABILITY_DEPENDENCY_COMPONENT_REQUIRED');
  }
  const component = components[0]!;
  if (component.maximumEffectiveIndependentCredit !== 1
    || !component.memberObservationIds.includes(reference.observationId)) {
    throw new Error('FAST_PROFITABILITY_DEPENDENCY_COMPONENT_CREDIT_INVALID');
  }
  const allocation = allocateFastProfitabilitySplit(policy, {
    publicEventIdentity: reference.eventIdentity,
    sourceFrameIdentity: reference.sourceFrameIdentity,
    dependencyComponentId: reference.dependencyComponentId,
    independenceStatus: 'PROVEN',
    dependencyComponentCredit: 1,
    observedAtMs: component.representativeEventTimestampMs,
  }) as Omit<FastProfitabilityAllocation, 'independenceAuditDigest'>;
  return Object.freeze({
    ...allocation,
    evidenceClass: FAST_PROFITABILITY_EXECUTION_CALIBRATION_CLASS,
    independenceAuditDigest: audit.auditDigest,
  }) as FastProfitabilityAllocation;
}

function storeDirectory(
  root: string,
  policyDigest: string,
  candidateDigest: string,
  split: 'validation' | 'sealed-oos',
): string {
  exactDigest(policyDigest, 'FAST_PROFITABILITY_POLICY_DIGEST_INVALID');
  exactDigest(candidateDigest, 'FAST_PROFITABILITY_CANDIDATE_DIGEST_INVALID');
  return path.join(root, policyDigest, candidateDigest, split);
}

async function writeCreateOnly(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(filePath, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = await readFile(filePath, 'utf8');
    if (sha256(existing.trimEnd()) !== sha256(text.trimEnd())) {
      throw new Error('FAST_PROFITABILITY_IMMUTABLE_STORE_CONFLICT');
    }
  }
}

function validationRecordDigest(value: Omit<FastProfitabilityValidationStoreRecord, 'recordDigest'>): string {
  return fastProfitabilitySha256(value);
}

function sealedRecordDigest(value: Omit<FastProfitabilitySealedOosMetadata, 'recordDigest'>): string {
  return fastProfitabilitySha256(value);
}

function assertAllocation(policy: FastProfitabilityPolicy, allocation: FastProfitabilityAllocation): void {
  if (allocation.policyDigest !== policy.policyDigest
    || allocation.candidateDigest !== policy.candidateDigest
    || !SHA256.test(allocation.allocationDigest)
    || !SHA256.test(allocation.independenceAuditDigest)
    || !DEPENDENCY_COMPONENT.test(allocation.dependencyComponentId)
    || allocation.outcomeConsulted !== false
    || allocation.reassignmentAllowed !== false
    || allocation.profitabilityCredit !== 0) {
    throw new Error('FAST_PROFITABILITY_ALLOCATION_INVALID');
  }
  const recomputed = allocateFastProfitabilitySplit(policy, {
    publicEventIdentity: allocation.publicEventIdentity,
    sourceFrameIdentity: allocation.sourceFrameIdentity,
    dependencyComponentId: allocation.dependencyComponentId,
    independenceStatus: 'PROVEN',
    dependencyComponentCredit: 1,
    observedAtMs: allocation.observedAtMs,
  }) as Omit<FastProfitabilityAllocation, 'independenceAuditDigest'>;
  if (recomputed.split !== allocation.split
    || recomputed.bucket !== allocation.bucket
    || recomputed.allocationDigest !== allocation.allocationDigest) {
    throw new Error('FAST_PROFITABILITY_ALLOCATION_RECOMPUTE_MISMATCH');
  }
}

function normalizeEconomicEvidence(value: FastProfitabilityEconomicEvidence): FastProfitabilityEconomicEvidence {
  return Object.freeze({
    outcomeClass: exactOutcome(value.outcomeClass),
    observedAtMs: safePositiveTime(value.observedAtMs, 'FAST_PROFITABILITY_ECONOMIC_OBSERVED_AT_INVALID'),
    evidence: structuredClone(value.evidence),
    parallelEvidence: value.parallelEvidence == null ? null : structuredClone(value.parallelEvidence),
  });
}

export function createFastProfitabilityEvidenceStore(input: Readonly<{
  validationRoot: string;
  sealedOosRoot: string;
  sealingKey: Buffer;
}>) {
  const validationRoot = safeRoot(input.validationRoot, 'VALIDATION');
  const sealedOosRoot = safeRoot(input.sealedOosRoot, 'SEALED_OOS');
  if (!Buffer.isBuffer(input.sealingKey) || input.sealingKey.length !== 32) {
    throw new Error('FAST_PROFITABILITY_SEALED_OOS_256BIT_KEY_REQUIRED');
  }
  const sealingKey = Buffer.from(input.sealingKey);

  async function recordValidation(inputRecord: Readonly<{
    policy: unknown;
    allocation: FastProfitabilityAllocation;
    evidence: FastProfitabilityEconomicEvidence;
    recordedAtMs: number;
  }>): Promise<FastProfitabilityValidationStoreRecord> {
    assertPolicy(inputRecord.policy);
    const policy = inputRecord.policy as FastProfitabilityPolicy;
    assertAllocation(policy, inputRecord.allocation);
    if (inputRecord.allocation.split !== 'VALIDATION') {
      throw new Error('FAST_PROFITABILITY_VALIDATION_SPLIT_REQUIRED');
    }
    const economic = normalizeEconomicEvidence(inputRecord.evidence);
    if (economic.observedAtMs < policy.eligibleAfterMs) {
      throw new Error('FAST_PROFITABILITY_PRE_BOUNDARY_ECONOMIC_EVIDENCE_FORBIDDEN');
    }
    const recordedAtMs = safePositiveTime(inputRecord.recordedAtMs, 'FAST_PROFITABILITY_RECORDED_AT_INVALID');
    if (recordedAtMs < economic.observedAtMs) {
      throw new Error('FAST_PROFITABILITY_RECORD_PRECEDES_ECONOMIC_EVIDENCE');
    }
    const economicEvidenceDigest = fastProfitabilitySha256(economic);
    const withoutDigest = Object.freeze({
      schemaVersion: FAST_PROFITABILITY_VALIDATION_RECORD_V1,
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      candidateId: policy.candidate.candidateId,
      allocation: inputRecord.allocation,
      outcomeClass: economic.outcomeClass,
      economicEvidenceDigest,
      economicEvidence: economic.evidence,
      parallelEvidence: economic.parallelEvidence ?? null,
      recordedAtMs,
      economicCreditCreated: false as const,
      profitabilityCredit: 0 as const,
      executionAuthority: 'NONE' as const,
    });
    const stored: FastProfitabilityValidationStoreRecord = Object.freeze({
      ...withoutDigest,
      recordDigest: validationRecordDigest(withoutDigest),
    });
    const dir = storeDirectory(validationRoot, policy.policyDigest, policy.candidateDigest, 'validation');
    const filePath = path.join(dir, `${inputRecord.allocation.allocationDigest}.json`);
    await writeCreateOnly(filePath, stored);
    return stored;
  }

  async function recordSealedOos(inputRecord: Readonly<{
    policy: unknown;
    allocation: FastProfitabilityAllocation;
    evidence: FastProfitabilityEconomicEvidence;
    recordedAtMs: number;
  }>): Promise<FastProfitabilitySealedOosMetadata> {
    assertPolicy(inputRecord.policy);
    const policy = inputRecord.policy as FastProfitabilityPolicy;
    assertAllocation(policy, inputRecord.allocation);
    if (inputRecord.allocation.split !== 'SEALED_OOS') {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_SPLIT_REQUIRED');
    }
    const economic = normalizeEconomicEvidence(inputRecord.evidence);
    if (economic.observedAtMs < policy.eligibleAfterMs) {
      throw new Error('FAST_PROFITABILITY_PRE_BOUNDARY_ECONOMIC_EVIDENCE_FORBIDDEN');
    }
    const recordedAtMs = safePositiveTime(inputRecord.recordedAtMs, 'FAST_PROFITABILITY_RECORDED_AT_INVALID');
    if (recordedAtMs < economic.observedAtMs) {
      throw new Error('FAST_PROFITABILITY_RECORD_PRECEDES_ECONOMIC_EVIDENCE');
    }
    const plaintext = Buffer.from(JSON.stringify(economic));
    const payloadDigest = sha256(plaintext);
    const dir = storeDirectory(sealedOosRoot, policy.policyDigest, policy.candidateDigest, 'sealed-oos');
    const filePath = path.join(dir, `${inputRecord.allocation.allocationDigest}.json`);

    try {
      const existing = JSON.parse(await readFile(filePath, 'utf8')) as FastProfitabilitySealedOosMetadata;
      const { recordDigest: existingRecordDigest, ...existingWithoutDigest } = existing;
      if (existing.schemaVersion !== FAST_PROFITABILITY_SEALED_OOS_RECORD_V1
        || existing.cipherVersion !== FAST_PROFITABILITY_SEALED_OOS_CIPHER_V1
        || existing.policyDigest !== policy.policyDigest
        || existing.candidateDigest !== policy.candidateDigest
        || existing.allocation.allocationDigest !== inputRecord.allocation.allocationDigest
        || existing.payloadDigest !== payloadDigest
        || existingRecordDigest !== sealedRecordDigest(existingWithoutDigest)) {
        throw new Error('FAST_PROFITABILITY_SEALED_OOS_IMMUTABLE_CONFLICT');
      }
      return Object.freeze(structuredClone(existing));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof SyntaxError) {
          throw new Error('FAST_PROFITABILITY_SEALED_OOS_RECORD_INVALID');
        }
        throw error;
      }
    }

    const iv = randomBytes(12);
    const aad = Buffer.from(`${policy.policyDigest}:${policy.candidateDigest}:${inputRecord.allocation.allocationDigest}`);
    const cipher = createCipheriv('aes-256-gcm', sealingKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const withoutDigest = Object.freeze({
      schemaVersion: FAST_PROFITABILITY_SEALED_OOS_RECORD_V1,
      cipherVersion: FAST_PROFITABILITY_SEALED_OOS_CIPHER_V1,
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      candidateId: policy.candidate.candidateId,
      allocation: inputRecord.allocation,
      payloadDigest,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      recordedAtMs,
      economicOutcomeVisible: false as const,
      economicCreditCreated: false as const,
      profitabilityCredit: 0 as const,
      executionAuthority: 'NONE' as const,
    });
    const stored: FastProfitabilitySealedOosMetadata = Object.freeze({
      ...withoutDigest,
      recordDigest: sealedRecordDigest(withoutDigest),
    });
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      return stored;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = JSON.parse(await readFile(filePath, 'utf8')) as FastProfitabilitySealedOosMetadata;
      const { recordDigest: racedRecordDigest, ...racedWithoutDigest } = raced;
      if (raced.payloadDigest !== payloadDigest
        || raced.allocation.allocationDigest !== inputRecord.allocation.allocationDigest
        || racedRecordDigest !== sealedRecordDigest(racedWithoutDigest)) {
        throw new Error('FAST_PROFITABILITY_SEALED_OOS_IMMUTABLE_CONFLICT');
      }
      return Object.freeze(structuredClone(raced));
    }
  }

  async function readSealedMetadata(inputRead: Readonly<{
    policy: unknown;
    allocationDigest: string;
  }>): Promise<FastProfitabilitySealedOosMetadata> {
    assertPolicy(inputRead.policy);
    const policy = inputRead.policy as FastProfitabilityPolicy;
    exactDigest(inputRead.allocationDigest, 'FAST_PROFITABILITY_ALLOCATION_DIGEST_INVALID');
    const filePath = path.join(
      storeDirectory(sealedOosRoot, policy.policyDigest, policy.candidateDigest, 'sealed-oos'),
      `${inputRead.allocationDigest}.json`,
    );
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as FastProfitabilitySealedOosMetadata;
    if (stored.schemaVersion !== FAST_PROFITABILITY_SEALED_OOS_RECORD_V1
      || stored.cipherVersion !== FAST_PROFITABILITY_SEALED_OOS_CIPHER_V1
      || stored.policyDigest !== policy.policyDigest
      || stored.candidateDigest !== policy.candidateDigest
      || stored.recordDigest !== sealedRecordDigest((({ recordDigest: _discard, ...rest }) => rest)(stored))) {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_RECORD_INVALID');
    }
    return Object.freeze(structuredClone(stored));
  }

  async function readValidationRecords(
    policy: FastProfitabilityPolicy,
  ): Promise<FastProfitabilityValidationStoreRecord[]> {
    const validationDir = storeDirectory(
      validationRoot,
      policy.policyDigest,
      policy.candidateDigest,
      'validation',
    );
    let names: string[];
    try {
      names = (await readdir(validationDir)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.map(async (name) => {
      const stored = JSON.parse(
        await readFile(path.join(validationDir, name), 'utf8'),
      ) as FastProfitabilityValidationStoreRecord;
      const { recordDigest, ...withoutDigest } = stored;
      if (stored.schemaVersion !== FAST_PROFITABILITY_VALIDATION_RECORD_V1
        || stored.policyDigest !== policy.policyDigest
        || stored.candidateDigest !== policy.candidateDigest
        || stored.candidateId !== policy.candidate.candidateId
        || recordDigest !== validationRecordDigest(withoutDigest)) {
        throw new Error('FAST_PROFITABILITY_VALIDATION_RECORD_INVALID');
      }
      assertAllocation(policy, stored.allocation);
      if (stored.allocation.split !== 'VALIDATION') {
        throw new Error('FAST_PROFITABILITY_VALIDATION_RECORD_SPLIT_INVALID');
      }
      return Object.freeze(structuredClone(stored));
    }));
  }

  async function readSealedRecords(
    policy: FastProfitabilityPolicy,
  ): Promise<FastProfitabilitySealedOosMetadata[]> {
    const sealedDir = storeDirectory(
      sealedOosRoot,
      policy.policyDigest,
      policy.candidateDigest,
      'sealed-oos',
    );
    let names: string[];
    try {
      names = (await readdir(sealedDir)).filter((name) => name.endsWith('.json')).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.map((name) => (
      readSealedMetadata({
        policy,
        allocationDigest: name.replace(/\.json$/u, ''),
      })
    )));
  }

  async function buildValidationEvidence(
    policyValue: unknown,
    identity: ManualPaperCanonicalIdentity,
  ): Promise<ForwardObserverValidationEvidence> {
    assertPolicy(policyValue);
    const policy = policyValue as FastProfitabilityPolicy;
    assertFastProfitabilityManualIdentity(policy, identity);
    const records = await readValidationRecords(policy);
    const outcomeCounts = Object.fromEntries(OUTCOME_CLASSES.map((name) => [
      name,
      records.filter((entry) => entry.outcomeClass === name).length,
    ]));
    const outcomeClassesComplete = OUTCOME_CLASSES.every(
      (name) => Number(outcomeCounts[name]) > 0,
    );
    if (records.length < policy.validationPolicy.minimumEffectiveIndependentN) {
      throw new Error('FAST_PROFITABILITY_VALIDATION_INDEPENDENT_N_INSUFFICIENT');
    }
    if (!outcomeClassesComplete) {
      throw new Error('FAST_PROFITABILITY_VALIDATION_OUTCOME_CLASSES_INCOMPLETE');
    }
    const observedAtMs = Math.max(...records.map((entry) => entry.recordedAtMs));
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs <= policy.eligibleAfterMs) {
      throw new Error('FAST_PROFITABILITY_VALIDATION_OBSERVED_AT_INVALID');
    }
    const canonicalRecords = records.map((entry) => ({
      recordDigest: entry.recordDigest,
      allocationDigest: entry.allocation.allocationDigest,
      independenceAuditDigest: entry.allocation.independenceAuditDigest,
      dependencyComponentId: entry.allocation.dependencyComponentId,
      outcomeClass: entry.outcomeClass,
      economicEvidenceDigest: entry.economicEvidenceDigest,
      recordedAtMs: entry.recordedAtMs,
    }));
    const datasetDigest = fastProfitabilitySha256({
      schemaVersion: 'fast-profitability-validation-dataset-v1',
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      records: canonicalRecords,
    });
    const resultArtifactDigest = fastProfitabilitySha256({
      schemaVersion: 'fast-profitability-validation-result-v1',
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      datasetDigest,
      sampleSize: records.length,
      minimumSampleSize: policy.validationPolicy.minimumEffectiveIndependentN,
      outcomeCounts,
    });
    return Object.freeze({
      source: 'FORWARD_RECOMMENDATION_OBSERVER',
      provenance: 'PROSPECTIVE_PUBLIC_FORWARD',
      observedAtMs,
      prospectiveBoundaryMs: policy.eligibleAfterMs,
      oosBoundaryProven: true,
      sampleSize: records.length,
      minimumSampleSize: policy.validationPolicy.minimumEffectiveIndependentN,
      datasetDigest,
      resultArtifactDigest,
    });
  }

  async function revealSealedOos(inputReveal: Readonly<{
    policy: unknown;
    allocationDigest: string;
    identity: ManualPaperCanonicalIdentity;
    receipt: ManualPaperCanonicalValidationReceipt;
    verification: ManualPaperCanonicalReceiptVerification;
    nowMs: number;
  }>): Promise<FastProfitabilityEconomicEvidence> {
    assertPolicy(inputReveal.policy);
    const policy = inputReveal.policy as FastProfitabilityPolicy;
    assertFastProfitabilityManualIdentity(policy, inputReveal.identity);
    consumeManualSameCandidateValidationReceipt(
      inputReveal.receipt,
      inputReveal.verification,
      inputReveal.identity,
      inputReveal.nowMs,
    );
    const expectedValidationEvidence = await buildValidationEvidence(
      policy,
      inputReveal.identity,
    );
    if (inputReveal.receipt.datasetDigest !== expectedValidationEvidence.datasetDigest
      || inputReveal.receipt.resultArtifactDigest !== expectedValidationEvidence.resultArtifactDigest
      || inputReveal.receipt.prospectiveBoundaryMs !== expectedValidationEvidence.prospectiveBoundaryMs
      || inputReveal.receipt.sampleSize !== expectedValidationEvidence.sampleSize
      || inputReveal.receipt.minimumSampleSize !== expectedValidationEvidence.minimumSampleSize) {
      throw new Error('FAST_PROFITABILITY_VALIDATION_RECEIPT_STORE_BINDING_MISMATCH');
    }
    const readiness = await summarize(policy, {
      receipt: inputReveal.receipt,
      verification: inputReveal.verification,
    });
    if (readiness.sealedOosRevealAllowed !== true) {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_REVEAL_NOT_READY');
    }
    const stored = await readSealedMetadata({
      policy,
      allocationDigest: inputReveal.allocationDigest,
    });
    if (!Number.isSafeInteger(inputReveal.nowMs) || inputReveal.nowMs < stored.recordedAtMs) {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_REVEAL_CLOCK_INVALID');
    }
    if (stored.candidateId !== inputReveal.identity.candidateId) {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_CANDIDATE_MISMATCH');
    }
    const iv = Buffer.from(stored.iv, 'base64');
    const authTag = Buffer.from(stored.authTag, 'base64');
    const ciphertext = Buffer.from(stored.ciphertext, 'base64');
    const aad = Buffer.from(`${stored.policyDigest}:${stored.candidateDigest}:${stored.allocation.allocationDigest}`);
    const decipher = createDecipheriv('aes-256-gcm', sealingKey, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(authTag);
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_AUTHENTICATION_FAILED');
    }
    if (sha256(plaintext) !== stored.payloadDigest) {
      throw new Error('FAST_PROFITABILITY_SEALED_OOS_PAYLOAD_DIGEST_MISMATCH');
    }
    return Object.freeze(JSON.parse(plaintext.toString('utf8')) as FastProfitabilityEconomicEvidence);
  }

  async function summarize(policyValue: unknown, receipt?: ForwardObserverValidationReceiptReadback | null) {
    assertPolicy(policyValue);
    const policy = policyValue as FastProfitabilityPolicy;
    const validationRecords = await readValidationRecords(policy);
    const sealedRecords = await readSealedRecords(policy);
    const outcomeCounts = Object.fromEntries(OUTCOME_CLASSES.map((name) => [
      name,
      validationRecords.filter((entry) => entry.outcomeClass === name).length,
    ]));
    let receiptStoreBound = false;
    if (receipt) {
      const expectedEvidence = await buildValidationEvidence(
        policy,
        receipt.receipt.identity as ManualPaperCanonicalIdentity,
      );
      receiptStoreBound = receipt.receipt.datasetDigest === expectedEvidence.datasetDigest
        && receipt.receipt.resultArtifactDigest === expectedEvidence.resultArtifactDigest
        && receipt.receipt.prospectiveBoundaryMs === expectedEvidence.prospectiveBoundaryMs
        && receipt.receipt.sampleSize === expectedEvidence.sampleSize
        && receipt.receipt.minimumSampleSize === expectedEvidence.minimumSampleSize;
    }
    const validationReceiptReadbackVerified = receiptStoreBound
      && receipt?.verification.readbackVerified === true
      && receipt.verification.validationPassed === true
      && receipt.verification.receiptSha256 === manualPaperEvidenceSha256(receipt.receipt);
    const validationPassed = validationReceiptReadbackVerified && receipt?.receipt.status === 'VALIDATED';
    return evaluateFastProfitabilityReadiness(policy, {
      validationEffectiveIndependentN: validationRecords.length,
      sealedOosEffectiveIndependentN: sealedRecords.length,
      validationOutcomeCounts: outcomeCounts,
      validationReceiptReadbackVerified,
      validationPassed,
    });
  }

  function destroyKeyCopy(): void {
    sealingKey.fill(0);
  }

  return Object.freeze({
    recordValidation,
    recordSealedOos,
    readSealedMetadata,
    buildValidationEvidence,
    revealSealedOos,
    summarize,
    destroyKeyCopy,
  });
}

export function createFastProfitabilityValidationReceiptBridge(input: Readonly<{
  receiptRoot: string;
  maximumAgeMs: number;
  policy?: unknown;
  store?: Readonly<{
    buildValidationEvidence: (
      policy: unknown,
      identity: ManualPaperCanonicalIdentity,
    ) => Promise<ForwardObserverValidationEvidence>;
  }>;
  artifactRoot?: string;
  readValidationEvidence?: ForwardObserverValidationEvidenceReader;
}>) {
  const readValidationEvidence = input.readValidationEvidence
    ?? (input.store && input.policy
      ? ((identity: ManualPaperCanonicalIdentity) => (
        input.store!.buildValidationEvidence(input.policy, identity)
      ))
      : input.artifactRoot
        ? createForwardObserverArtifactValidationEvidenceReader({ artifactRoot: input.artifactRoot })
        : null);
  if (!readValidationEvidence) {
    throw new Error('FAST_PROFITABILITY_FORWARD_VALIDATION_EVIDENCE_READER_REQUIRED');
  }
  const issue = createForwardObserverValidationReceiptOwner({
    receiptRoot: input.receiptRoot,
    maximumAgeMs: input.maximumAgeMs,
    readValidationEvidence,
  });
  return async (request: Readonly<{
    policy: unknown;
    identity: ManualPaperCanonicalIdentity;
    nowMs: number;
  }>): Promise<ForwardObserverValidationReceiptReadback> => {
    assertPolicy(request.policy);
    assertFastProfitabilityManualIdentity(request.policy, request.identity);
    const result = await issue(request.identity, request.nowMs);
    consumeManualSameCandidateValidationReceipt(
      result.receipt,
      result.verification,
      request.identity,
      request.nowMs,
    );
    return result;
  };
}

function verifyParallelEnvelope(
  policy: FastProfitabilityPolicy,
  expectedLane: 'SHADOW' | 'NATURAL_PAPER',
  value: unknown,
): FastProfitabilityParallelEnvelope {
  const envelope = record(value) as unknown as FastProfitabilityParallelEnvelope;
  if (envelope.lane !== expectedLane
    || envelope.policyDigest !== policy.policyDigest
    || envelope.candidateDigest !== policy.candidateDigest
    || envelope.candidateId !== policy.candidate.candidateId
    || !nonEmpty(envelope.status)
    || !SHA256.test(envelope.evidenceDigest)
    || envelope.synthetic !== false
    || envelope.replay !== false
    || envelope.backfill !== false
    || envelope.executionAuthority !== 'NONE'
    || envelope.profitabilityClaimAllowed !== false
    || fastProfitabilitySha256(envelope.evidence) !== envelope.evidenceDigest) {
    throw new Error(`FAST_PROFITABILITY_${expectedLane}_EVIDENCE_INVALID`);
  }
  return Object.freeze(structuredClone(envelope));
}

export function assertFastProfitabilityEightComponentFullCost(value: unknown): AnyRecord {
  const fullCost = record(value);
  if (fullCost.status !== 'PRESENT'
    || fullCost.fullCostReady !== true
    || fullCost.unknownIsZero !== false
    || fullCost.executionAuthority !== 'NONE') {
    throw new Error('FAST_PROFITABILITY_FULL_COST_NOT_READY');
  }
  const components = record(fullCost.components);
  const expected = [...FAST_PROFITABILITY_FULL_COST_COMPONENTS];
  const canonical = [...NATURAL_SETTLEMENT_COST_COMPONENTS];
  if (fastProfitabilitySha256(expected) !== fastProfitabilitySha256(canonical)) {
    throw new Error('FAST_PROFITABILITY_FULL_COST_CONTRACT_DRIFT');
  }
  for (const name of expected) {
    const rawComponent = components[name];
    if (!rawComponent || typeof rawComponent !== 'object' || Array.isArray(rawComponent)) {
      throw new Error(`FAST_PROFITABILITY_FULL_COST_${name.toUpperCase()}_MISSING`);
    }
    const component = rawComponent as AnyRecord;
    if (component.status !== 'PRESENT'
      || !Number.isFinite(component.valuePercent)
      || Number(component.valuePercent) < 0
      || !nonEmpty(component.source)
      || !nonEmpty(component.provenance)) {
      throw new Error(`FAST_PROFITABILITY_FULL_COST_${name.toUpperCase()}_MISSING`);
    }
  }
  return Object.freeze(structuredClone(fullCost));
}

export function createFastProfitabilityParallelEvidenceBridge(input: Readonly<{
  collectShadowEvidence: (context: AnyRecord) => Promise<FastProfitabilityParallelEnvelope>;
  collectNaturalPaperEvidence: (context: AnyRecord) => Promise<FastProfitabilityParallelEnvelope>;
  collectAuthoritativeSettlementEvidence?: (context: unknown) => Promise<unknown>;
}>) {
  if (typeof input.collectShadowEvidence !== 'function'
    || typeof input.collectNaturalPaperEvidence !== 'function') {
    throw new Error('FAST_PROFITABILITY_PARALLEL_OWNER_COLLECTORS_REQUIRED');
  }
  const settlementProducer = input.collectAuthoritativeSettlementEvidence
    ? createNaturalPaperTriggerBoundSettlementCostProducer({
      collectAuthoritativeEvidence: input.collectAuthoritativeSettlementEvidence,
    })
    : null;

  return async (request: Readonly<{
    policy: unknown;
    allocation: FastProfitabilityAllocation;
    observedAtMs: number;
    position?: unknown;
    observation?: unknown;
    evaluatedAtMs?: number;
  }>) => {
    assertPolicy(request.policy);
    const policy = request.policy as FastProfitabilityPolicy;
    assertAllocation(policy, request.allocation);
    const common = Object.freeze({
      schemaVersion: FAST_PROFITABILITY_RUNTIME_V1,
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      candidateId: policy.candidate.candidateId,
      allocation: request.allocation,
      observedAtMs: safePositiveTime(request.observedAtMs, 'FAST_PROFITABILITY_PARALLEL_OBSERVED_AT_INVALID'),
      existingV3MutationAllowed: false,
      economicCreditCreated: false,
      profitabilityCredit: 0,
      executionAuthority: 'NONE',
    });

    const [shadowResult, naturalResult] = await Promise.allSettled([
      input.collectShadowEvidence(common),
      input.collectNaturalPaperEvidence(common),
    ]);
    const blockers: string[] = [];
    let shadow: FastProfitabilityParallelEnvelope | null = null;
    let naturalPaper: FastProfitabilityParallelEnvelope | null = null;
    if (shadowResult.status === 'fulfilled') {
      try { shadow = verifyParallelEnvelope(policy, 'SHADOW', shadowResult.value); }
      catch { blockers.push('FAST_PROFITABILITY_SHADOW_EVIDENCE_INVALID'); }
    } else {
      blockers.push('FAST_PROFITABILITY_SHADOW_EVIDENCE_UNAVAILABLE');
    }
    if (naturalResult.status === 'fulfilled') {
      try { naturalPaper = verifyParallelEnvelope(policy, 'NATURAL_PAPER', naturalResult.value); }
      catch { blockers.push('FAST_PROFITABILITY_NATURAL_PAPER_EVIDENCE_INVALID'); }
    } else {
      blockers.push('FAST_PROFITABILITY_NATURAL_PAPER_EVIDENCE_UNAVAILABLE');
    }

    let settlementBinding: AnyRecord | null = null;
    let fullCost: AnyRecord | null = null;
    let lifecycle: AnyRecord | null = null;
    if (settlementProducer && request.position && request.observation && request.evaluatedAtMs) {
      const produced = await settlementProducer({
        position: request.position,
        observation: request.observation,
        evaluatedAtMs: request.evaluatedAtMs,
      });
      settlementBinding = optionalRecord(produced);
      if (settlementBinding?.status === 'PRESENT') {
        const boundObservation = settlementBinding.observation;
        const position = request.position;
        const trigger = optionalRecord(position)?.lifecycle
          ? optionalRecord(optionalRecord(position)?.lifecycle)?.pendingExit
          : null;
        try {
          fullCost = assertFastProfitabilityEightComponentFullCost(
            adaptNaturalPaperSettlementFullCost({
              position,
              observation: boundObservation,
              trigger,
              evaluatedAtMs: request.evaluatedAtMs,
            }),
          );
          lifecycle = optionalRecord(advanceNaturalPaperPositionLifecycle({
            position,
            observation: boundObservation,
            trigger,
            evaluatedAtMs: request.evaluatedAtMs,
          }));
        } catch {
          blockers.push('FAST_PROFITABILITY_SETTLEMENT_FULL_COST_NOT_READY');
        }
      } else {
        blockers.push('FAST_PROFITABILITY_SETTLEMENT_EVIDENCE_BLOCKED');
      }
    } else {
      blockers.push('FAST_PROFITABILITY_SETTLEMENT_COLLECTOR_NOT_CONNECTED');
    }

    return Object.freeze({
      schemaVersion: FAST_PROFITABILITY_RUNTIME_V1,
      status: blockers.length === 0 ? 'PARALLEL_EVIDENCE_PRESENT' : 'PARALLEL_EVIDENCE_PARTIAL',
      blockers: Object.freeze([...new Set(blockers)]),
      policyDigest: policy.policyDigest,
      candidateDigest: policy.candidateDigest,
      candidateId: policy.candidate.candidateId,
      allocation: request.allocation,
      shadow,
      naturalPaper,
      settlementBinding: settlementBinding ? structuredClone(settlementBinding) : null,
      fullCost: fullCost ? structuredClone(fullCost) : null,
      lifecycle: lifecycle ? structuredClone(lifecycle) : null,
      fullCostReady: fullCost != null,
      economicCreditCreated: false,
      naturalSampleCredit: 0,
      profitabilityCredit: 0,
      profitabilityClaimAllowed: false,
      championPromotionAllowed: false,
      executionAuthority: 'NONE',
    });
  };
}

export async function destroyFastProfitabilityTestStore(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
