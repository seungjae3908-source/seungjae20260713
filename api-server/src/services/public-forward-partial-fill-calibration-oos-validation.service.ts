import { createHash } from 'node:crypto';

import type {
  PublicForwardPartialFillSplitAssignment,
  PublicForwardPartialFillSplitAuditManifest,
} from './public-forward-partial-fill-calibration-split-audit.service';

export const PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_VERSION =
  'public-forward-partial-fill-calibration-oos-validation-v1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_SAFETY = Object.freeze({
  heldOutScoredOutcomeRequired: true,
  contaminationFreeRequired: true,
  publicForwardSimulationRequired: true,
  hypotheticalOrderFrozenBeforeEventRequired: true,
  actualFillClaimAllowed: false,
  queuePositionClaimAllowed: false,
  publicL2AloneMayProducePartialFillCost: false,
  historicalBackfillCreditAllowed: false,
  testFixtureRuntimeCreditAllowed: false,
  partialFillCostProduced: false,
  calibrationArtifactProduced: false,
  naturalEntryCredit: 0,
  runtimeCostCredit: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
  fullCostReady: false,
});

export type PublicForwardPartialFillOosMethodology = Readonly<{
  methodologyIdentity: string;
  methodologyDigest: string;
  methodologyFrozenAtMs: number;
}>;

export type PublicForwardPartialFillOosOutcome = Readonly<{
  outcomeId: string;
  observationId: string;
  sourceObservationLineageDigest: string;
  splitAuditDigest: string;
  datasetDigest: string;
  splitPolicyDigest: string;
  scopeKey: string;
  eventStartMs: number;
  scoredAtMs: number;
  hypotheticalOrderIdentity: string;
  hypotheticalOrderFrozenAtMs: number;
  sourceType: 'PUBLIC_FORWARD_SIMULATION';
  outcomeSourceIdentity: string;
  outcomeSourceDigest: string;
  outcomeProducerCodeSha: string;
  methodologyIdentity: string;
  methodologyDigest: string;
  methodologyFrozenAtMs: number;
  heldOut: boolean;
  contaminationFree: boolean;
  actualFillObserved: false;
  queuePositionKnown: false;
  partialFillCostPercent: null;
  historicalBackfillCredit: 0;
  testFixtureCredit: 0;
  naturalEntryCredit: 0;
  runtimeCostCredit: 0;
}>;

export type PublicForwardPartialFillOosValidationManifest = Readonly<{
  schemaVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_VERSION;
  splitAuditDigest: string;
  datasetIdentity: string;
  datasetDigest: string;
  splitPolicyIdentity: string;
  splitPolicyDigest: string;
  methodologyIdentity: string;
  methodologyDigest: string;
  methodologyFrozenAtMs: number;
  outcomeProducerCodeSha: string;
  oosAssignmentCount: number;
  scoredOutcomeCount: number;
  outcomeIds: readonly string[];
  outcomeDigest: string;
  validationDigest: string;
  exactOosCoverage: true;
  heldOut: true;
  contaminationFree: true;
  actualFillObserved: false;
  queuePositionKnown: false;
  oosValidationComplete: true;
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

export type PublicForwardPartialFillOosValidationResult = Readonly<{
  status: 'PRESENT' | 'BLOCKED_DATA';
  blockers: readonly string[];
  validation: PublicForwardPartialFillOosValidationManifest | null;
}>;

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

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

function nonEmpty(value: unknown): boolean {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 && normalized.length <= 240;
}

function exactDigest(value: unknown): boolean {
  return SHA256.test(String(value ?? '').trim().toLowerCase());
}

function exactCommitSha(value: unknown): boolean {
  return COMMIT_SHA.test(String(value ?? '').trim().toLowerCase());
}

function finitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function blocked(...codes: string[]): PublicForwardPartialFillOosValidationResult {
  return Object.freeze({
    status: 'BLOCKED_DATA',
    blockers: Object.freeze([...new Set(codes)]),
    validation: null,
  });
}

function validateAudit(audit: PublicForwardPartialFillSplitAuditManifest): string[] {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };
  if (!exactDigest(audit.auditDigest)) add('SPLIT_AUDIT_DIGEST_INVALID');
  if (!exactDigest(audit.datasetDigest)) add('DATASET_DIGEST_INVALID');
  if (!exactDigest(audit.splitPolicyDigest)) add('SPLIT_POLICY_DIGEST_INVALID');
  if (!nonEmpty(audit.datasetIdentity)) add('DATASET_IDENTITY_INVALID');
  if (!nonEmpty(audit.splitPolicyIdentity)) add('SPLIT_POLICY_IDENTITY_INVALID');
  if (audit.regimeScopeComplete !== true) add('REGIME_SCOPE_INCOMPLETE');
  if (audit.splitAssignmentComplete !== true) add('SPLIT_ASSIGNMENT_INCOMPLETE');
  if (audit.calibrationSampleSufficient !== true) add('CALIBRATION_SAMPLE_INSUFFICIENT');
  if (audit.oosValidationComplete !== false) add('UPSTREAM_OOS_VALIDATION_STATE_INVALID');
  if (audit.calibrationArtifactProduced !== false || audit.partialFillCostPresent !== false) add('UPSTREAM_COST_BOUNDARY_INVALID');
  if (audit.naturalEntryCredit !== 0 || audit.runtimeCostCredit !== 0) add('UPSTREAM_RUNTIME_CREDIT_INVALID');
  if (audit.fullCostReady !== false || audit.partialFillStatus !== 'BLOCKED_DATA') add('UPSTREAM_FULL_COST_BOUNDARY_INVALID');
  if (audit.executionAuthority !== 'NONE' || audit.privateApiUsed !== false || audit.liveTrading !== false || audit.orderSubmitted !== false) {
    add('UPSTREAM_EXECUTION_SAFETY_INVALID');
  }
  return blockers;
}

function validateMethodology(methodology: PublicForwardPartialFillOosMethodology): string[] {
  const blockers: string[] = [];
  if (!nonEmpty(methodology.methodologyIdentity)) blockers.push('OOS_METHODOLOGY_IDENTITY_INVALID');
  if (!exactDigest(methodology.methodologyDigest)) blockers.push('OOS_METHODOLOGY_DIGEST_INVALID');
  if (!finitePositive(methodology.methodologyFrozenAtMs)) blockers.push('OOS_METHODOLOGY_FROZEN_AT_INVALID');
  return blockers;
}

function validateOutcome(
  outcome: PublicForwardPartialFillOosOutcome,
  assignment: PublicForwardPartialFillSplitAssignment,
  audit: PublicForwardPartialFillSplitAuditManifest,
  methodology: PublicForwardPartialFillOosMethodology,
  expectedOutcomeProducerCodeSha: string,
): string[] {
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  if (!nonEmpty(outcome.outcomeId)) add('OOS_OUTCOME_ID_INVALID');
  if (outcome.observationId !== assignment.observationId) add('OOS_OBSERVATION_ID_MISMATCH');
  if (outcome.sourceObservationLineageDigest !== assignment.sourceObservationLineageDigest) add('OOS_LINEAGE_DIGEST_MISMATCH');
  if (outcome.splitAuditDigest !== audit.auditDigest) add('OOS_SPLIT_AUDIT_DIGEST_MISMATCH');
  if (outcome.datasetDigest !== audit.datasetDigest) add('OOS_DATASET_DIGEST_MISMATCH');
  if (outcome.splitPolicyDigest !== audit.splitPolicyDigest) add('OOS_SPLIT_POLICY_DIGEST_MISMATCH');
  if (outcome.scopeKey !== assignment.scopeKey) add('OOS_SCOPE_KEY_MISMATCH');
  if (outcome.eventStartMs !== assignment.eventStartMs) add('OOS_EVENT_START_MISMATCH');
  if (!finitePositive(outcome.scoredAtMs) || outcome.scoredAtMs < assignment.observedAtMs) add('OOS_SCORED_AT_INVALID');
  if (!nonEmpty(outcome.hypotheticalOrderIdentity)) add('OOS_HYPOTHETICAL_ORDER_IDENTITY_INVALID');
  if (!finitePositive(outcome.hypotheticalOrderFrozenAtMs) || outcome.hypotheticalOrderFrozenAtMs > assignment.eventStartMs) {
    add('OOS_HYPOTHETICAL_ORDER_NOT_FROZEN_BEFORE_EVENT');
  }
  if (outcome.sourceType !== 'PUBLIC_FORWARD_SIMULATION') add('OOS_SOURCE_TYPE_INVALID');
  if (!nonEmpty(outcome.outcomeSourceIdentity)) add('OOS_SOURCE_IDENTITY_INVALID');
  if (!exactDigest(outcome.outcomeSourceDigest)) add('OOS_SOURCE_DIGEST_INVALID');
  if (outcome.outcomeProducerCodeSha !== expectedOutcomeProducerCodeSha) add('OOS_PRODUCER_SHA_MISMATCH');
  if (outcome.methodologyIdentity !== methodology.methodologyIdentity) add('OOS_METHODOLOGY_IDENTITY_MISMATCH');
  if (outcome.methodologyDigest !== methodology.methodologyDigest) add('OOS_METHODOLOGY_DIGEST_MISMATCH');
  if (outcome.methodologyFrozenAtMs !== methodology.methodologyFrozenAtMs) add('OOS_METHODOLOGY_FROZEN_AT_MISMATCH');
  if (methodology.methodologyFrozenAtMs > assignment.eventStartMs) add('OOS_METHODOLOGY_NOT_FROZEN_BEFORE_EVENT');
  if (outcome.heldOut !== true) add('OOS_OUTCOME_NOT_HELD_OUT');
  if (outcome.contaminationFree !== true) add('OOS_OUTCOME_CONTAMINATED');
  if (outcome.actualFillObserved !== false) add('OOS_ACTUAL_FILL_CLAIM_FORBIDDEN');
  if (outcome.queuePositionKnown !== false) add('OOS_QUEUE_POSITION_CLAIM_FORBIDDEN');
  if (outcome.partialFillCostPercent !== null) add('OOS_PARTIAL_FILL_COST_FORBIDDEN');
  if (outcome.historicalBackfillCredit !== 0 || outcome.testFixtureCredit !== 0) add('OOS_NON_FORWARD_CREDIT_FORBIDDEN');
  if (outcome.naturalEntryCredit !== 0 || outcome.runtimeCostCredit !== 0) add('OOS_RUNTIME_CREDIT_FORBIDDEN');
  return blockers;
}

export function validatePublicForwardPartialFillOosOutcomes(input: Readonly<{
  audit: PublicForwardPartialFillSplitAuditManifest;
  outcomes: readonly PublicForwardPartialFillOosOutcome[];
  methodology: PublicForwardPartialFillOosMethodology;
  expectedOutcomeProducerCodeSha: string;
}>): PublicForwardPartialFillOosValidationResult {
  const auditBlockers = validateAudit(input.audit);
  if (auditBlockers.length > 0) return blocked(...auditBlockers);
  const methodologyBlockers = validateMethodology(input.methodology);
  if (methodologyBlockers.length > 0) return blocked(...methodologyBlockers);
  if (!exactCommitSha(input.expectedOutcomeProducerCodeSha)) return blocked('OOS_PRODUCER_SHA_INVALID');

  const oosAssignments = input.audit.assignments.filter((assignment) => assignment.split === 'OOS');
  if (oosAssignments.length === 0) return blocked('OOS_ASSIGNMENTS_MISSING');
  if (input.outcomes.length === 0) return blocked('OOS_SCORED_OUTCOMES_MISSING');

  const assignmentsById = new Map(oosAssignments.map((assignment) => [assignment.observationId, assignment] as const));
  const outcomeIds = new Set<string>();
  const outcomeByObservationId = new Map<string, PublicForwardPartialFillOosOutcome>();
  const sourceDigests = new Set<string>();
  const blockers: string[] = [];
  const add = (code: string) => {
    if (!blockers.includes(code)) blockers.push(code);
  };

  for (const outcome of input.outcomes) {
    if (outcomeIds.has(outcome.outcomeId)) add('OOS_OUTCOME_ID_DUPLICATE');
    outcomeIds.add(outcome.outcomeId);
    if (outcomeByObservationId.has(outcome.observationId)) add('OOS_OUTCOME_DUPLICATE_OBSERVATION');
    outcomeByObservationId.set(outcome.observationId, outcome);
    if (sourceDigests.has(outcome.outcomeSourceDigest)) add('OOS_OUTCOME_SOURCE_DIGEST_REUSED');
    sourceDigests.add(outcome.outcomeSourceDigest);
    const assignment = assignmentsById.get(outcome.observationId);
    if (!assignment) {
      add('OOS_OUTCOME_ORPHAN');
      continue;
    }
    validateOutcome(outcome, assignment, input.audit, input.methodology, input.expectedOutcomeProducerCodeSha).forEach(add);
  }

  for (const assignment of oosAssignments) {
    if (!outcomeByObservationId.has(assignment.observationId)) add('OOS_SCORED_OUTCOME_MISSING');
  }
  if (input.outcomes.length !== oosAssignments.length) add('OOS_EXACT_COVERAGE_MISMATCH');
  if (blockers.length > 0) return blocked(...blockers);

  const orderedOutcomes = [...input.outcomes].sort((left, right) => left.observationId.localeCompare(right.observationId));
  const outcomeDigest = digest(orderedOutcomes);
  const manifestWithoutDigest = {
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_OOS_VALIDATION_VERSION,
    splitAuditDigest: input.audit.auditDigest,
    datasetIdentity: input.audit.datasetIdentity,
    datasetDigest: input.audit.datasetDigest,
    splitPolicyIdentity: input.audit.splitPolicyIdentity,
    splitPolicyDigest: input.audit.splitPolicyDigest,
    methodologyIdentity: input.methodology.methodologyIdentity,
    methodologyDigest: input.methodology.methodologyDigest,
    methodologyFrozenAtMs: input.methodology.methodologyFrozenAtMs,
    outcomeProducerCodeSha: input.expectedOutcomeProducerCodeSha,
    oosAssignmentCount: oosAssignments.length,
    scoredOutcomeCount: orderedOutcomes.length,
    outcomeIds: Object.freeze(orderedOutcomes.map((outcome) => outcome.outcomeId)),
    outcomeDigest,
    exactOosCoverage: true as const,
    heldOut: true as const,
    contaminationFree: true as const,
    actualFillObserved: false as const,
    queuePositionKnown: false as const,
    oosValidationComplete: true as const,
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
  };
  const validation: PublicForwardPartialFillOosValidationManifest = Object.freeze({
    ...manifestWithoutDigest,
    validationDigest: digest(manifestWithoutDigest),
  });
  return Object.freeze({ status: 'PRESENT', blockers: Object.freeze([]), validation });
}
