import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
  type PublicForwardPartialFillCalibrationDataset,
  verifyPublicForwardPartialFillCalibrationDataset,
} from './public-forward-partial-fill-calibration-dataset-store.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_VERSION =
  'public-forward-partial-fill-calibration-split-audit-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_SAFETY = Object.freeze({
  verifiedForwardDatasetRequired: true,
  externalRegimeEvidenceRequired: true,
  regimeComputationOwned: false,
  defaultSampleThresholdAllowed: false,
  randomSplitAllowed: false,
  chronologicalSplitRequired: true,
  oosPerformanceEvaluationAllowed: false,
  partialFillCostProduced: false,
  calibrationArtifactProduced: false,
  oosValidationComplete: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
});

export type PartialFillCalibrationSplit = 'TRAIN' | 'VALIDATION' | 'OOS';

type SplitWindow = Readonly<{
  startInclusiveMs: number;
  endExclusiveMs: number;
}>;

type SplitMinimums = Readonly<{
  train: number;
  validation: number;
  oos: number;
}>;

export type PublicForwardPartialFillRegimeBinding = Readonly<{
  observationId: string;
  sourceObservationLineageDigest: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  regimeOwnerIdentity: string;
  regimeEvidenceIdentity: string;
  regimeEvidenceDigest: string;
  regimePolicyIdentity: string;
  regimePolicyDigest: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  observedAtMs: number;
}>;

export type PublicForwardPartialFillScopeMinimum = Readonly<{
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  minimums: SplitMinimums;
}>;

export type PublicForwardPartialFillSplitPolicy = Readonly<{
  policyIdentity: string;
  policyVersion: string;
  policyFrozenAtMs: number;
  expectedRegimeOwnerIdentity: string;
  expectedRegimePolicyIdentity: string;
  expectedRegimePolicyDigest: string;
  maxRegimeEvidenceAgeMs: number;
  windows: Readonly<{
    train: SplitWindow;
    validation: SplitWindow;
    oos: SplitWindow;
  }>;
  overallMinimums: SplitMinimums;
  scopeMinimums: readonly PublicForwardPartialFillScopeMinimum[];
}>;

export type PublicForwardPartialFillSplitAssignment = Readonly<{
  observationId: string;
  sourceObservationLineageDigest: string;
  split: PartialFillCalibrationSplit;
  eventStartMs: number;
  observedAtMs: number;
  scopeKey: string;
  regimeEvidenceIdentity: string;
  regimeEvidenceDigest: string;
}>;

export type PublicForwardPartialFillScopeCount = Readonly<{
  scopeKey: string;
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
  counts: Readonly<{
    train: number;
    validation: number;
    oos: number;
  }>;
  required: SplitMinimums;
}>;

export type PublicForwardPartialFillSplitAuditManifest = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_VERSION;
  datasetSchemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION;
  datasetStoreContract: typeof PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT;
  datasetIdentity: string;
  datasetDigest: string;
  collectorCodeSha: string;
  splitPolicyIdentity: string;
  splitPolicyVersion: string;
  splitPolicyDigest: string;
  splitPolicyFrozenAtMs: number;
  regimeOwnerIdentity: string;
  regimePolicyIdentity: string;
  regimePolicyDigest: string;
  assignmentDigest: string;
  auditDigest: string;
  totalObservationCount: number;
  counts: Readonly<{
    train: number;
    validation: number;
    oos: number;
  }>;
  assignments: readonly PublicForwardPartialFillSplitAssignment[];
  scopeCounts: readonly PublicForwardPartialFillScopeCount[];
  sampleDeficits: readonly string[];
  regimeScopeComplete: true;
  splitAssignmentComplete: true;
  calibrationSampleSufficient: boolean;
  oosValidationComplete: false;
  calibrationArtifactProduced: false;
  partialFillCostPresent: false;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
  partialFillStatus: 'BLOCKED_DATA';
  fullCostReady: false;
  executionAuthority: 'NONE';
  privateApiUsed: false;
  liveTrading: false;
  orderSubmitted: false;
}>;

export type PublicForwardPartialFillSplitAuditResult = Readonly<{
  status: 'PRESENT' | 'BLOCKED_DATA';
  blockers: readonly string[];
  audit: PublicForwardPartialFillSplitAuditManifest | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('NON_FINITE_NUMBER_NOT_CANONICAL');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') throw new TypeError('UNSUPPORTED_CANONICAL_VALUE');
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function nonEmpty(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 240 ? normalized : null;
}

function exactDigest(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return SHA256.test(normalized) ? normalized : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function validateWindow(window: SplitWindow): boolean {
  return finitePositive(window.startInclusiveMs)
    && finitePositive(window.endExclusiveMs)
    && window.startInclusiveMs < window.endExclusiveMs;
}

function scopeKey(value: Readonly<{
  market: 'CRYPTO_FUTURES';
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantityNotionalBucketIdentity: string;
  volatilityRegimeIdentity: string;
  liquidityRegimeIdentity: string;
}>): string {
  return [
    value.market,
    value.symbol,
    value.side,
    value.quantityNotionalBucketIdentity,
    value.volatilityRegimeIdentity,
    value.liquidityRegimeIdentity,
  ].join('|');
}

function splitForTimestamp(
  timestampMs: number,
  windows: PublicForwardPartialFillSplitPolicy['windows'],
): PartialFillCalibrationSplit | null {
  if (timestampMs >= windows.train.startInclusiveMs && timestampMs < windows.train.endExclusiveMs) return 'TRAIN';
  if (timestampMs >= windows.validation.startInclusiveMs && timestampMs < windows.validation.endExclusiveMs) return 'VALIDATION';
  if (timestampMs >= windows.oos.startInclusiveMs && timestampMs < windows.oos.endExclusiveMs) return 'OOS';
  return null;
}

function validatePolicy(policy: PublicForwardPartialFillSplitPolicy): string[] {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (!nonEmpty(policy.policyIdentity)) add('SPLIT_POLICY_IDENTITY_INVALID');
  if (!nonEmpty(policy.policyVersion)) add('SPLIT_POLICY_VERSION_INVALID');
  if (!finitePositive(policy.policyFrozenAtMs)) add('SPLIT_POLICY_FROZEN_AT_INVALID');
  if (!nonEmpty(policy.expectedRegimeOwnerIdentity)) add('REGIME_OWNER_IDENTITY_INVALID');
  if (!nonEmpty(policy.expectedRegimePolicyIdentity)) add('REGIME_POLICY_IDENTITY_INVALID');
  if (!exactDigest(policy.expectedRegimePolicyDigest)) add('REGIME_POLICY_DIGEST_INVALID');
  if (!positiveInteger(policy.maxRegimeEvidenceAgeMs)) add('REGIME_MAX_AGE_INVALID');

  if (!validateWindow(policy.windows.train)) add('TRAIN_WINDOW_INVALID');
  if (!validateWindow(policy.windows.validation)) add('VALIDATION_WINDOW_INVALID');
  if (!validateWindow(policy.windows.oos)) add('OOS_WINDOW_INVALID');
  if (validateWindow(policy.windows.train) && validateWindow(policy.windows.validation)
    && policy.windows.train.endExclusiveMs > policy.windows.validation.startInclusiveMs) add('TRAIN_VALIDATION_WINDOW_OVERLAP');
  if (validateWindow(policy.windows.validation) && validateWindow(policy.windows.oos)
    && policy.windows.validation.endExclusiveMs > policy.windows.oos.startInclusiveMs) add('VALIDATION_OOS_WINDOW_OVERLAP');
  if (finitePositive(policy.policyFrozenAtMs) && validateWindow(policy.windows.train)
    && policy.policyFrozenAtMs > policy.windows.train.endExclusiveMs) add('SPLIT_POLICY_NOT_FROZEN_BEFORE_VALIDATION');

  for (const [name, value] of Object.entries(policy.overallMinimums)) {
    if (!positiveInteger(value)) add(`OVERALL_${name.toUpperCase()}_MINIMUM_INVALID`);
  }

  if (!Array.isArray(policy.scopeMinimums) || policy.scopeMinimums.length === 0) {
    add('SCOPE_MINIMUMS_REQUIRED');
  } else {
    const keys = new Set<string>();
    for (const minimum of policy.scopeMinimums) {
      if (minimum.market !== 'CRYPTO_FUTURES') add('SCOPE_MARKET_INVALID');
      if (!nonEmpty(minimum.symbol)) add('SCOPE_SYMBOL_INVALID');
      if (!['LONG', 'SHORT'].includes(minimum.side)) add('SCOPE_SIDE_INVALID');
      if (!nonEmpty(minimum.quantityNotionalBucketIdentity)) add('SCOPE_BUCKET_INVALID');
      if (!nonEmpty(minimum.volatilityRegimeIdentity)) add('SCOPE_VOLATILITY_REGIME_INVALID');
      if (!nonEmpty(minimum.liquidityRegimeIdentity)) add('SCOPE_LIQUIDITY_REGIME_INVALID');
      for (const [name, value] of Object.entries(minimum.minimums)) {
        if (!positiveInteger(value)) add(`SCOPE_${name.toUpperCase()}_MINIMUM_INVALID`);
      }
      const key = scopeKey(minimum);
      if (keys.has(key)) add('SCOPE_MINIMUM_DUPLICATE');
      keys.add(key);
    }
  }

  return blockers;
}

function validateBinding(
  binding: PublicForwardPartialFillRegimeBinding,
  observation: PublicForwardPartialFillCalibrationDataset['observations'][number]['observation'],
  policy: PublicForwardPartialFillSplitPolicy,
): string[] {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (binding.observationId !== observation.observationId) add('REGIME_BINDING_OBSERVATION_ID_MISMATCH');
  if (binding.sourceObservationLineageDigest !== observation.sourceObservationLineageDigest) add('REGIME_BINDING_LINEAGE_DIGEST_MISMATCH');
  if (binding.market !== observation.market) add('REGIME_BINDING_MARKET_MISMATCH');
  if (binding.symbol !== observation.symbol) add('REGIME_BINDING_SYMBOL_MISMATCH');
  if (binding.side !== observation.side) add('REGIME_BINDING_SIDE_MISMATCH');
  if (binding.quantityNotionalBucketIdentity !== observation.quantityNotionalBucketIdentity) add('REGIME_BINDING_BUCKET_MISMATCH');
  if (binding.regimeOwnerIdentity !== policy.expectedRegimeOwnerIdentity) add('REGIME_OWNER_IDENTITY_MISMATCH');
  if (binding.regimePolicyIdentity !== policy.expectedRegimePolicyIdentity) add('REGIME_POLICY_IDENTITY_MISMATCH');
  if (binding.regimePolicyDigest !== policy.expectedRegimePolicyDigest) add('REGIME_POLICY_DIGEST_MISMATCH');
  if (!nonEmpty(binding.regimeEvidenceIdentity)) add('REGIME_EVIDENCE_IDENTITY_INVALID');
  if (!exactDigest(binding.regimeEvidenceDigest)) add('REGIME_EVIDENCE_DIGEST_INVALID');
  if (!nonEmpty(binding.volatilityRegimeIdentity)) add('VOLATILITY_REGIME_IDENTITY_INVALID');
  if (!nonEmpty(binding.liquidityRegimeIdentity)) add('LIQUIDITY_REGIME_IDENTITY_INVALID');
  if (!finitePositive(binding.observedAtMs)) add('REGIME_EVIDENCE_TIMESTAMP_INVALID');
  if (finitePositive(binding.observedAtMs) && binding.observedAtMs > observation.windowStartMs) add('REGIME_EVIDENCE_AFTER_EVENT_START');
  if (finitePositive(binding.observedAtMs)
    && observation.windowStartMs - binding.observedAtMs > policy.maxRegimeEvidenceAgeMs) add('REGIME_EVIDENCE_STALE');

  return blockers;
}

function blocked(...codes: string[]): PublicForwardPartialFillSplitAuditResult {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(codes)]),
    audit: null,
  });
}

export function auditPublicForwardPartialFillCalibrationSplits(input: Readonly<{
  dataset: PublicForwardPartialFillCalibrationDataset;
  regimeBindings: readonly PublicForwardPartialFillRegimeBinding[];
  policy: PublicForwardPartialFillSplitPolicy;
}>): PublicForwardPartialFillSplitAuditResult {
  const datasetVerification = verifyPublicForwardPartialFillCalibrationDataset(input.dataset);
  if (!datasetVerification.valid) return blocked('DATASET_INVALID', ...datasetVerification.blockers);
  if (input.dataset.sampleClass !== 'FORWARD_NATURAL_SAMPLE') return blocked('FORWARD_NATURAL_DATASET_REQUIRED');
  if (input.dataset.observationCount <= 0) return blocked('FORWARD_DATASET_EMPTY');

  const policyBlockers = validatePolicy(input.policy);
  if (policyBlockers.length > 0) return blocked(...policyBlockers);

  const bindingByObservationId = new Map<string, PublicForwardPartialFillRegimeBinding>();
  for (const binding of input.regimeBindings) {
    if (bindingByObservationId.has(binding.observationId)) return blocked('REGIME_BINDING_DUPLICATE_OBSERVATION_ID');
    bindingByObservationId.set(binding.observationId, binding);
  }

  const datasetObservationIds = new Set(input.dataset.observations.map((stored) => stored.observationId));
  for (const binding of input.regimeBindings) {
    if (!datasetObservationIds.has(binding.observationId)) return blocked('REGIME_BINDING_ORPHAN');
  }

  const scopePolicy = new Map<string, PublicForwardPartialFillScopeMinimum>();
  for (const minimum of input.policy.scopeMinimums) scopePolicy.set(scopeKey(minimum), minimum);

  const assignments: PublicForwardPartialFillSplitAssignment[] = [];
  const lineageDigests = new Set<string>();
  const regimeEvidenceIds = new Set<string>();
  const regimeEvidenceDigests = new Set<string>();
  const structuralBlockers: string[] = [];
  const addStructural = (code: string) => {
    if (!structuralBlockers.includes(code)) structuralBlockers.push(code);
  };

  for (const stored of input.dataset.observations) {
    const observation = stored.observation;
    const binding = bindingByObservationId.get(observation.observationId);
    if (!binding) {
      addStructural('REGIME_BINDING_MISSING');
      continue;
    }
    validateBinding(binding, observation, input.policy).forEach(addStructural);

    if (lineageDigests.has(observation.sourceObservationLineageDigest)) addStructural('SOURCE_LINEAGE_REUSED_ACROSS_SAMPLES');
    lineageDigests.add(observation.sourceObservationLineageDigest);
    if (regimeEvidenceIds.has(binding.regimeEvidenceIdentity)) addStructural('REGIME_EVIDENCE_IDENTITY_REUSED');
    regimeEvidenceIds.add(binding.regimeEvidenceIdentity);
    if (regimeEvidenceDigests.has(binding.regimeEvidenceDigest)) addStructural('REGIME_EVIDENCE_DIGEST_REUSED');
    regimeEvidenceDigests.add(binding.regimeEvidenceDigest);

    const split = splitForTimestamp(observation.windowStartMs, input.policy.windows);
    if (!split) {
      addStructural('OBSERVATION_OUTSIDE_SPLIT_WINDOWS');
      continue;
    }

    const key = scopeKey({
      market: observation.market,
      symbol: observation.symbol,
      side: observation.side,
      quantityNotionalBucketIdentity: observation.quantityNotionalBucketIdentity,
      volatilityRegimeIdentity: binding.volatilityRegimeIdentity,
      liquidityRegimeIdentity: binding.liquidityRegimeIdentity,
    });
    if (!scopePolicy.has(key)) addStructural('UNPOLICIED_SCOPE_PRESENT');

    assignments.push(Object.freeze({
      observationId: observation.observationId,
      sourceObservationLineageDigest: observation.sourceObservationLineageDigest,
      split,
      eventStartMs: observation.windowStartMs,
      observedAtMs: observation.observedAtMs,
      scopeKey: key,
      regimeEvidenceIdentity: binding.regimeEvidenceIdentity,
      regimeEvidenceDigest: binding.regimeEvidenceDigest,
    }));
  }

  if (structuralBlockers.length > 0) return blocked(...structuralBlockers);
  if (assignments.length !== input.dataset.observationCount) return blocked('SPLIT_ASSIGNMENT_COUNT_MISMATCH');

  assignments.sort((left, right) => left.eventStartMs - right.eventStartMs
    || left.observationId.localeCompare(right.observationId));

  const counts = { train: 0, validation: 0, oos: 0 };
  const scopeCountsMap = new Map<string, { train: number; validation: number; oos: number }>();
  for (const minimum of input.policy.scopeMinimums) {
    scopeCountsMap.set(scopeKey(minimum), { train: 0, validation: 0, oos: 0 });
  }
  for (const assignment of assignments) {
    const bucket = scopeCountsMap.get(assignment.scopeKey);
    if (!bucket) return blocked('SCOPE_COUNT_INTERNAL_MISMATCH');
    if (assignment.split === 'TRAIN') {
      counts.train += 1;
      bucket.train += 1;
    } else if (assignment.split === 'VALIDATION') {
      counts.validation += 1;
      bucket.validation += 1;
    } else {
      counts.oos += 1;
      bucket.oos += 1;
    }
  }

  const sampleDeficits: string[] = [];
  const overallRequired = input.policy.overallMinimums;
  if (counts.train < overallRequired.train) sampleDeficits.push(`OVERALL_TRAIN:${counts.train}/${overallRequired.train}`);
  if (counts.validation < overallRequired.validation) sampleDeficits.push(`OVERALL_VALIDATION:${counts.validation}/${overallRequired.validation}`);
  if (counts.oos < overallRequired.oos) sampleDeficits.push(`OVERALL_OOS:${counts.oos}/${overallRequired.oos}`);

  const scopeCounts = input.policy.scopeMinimums
    .map((minimum) => {
      const key = scopeKey(minimum);
      const current = scopeCountsMap.get(key) ?? { train: 0, validation: 0, oos: 0 };
      if (current.train < minimum.minimums.train) sampleDeficits.push(`${key}:TRAIN:${current.train}/${minimum.minimums.train}`);
      if (current.validation < minimum.minimums.validation) sampleDeficits.push(`${key}:VALIDATION:${current.validation}/${minimum.minimums.validation}`);
      if (current.oos < minimum.minimums.oos) sampleDeficits.push(`${key}:OOS:${current.oos}/${minimum.minimums.oos}`);
      return Object.freeze({
        scopeKey: key,
        market: minimum.market,
        symbol: minimum.symbol,
        side: minimum.side,
        quantityNotionalBucketIdentity: minimum.quantityNotionalBucketIdentity,
        volatilityRegimeIdentity: minimum.volatilityRegimeIdentity,
        liquidityRegimeIdentity: minimum.liquidityRegimeIdentity,
        counts: Object.freeze({ ...current }),
        required: minimum.minimums,
      });
    })
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));

  const splitPolicyDigest = digest(input.policy);
  const assignmentDigest = digest(assignments);
  const baseManifest = Object.freeze({
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_SPLIT_AUDIT_VERSION,
    datasetSchemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_DATASET_VERSION,
    datasetStoreContract: PUBLIC_FORWARD_PARTIAL_FILL_CALIBRATION_STORE_CONTRACT,
    datasetIdentity: input.dataset.datasetIdentity,
    datasetDigest: input.dataset.datasetDigest,
    collectorCodeSha: input.dataset.collectorCodeSha,
    splitPolicyIdentity: input.policy.policyIdentity,
    splitPolicyVersion: input.policy.policyVersion,
    splitPolicyDigest,
    splitPolicyFrozenAtMs: input.policy.policyFrozenAtMs,
    regimeOwnerIdentity: input.policy.expectedRegimeOwnerIdentity,
    regimePolicyIdentity: input.policy.expectedRegimePolicyIdentity,
    regimePolicyDigest: input.policy.expectedRegimePolicyDigest,
    assignmentDigest,
    totalObservationCount: input.dataset.observationCount,
    counts: Object.freeze({ ...counts }),
    assignments: Object.freeze([...assignments]),
    scopeCounts: Object.freeze(scopeCounts),
    sampleDeficits: Object.freeze([...sampleDeficits]),
    regimeScopeComplete: true as const,
    splitAssignmentComplete: true as const,
    calibrationSampleSufficient: sampleDeficits.length === 0,
    oosValidationComplete: false as const,
    calibrationArtifactProduced: false as const,
    partialFillCostPresent: false as const,
    naturalEntryCredit: 0 as const,
    runtimeCostCredit: 0 as const,
    partialFillStatus: 'BLOCKED_DATA' as const,
    fullCostReady: false as const,
    executionAuthority: 'NONE' as const,
    privateApiUsed: false as const,
    liveTrading: false as const,
    orderSubmitted: false as const,
  });
  const audit = Object.freeze({
    ...baseManifest,
    auditDigest: digest(baseManifest),
  }) satisfies PublicForwardPartialFillSplitAuditManifest;

  return Object.freeze({
    status: 'PRESENT',
    blockers: Object.freeze([]),
    audit,
  });
}
