import { createHash } from 'node:crypto';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY,
  PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES,
} from './public-forward-partial-fill-v3-prospective-methodology.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_VERSION =
  'public-forward-partial-fill-v3-cohort-freeze-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY = Object.freeze({
  schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_VERSION,
  kind: 'IMMUTABLE_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT_FREEZE',
  canonicalHubIssue: 1102,
  approvalCommentId: 5804802177,
  timestampCommentId: 5804808369,
  sourceMainSha: '9aa01fb76a2ae30765a9da96c56e3799033ba615',
  cohortIdentity: 'PUBLIC_FORWARD_PARTIAL_FILL_V3_PROSPECTIVE_COHORT',
  cohortVersion: 'V3-FROZEN-1',
  cohortFrozenAtMs: 1790207015000,
  cohortFrozenAtUtc: '2026-09-23T23:43:35Z',
  cohortFrozenAtKst: '2026-09-24T08:43:35+09:00',
  effectiveStartMs: 1790263020000,
  effectiveStartUtc: '2026-09-24T15:17:00Z',
  effectiveStartKst: '2026-09-25T00:17:00+09:00',
  endExclusiveMs: 1793949420000,
  endExclusiveUtc: '2026-11-06T07:17:00Z',
  endExclusiveKst: '2026-11-06T16:17:00+09:00',
  slotCadenceMs: 3_600_000,
  cronMinute: 17,
  totalSlotN: 1024,
  splits: Object.freeze({
    TRAIN: Object.freeze({
      startIndexInclusive: 0,
      endIndexInclusive: 511,
      slotN: 512,
      startInclusiveMs: 1790263020000,
      endExclusiveMs: 1792106220000,
    }),
    VALIDATION: Object.freeze({
      startIndexInclusive: 512,
      endIndexInclusive: 767,
      slotN: 256,
      startInclusiveMs: 1792106220000,
      endExclusiveMs: 1793027820000,
    }),
    OOS: Object.freeze({
      startIndexInclusive: 768,
      endIndexInclusive: 1023,
      slotN: 256,
      startInclusiveMs: 1793027820000,
      endExclusiveMs: 1793949420000,
    }),
  }),
  inheritedV2Authority: Object.freeze({
    policyDigest: PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.policyDigest,
    cohortDigest: PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.cohortDigest,
    perScopeEffectiveIndependentMinimum:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.perScopeEffectiveIndependentMinimum,
    scopeCellCount: PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.scopeCellCount,
    mechanicalFloorEffectiveIndependent:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.mechanicalFloorEffectiveIndependent,
  }),
  frozenComponentDigests: Object.freeze({
    businessTolerance:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.businessTolerance.digest,
    statisticalMethodology:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.statisticalMethodology.digest,
    scopeUniverse:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.scopeUniverse.digest,
    numericMinimumArtifact:
      PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.numericMinimumArtifact.digest,
  }),
  modeledEvidenceAuthority: 'RESEARCH_ONLY_NON_ECONOMIC',
  actualExecutionTruth: 'UNKNOWN_UNTIL_OBSERVED',
  modeledEvidenceMayBecomeActualEvidence: false,
  replayCredit: 0,
  backfillCredit: 0,
  manualCredit: 0,
  syntheticCredit: 0,
  hindsightCredit: 0,
  economicCreditCreated: false,
  profitabilityCredit: 0,
  fullCostReady: false,
  evidenceComplete: 0,
  profitabilityProven: false,
  scheduleTrigger: 'NONE',
  scheduleActivationApproved: false,
  captureApproved: false,
  workflowDispatchApproved: false,
  stagingDeployApproved: false,
  productionDeployApproved: false,
  dbSecretEnvServerMutationApproved: false,
  executionAuthority: 'NONE',
  privateTradingApiAllowed: false,
  liveTrading: false,
  autoTrading: false,
  realOrderEnabled: false,
  replitAllowed: false,
} as const);

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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export const PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_DIGEST =
  digest(PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY);

export type PublicForwardPartialFillV3CohortSplit = 'TRAIN' | 'VALIDATION' | 'OOS';

export function verifyPublicForwardPartialFillV3CohortFreeze(
  candidate: unknown = PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY,
): Readonly<{ valid: boolean; blockers: readonly string[]; digest: string | null }> {
  const blockers: string[] = [];
  const row = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, any>
    : null;
  if (!row) return Object.freeze({ valid: false, blockers: Object.freeze(['V3_COHORT_FREEZE_REQUIRED']), digest: null });

  if (row.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_VERSION) blockers.push('V3_COHORT_FREEZE_SCHEMA_INVALID');
  if (row.kind !== 'IMMUTABLE_PUBLIC_ONLY_PARTIAL_FILL_V3_COHORT_FREEZE') blockers.push('V3_COHORT_FREEZE_KIND_INVALID');
  if (row.approvalCommentId !== 5804802177 || row.timestampCommentId !== 5804808369) blockers.push('V3_COHORT_FREEZE_AUTHORITY_MISMATCH');
  if (row.sourceMainSha !== '9aa01fb76a2ae30765a9da96c56e3799033ba615') blockers.push('V3_COHORT_FREEZE_SOURCE_MAIN_MISMATCH');
  if (row.cohortFrozenAtMs !== 1790207015000) blockers.push('V3_COHORT_FREEZE_TIMESTAMP_MISMATCH');
  if (row.effectiveStartMs !== 1790263020000 || row.effectiveStartMs <= row.cohortFrozenAtMs) blockers.push('V3_COHORT_NOT_STRICTLY_PROSPECTIVE');
  if (row.endExclusiveMs !== row.effectiveStartMs + 1024 * 3_600_000) blockers.push('V3_COHORT_WINDOW_INVALID');
  if (row.slotCadenceMs !== 3_600_000 || row.cronMinute !== 17 || row.totalSlotN !== 1024) blockers.push('V3_COHORT_CADENCE_OR_CAPACITY_INVALID');

  const splits = row.splits;
  if (!splits
    || splits.TRAIN?.startIndexInclusive !== 0
    || splits.TRAIN?.endIndexInclusive !== 511
    || splits.TRAIN?.slotN !== 512
    || splits.VALIDATION?.startIndexInclusive !== 512
    || splits.VALIDATION?.endIndexInclusive !== 767
    || splits.VALIDATION?.slotN !== 256
    || splits.OOS?.startIndexInclusive !== 768
    || splits.OOS?.endIndexInclusive !== 1023
    || splits.OOS?.slotN !== 256
    || splits.TRAIN?.startInclusiveMs !== row.effectiveStartMs
    || splits.TRAIN?.endExclusiveMs !== row.effectiveStartMs + 512 * row.slotCadenceMs
    || splits.VALIDATION?.startInclusiveMs !== splits.TRAIN?.endExclusiveMs
    || splits.VALIDATION?.endExclusiveMs !== row.effectiveStartMs + 768 * row.slotCadenceMs
    || splits.OOS?.startInclusiveMs !== splits.VALIDATION?.endExclusiveMs
    || splits.OOS?.endExclusiveMs !== row.effectiveStartMs + 1024 * row.slotCadenceMs
    || splits.OOS?.endExclusiveMs !== row.endExclusiveMs) {
    blockers.push('V3_COHORT_SPLITS_INVALID');
  }

  const inherited = row.inheritedV2Authority;
  if (!inherited
    || inherited.policyDigest !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.policyDigest
    || inherited.cohortDigest !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_CAPACITY_AUTHORITY.cohortDigest
    || inherited.perScopeEffectiveIndependentMinimum !== 178
    || inherited.scopeCellCount !== 4
    || inherited.mechanicalFloorEffectiveIndependent !== 712) {
    blockers.push('V3_COHORT_V2_AUTHORITY_DRIFT');
  }

  const components = row.frozenComponentDigests;
  if (!components
    || components.businessTolerance !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.businessTolerance.digest
    || components.statisticalMethodology !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.statisticalMethodology.digest
    || components.scopeUniverse !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.scopeUniverse.digest
    || components.numericMinimumArtifact !== PUBLIC_FORWARD_PARTIAL_FILL_V2_FROZEN_COMPONENT_AUTHORITIES.numericMinimumArtifact.digest) {
    blockers.push('V3_COHORT_COMPONENT_AUTHORITY_DRIFT');
  }

  if (row.modeledEvidenceAuthority !== 'RESEARCH_ONLY_NON_ECONOMIC'
    || row.actualExecutionTruth !== 'UNKNOWN_UNTIL_OBSERVED'
    || row.modeledEvidenceMayBecomeActualEvidence !== false) {
    blockers.push('V3_COHORT_EVIDENCE_CLASSIFICATION_INVALID');
  }

  if (row.replayCredit !== 0 || row.backfillCredit !== 0 || row.manualCredit !== 0
    || row.syntheticCredit !== 0 || row.hindsightCredit !== 0
    || row.economicCreditCreated !== false || row.profitabilityCredit !== 0
    || row.fullCostReady !== false || row.evidenceComplete !== 0 || row.profitabilityProven !== false) {
    blockers.push('V3_COHORT_ECONOMIC_CREDIT_FORBIDDEN');
  }

  if (row.scheduleTrigger !== 'NONE'
    || row.scheduleActivationApproved !== false
    || row.captureApproved !== false
    || row.workflowDispatchApproved !== false
    || row.stagingDeployApproved !== false
    || row.productionDeployApproved !== false
    || row.dbSecretEnvServerMutationApproved !== false) {
    blockers.push('V3_COHORT_ACTIVATION_AUTHORITY_FORBIDDEN');
  }

  if (row.executionAuthority !== 'NONE'
    || row.privateTradingApiAllowed !== false
    || row.liveTrading !== false
    || row.autoTrading !== false
    || row.realOrderEnabled !== false
    || row.replitAllowed !== false) {
    blockers.push('V3_COHORT_SAFETY_BOUNDARY_INVALID');
  }

  let computed: string | null = null;
  try { computed = digest(row); } catch { blockers.push('V3_COHORT_DIGEST_UNVERIFIABLE'); }
  return Object.freeze({
    valid: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    digest: computed,
  });
}

export function describePublicForwardPartialFillV3Slot(slotIndex: number): Readonly<{
  slotIndex: number;
  split: PublicForwardPartialFillV3CohortSplit;
  nominalScheduledAtMs: number;
  slotEndExclusiveMs: number;
  prospectiveCreditAuthority: 0;
}> {
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= 1024) {
    throw new Error('V3_COHORT_SLOT_INDEX_INVALID');
  }
  const split: PublicForwardPartialFillV3CohortSplit =
    slotIndex < 512 ? 'TRAIN' : slotIndex < 768 ? 'VALIDATION' : 'OOS';
  const nominalScheduledAtMs =
    PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY.effectiveStartMs
    + slotIndex * PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY.slotCadenceMs;
  return Object.freeze({
    slotIndex,
    split,
    nominalScheduledAtMs,
    slotEndExclusiveMs:
      nominalScheduledAtMs + PUBLIC_FORWARD_PARTIAL_FILL_V3_COHORT_FREEZE_AUTHORITY.slotCadenceMs,
    prospectiveCreditAuthority: 0 as const,
  });
}
