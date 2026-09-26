import { createHash } from 'node:crypto';

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION =
  'public-forward-partial-fill-business-tolerance-decision-evidence-v2' as const;

// The evidence-version constant is the single code-owned schema authority.
// This alias exists for readability only and must never diverge from evidenceVersion.
export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_SCHEMA_VERSION =
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION;

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY =
  'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION = 'V1' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_GOVERNANCE_MODELS = Object.freeze([
  'INDEPENDENT_MULTI_APPROVER',
  'SOLE_OWNER_SELF_APPROVAL',
] as const);

export type PublicForwardPartialFillBusinessToleranceGovernanceModel =
  (typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_GOVERNANCE_MODELS)[number];

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY = Object.freeze({
  designEvidenceOnly: true,
  numericDefaultsAllowed: false,
  aiNumericAuthority: 'NONE' as const,
  humanApprovalRequired: true,
  governanceModelRequired: true,
  soleOwnerSelfApprovalSupported: true,
  independentMultiApproverSupported: true,
  singleApproverSelfAuthorizationAllowed: true,
  singleApproverSelfAuthorizationRequiresExplicitSoleOwnerGovernance: true,
  profitabilityOutcomeConsultedAllowed: false,
  currentSampleUsedToSelectValuesAllowed: false,
  currentPassFailConsultedAllowed: false,
  prospectiveOnlyRequired: true,
  frozenArtifactProduced: false,
  statisticalNumericizationAllowed: false,
  productionPolicyAuthorityConnected: false,
  partialFillCostProduced: false,
  fullCostReady: false,
  evidenceComplete: 0,
  executionAuthority: 'NONE' as const,
  privateApiAllowed: false,
  liveTrading: false,
  orderSubmissionAllowed: false,
});

export const PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS = Object.freeze([
  'TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE',
  'TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE',
  'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE',
  'TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE',
  'TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE',
  'TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE',
  'TOL07_INTERVAL_COVERAGE_REQUIREMENT',
  'TOL08_SETTLEMENT_MATERIALITY_LIMIT',
  'TOL09_CALIBRATION_FRESHNESS_LIMIT',
] as const);

export type PublicForwardPartialFillToleranceKey =
  (typeof PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS)[number];

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS = Object.freeze([
  ...PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS,
  'TAIL_QUANTILE',
  'MEANINGFUL_FAILURE_EFFECT_SIZE',
] as const);

export type PublicForwardPartialFillBusinessToleranceDecisionKey =
  (typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS)[number];

export interface PublicForwardPartialFillBusinessToleranceDecisionDefinition {
  readonly decisionIdentity: PublicForwardPartialFillBusinessToleranceDecisionKey;
  readonly unit: string;
  readonly metricIdentity?: string;
  readonly interpretation?: string;
  readonly signConvention?: string;
  readonly adverseDirection?: string;
  readonly adverseTailDirection?: string;
  readonly intervalType?: string;
  readonly comparisonBasis?: string;
  readonly ageReference?: string;
  readonly application?: string;
}

function freezeDefinition<T extends PublicForwardPartialFillBusinessToleranceDecisionDefinition>(definition: T): T {
  return Object.freeze(definition);
}

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS = Object.freeze({
  TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE',
    metricIdentity: 'MEAN_ABSOLUTE_CALIBRATION_ERROR',
    unit: 'percentage_points',
  }),
  TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE',
    metricIdentity: 'MEAN_ABSOLUTE_FILL_RATIO_ERROR',
    unit: 'percentage_points',
  }),
  TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE',
    metricIdentity: 'MEAN_SIGNED_FILL_RATIO_ERROR',
    interpretation: 'tolerance_magnitude',
    signConvention: 'predicted_fill_ratio_minus_actual_fill_ratio',
    unit: 'percentage_points',
  }),
  TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE',
    metricIdentity: 'MEAN_ABSOLUTE_ALL_IN_COST_ERROR',
    unit: 'basis_points_of_notional',
  }),
  TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE',
    metricIdentity: 'MEAN_ADVERSE_COST_UNDERESTIMATION',
    signConvention: 'actual_cost_minus_predicted_cost_positive_is_underestimation',
    unit: 'basis_points_of_notional',
  }),
  TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE: freezeDefinition({
    decisionIdentity: 'TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE',
    metricIdentity: 'ADVERSE_TAIL_COST_UNDERESTIMATION',
    adverseDirection: 'actual_all_in_cost_greater_than_predicted_all_in_cost',
    unit: 'basis_points_of_notional',
  }),
  TOL07_INTERVAL_COVERAGE_REQUIREMENT: freezeDefinition({
    decisionIdentity: 'TOL07_INTERVAL_COVERAGE_REQUIREMENT',
    metricIdentity: 'EMPIRICAL_PREDICTION_INTERVAL_COVERAGE',
    intervalType: 'NOMINAL_95_PERCENT_PREDICTION_INTERVAL',
    unit: 'percent',
  }),
  TOL08_SETTLEMENT_MATERIALITY_LIMIT: freezeDefinition({
    decisionIdentity: 'TOL08_SETTLEMENT_MATERIALITY_LIMIT',
    metricIdentity: 'ABSOLUTE_SETTLEMENT_RECONCILIATION_DIFFERENCE',
    comparisonBasis: 'AUTHORITATIVE_SETTLEMENT_AFTER_DETERMINISTIC_FEE_TICK_AND_CURRENCY_ROUNDING',
    unit: 'basis_point_of_settlement_notional',
  }),
  TOL09_CALIBRATION_FRESHNESS_LIMIT: freezeDefinition({
    decisionIdentity: 'TOL09_CALIBRATION_FRESHNESS_LIMIT',
    metricIdentity: 'AGE_SINCE_LAST_AUTHORITATIVE_CALIBRATION',
    ageReference: 'AUTHORITATIVE_CALIBRATION_FREEZE_TIMESTAMP',
    unit: 'calendar_days',
  }),
  TAIL_QUANTILE: freezeDefinition({
    decisionIdentity: 'TAIL_QUANTILE',
    adverseTailDirection: 'HIGHER_ALL_IN_EXECUTION_COST_AND_WORSE_FILL_QUALITY',
    unit: 'quantile_fraction',
  }),
  MEANINGFUL_FAILURE_EFFECT_SIZE: freezeDefinition({
    decisionIdentity: 'MEANINGFUL_FAILURE_EFFECT_SIZE',
    application: 'statistical_power_and_minimum_effect_detection_for_primary_calibration_gates',
    unit: 'standardized_effect_size',
  }),
} satisfies Readonly<Record<PublicForwardPartialFillBusinessToleranceDecisionKey, PublicForwardPartialFillBusinessToleranceDecisionDefinition>>);

export type PublicForwardPartialFillBusinessToleranceDecisionSemantics =
  typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS;

export interface HumanNumericDecision {
  value: number | null;
  unit: string | null;
}

export interface PublicForwardPartialFillBusinessToleranceHumanInput {
  tolerances: Record<PublicForwardPartialFillToleranceKey, HumanNumericDecision>;
  tailQuantile: HumanNumericDecision;
  meaningfulFailureEffectSize: HumanNumericDecision;
  governanceModel?: PublicForwardPartialFillBusinessToleranceGovernanceModel | string | null;
  ownerIdentity?: string | null;
  releaseApprover: string | null;
  riskApprover: string | null;
  settlementReviewer: string | null;
  soleOwnerSelfApproval?: boolean | null;
  independentReview?: boolean | null;
  independentReviewRequired?: boolean | null;
  humanFinalAuthority?: boolean | null;
  decisionBasisReference: string | null;
  approvalTimestamp: string | null;
  declarations: {
    profitabilityOutcomeConsulted: boolean;
    currentN1UsedToSelectValues: boolean;
    currentPassFailConsulted: boolean;
    aiNumericAuthority: 'NONE' | string;
    prospectiveOnly: boolean;
    executionAuthority: 'NONE' | string;
  };
}

export interface PublicForwardPartialFillBusinessToleranceDecisionContext {
  // Assertion-only input. The builder always writes the code-owned canonical schema identity.
  schemaVersion: string | null;
  businessToleranceIdentity: typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY;
  // Assertion-only input. The builder always writes the code-owned canonical policy version.
  businessToleranceVersion: string;
  scopeUniverseIdentity: string;
  scopeUniverseDigest: string;
  consumerIdentity: string;
  riskMethodologyIdentity: string;
  riskMethodologyDigest: string;
  effectiveCohortStartMs: number;
}

export interface PublicForwardPartialFillBusinessToleranceDecisionEvidence {
  evidenceVersion: typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION;
  context: PublicForwardPartialFillBusinessToleranceDecisionContext;
  decisionSemantics: PublicForwardPartialFillBusinessToleranceDecisionSemantics;
  humanInput: PublicForwardPartialFillBusinessToleranceHumanInput;
  validationStatus: 'COMPLETE_AWAITING_FREEZE' | 'INCOMPLETE';
  firstZero: null | 'BUSINESS_TOLERANCE_VALUES_NOT_APPROVED' | 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED';
  rootCauseClass: null | 'HUMAN_RISK_NUMERIC_DECISION_MISSING' | 'HUMAN_GOVERNANCE_DECISION_INVALID';
  validationErrors: readonly string[];
  numericValuesFrozen: false;
  frozenBusinessToleranceArtifactProduced: false;
  statisticalNumericizationAllowed: false;
  productionAuthority: false;
  policyFrozen: false;
  statisticalNumericizationStarted: false;
  executionAuthority: 'NONE';
  liveTrading: false;
  digest: string;
}

const GOVERNANCE_ERROR_CODES = new Set([
  'GOVERNANCE_MODEL_REQUIRED',
  'GOVERNANCE_MODEL_INVALID',
  'OWNER_IDENTITY_REQUIRED',
  'SOLE_OWNER_ATTESTATION_REQUIRED',
  'SOLE_OWNER_APPROVER_IDENTITY_MISMATCH',
  'SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION',
  'MULTI_APPROVER_DISTINCTNESS_REQUIRED',
  'GOVERNANCE_MODEL_CONTRADICTION',
  'HUMAN_FINAL_AUTHORITY_REQUIRED',
  'PLACEHOLDER_APPROVER_FORBIDDEN',
  'SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN',
]);

const FORBIDDEN_EXACT_IDENTITY_TOKENS = new Set([
  'PLACEHOLDER',
  'TBD',
  'TODO',
  'UNKNOWN',
  'UNSET',
  'NONE',
  'N/A',
  'NA',
  'TEST',
  'TEST_USER',
  'TESTUSER',
  'DUMMY',
  'DUMMY_USER',
  'SAMPLE',
  'SAMPLE_USER',
  'EXAMPLE',
  'EXAMPLE_USER',
]);

const KNOWN_INVALID_HUMAN_IDENTITIES = new Set(['이승재1', '이승재2']);
const DECISION_BASIS_REFERENCE_PATTERN =
  /^https:\/\/github\.com\/seungjae3908-source\/seungjae20260713\/issues\/\d+#issuecomment-\d+$/;

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new Error(`${field}_MISSING`);
}

function assertDigest(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_INVALID`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function identityComparisonKey(value: string | null | undefined): string | null {
  const normalized = normalizeIdentity(value);
  return normalized ? normalized.replace(/\s+/g, ' ').toLowerCase() : null;
}

function normalizedIdentityToken(value: string): string {
  return value.toUpperCase().replace(/[\s-]+/g, '_');
}

function isForbiddenHumanIdentity(value: string | null | undefined): boolean {
  const normalized = normalizeIdentity(value);
  if (!normalized) return false;
  if (KNOWN_INVALID_HUMAN_IDENTITIES.has(normalized)) return true;
  if (/^(?:<[^<>]+>|\{[^{}]+\}|\$\{[^{}]+\})$/.test(normalized)) return true;

  const token = normalizedIdentityToken(normalized);
  if (FORBIDDEN_EXACT_IDENTITY_TOKENS.has(token)) return true;

  return /^(?:AI|BOT|CHATGPT|OPENAI|ASSISTANT|SYSTEM|AUTOMATION)(?:_.+)?$/i.test(token)
    || /^(?:COMMAND(?:_?\d+)?|PENDING(?:_.+)?)$/i.test(token);
}

function pushUnique(errors: string[], error: string): void {
  if (!errors.includes(error)) errors.push(error);
}

function validateHumanIdentity(value: string | null | undefined, missingError: string, errors: string[]): void {
  if (!normalizeIdentity(value)) {
    pushUnique(errors, missingError);
    return;
  }
  if (isForbiddenHumanIdentity(value)) pushUnique(errors, 'PLACEHOLDER_APPROVER_FORBIDDEN');
}

function validateGovernance(
  input: PublicForwardPartialFillBusinessToleranceHumanInput,
  errors: string[],
): void {
  const governanceModel = input.governanceModel?.trim();
  if (!governanceModel) {
    pushUnique(errors, 'GOVERNANCE_MODEL_REQUIRED');
    return;
  }
  if (!PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_GOVERNANCE_MODELS.includes(
    governanceModel as PublicForwardPartialFillBusinessToleranceGovernanceModel,
  )) {
    pushUnique(errors, 'GOVERNANCE_MODEL_INVALID');
    return;
  }

  validateHumanIdentity(input.ownerIdentity, 'OWNER_IDENTITY_REQUIRED', errors);
  if (input.humanFinalAuthority !== true) pushUnique(errors, 'HUMAN_FINAL_AUTHORITY_REQUIRED');

  const ownerIdentity = identityComparisonKey(input.ownerIdentity);
  const releaseApprover = identityComparisonKey(input.releaseApprover);
  const riskApprover = identityComparisonKey(input.riskApprover);
  const settlementReviewer = identityComparisonKey(input.settlementReviewer);

  if (governanceModel === 'SOLE_OWNER_SELF_APPROVAL') {
    if (input.soleOwnerSelfApproval !== true) pushUnique(errors, 'SOLE_OWNER_ATTESTATION_REQUIRED');
    if (input.independentReview !== false || input.independentReviewRequired !== false) {
      pushUnique(errors, 'SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION');
    }
    if (ownerIdentity && releaseApprover && riskApprover && settlementReviewer
      && (releaseApprover !== ownerIdentity || riskApprover !== ownerIdentity || settlementReviewer !== ownerIdentity)) {
      pushUnique(errors, 'SOLE_OWNER_APPROVER_IDENTITY_MISMATCH');
    }
    return;
  }

  if (input.soleOwnerSelfApproval !== false
    || input.independentReview !== true
    || input.independentReviewRequired !== true) {
    pushUnique(errors, 'GOVERNANCE_MODEL_CONTRADICTION');
  }
  if (releaseApprover && riskApprover && releaseApprover === riskApprover) {
    pushUnique(errors, 'MULTI_APPROVER_DISTINCTNESS_REQUIRED');
    pushUnique(errors, 'SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN');
  }
}

function candidateDefinition(
  candidate: unknown,
  key: PublicForwardPartialFillBusinessToleranceDecisionKey,
): Record<string, unknown> | null {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = (candidate as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(
  candidate: unknown,
): readonly string[] {
  const errors: string[] = [];
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return Object.freeze(['BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING']);
  }

  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS) {
    const actual = candidateDefinition(candidate, key);
    const expected = PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS[key];
    if (!actual) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
      continue;
    }
    if (actual.decisionIdentity !== expected.decisionIdentity) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
    }
    if ('metricIdentity' in expected && actual.metricIdentity !== expected.metricIdentity) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_METRIC_BINDING_INVALID');
    }
    if (actual.unit !== expected.unit) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_UNIT_BINDING_INVALID');
    }
  }

  const tol03 = candidateDefinition(candidate, 'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE');
  if (tol03?.interpretation !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE.interpretation) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_SIGNED_BIAS_INTERPRETATION_INVALID');
  }
  if (tol03?.signConvention !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE.signConvention) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_SIGN_CONVENTION_INVALID');
  }

  const tol05 = candidateDefinition(candidate, 'TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE');
  if (tol05?.signConvention !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE.signConvention) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_SIGN_CONVENTION_INVALID');
  }

  const tol06 = candidateDefinition(candidate, 'TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE');
  if (tol06?.adverseDirection !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE.adverseDirection) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID');
  }

  const tail = candidateDefinition(candidate, 'TAIL_QUANTILE');
  if (tail?.adverseTailDirection !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TAIL_QUANTILE.adverseTailDirection) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID');
  }

  const tol07 = candidateDefinition(candidate, 'TOL07_INTERVAL_COVERAGE_REQUIREMENT');
  if (tol07?.intervalType !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL07_INTERVAL_COVERAGE_REQUIREMENT.intervalType) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_INTERVAL_TYPE_INVALID');
  }

  const tol08 = candidateDefinition(candidate, 'TOL08_SETTLEMENT_MATERIALITY_LIMIT');
  if (tol08?.comparisonBasis !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL08_SETTLEMENT_MATERIALITY_LIMIT.comparisonBasis) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_SETTLEMENT_COMPARISON_BASIS_INVALID');
  }

  const tol09 = candidateDefinition(candidate, 'TOL09_CALIBRATION_FRESHNESS_LIMIT');
  if (tol09?.ageReference !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL09_CALIBRATION_FRESHNESS_LIMIT.ageReference) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_CALIBRATION_AGE_REFERENCE_INVALID');
  }

  const effect = candidateDefinition(candidate, 'MEANINGFUL_FAILURE_EFFECT_SIZE');
  if (effect?.application !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.MEANINGFUL_FAILURE_EFFECT_SIZE.application) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_EFFECT_SIZE_APPLICATION_INVALID');
  }

  const candidateKeys = Object.keys(candidate as Record<string, unknown>).sort();
  const expectedKeys = [...PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS].sort();
  if (candidateKeys.length !== expectedKeys.length
    || candidateKeys.some((key, index) => key !== expectedKeys[index])) {
    pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
  }

  return Object.freeze(errors);
}

export function computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(
  evidence: Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'>,
): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(evidence))).digest('hex');
}

export function validatePublicForwardPartialFillBusinessToleranceHumanInput(
  input: PublicForwardPartialFillBusinessToleranceHumanInput,
): readonly string[] {
  const errors: string[] = [];
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS) {
    const decision = input.tolerances[key];
    if (!decision || decision.value === null || !Number.isFinite(decision.value)) {
      pushUnique(errors, `${key}_VALUE_MISSING_OR_INVALID`);
    }
    if (!decision?.unit?.trim()) {
      pushUnique(errors, `${key}_UNIT_MISSING`);
    } else if (decision.unit !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS[key].unit) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_UNIT_BINDING_INVALID');
      pushUnique(errors, `${key}_UNIT_BINDING_INVALID`);
    }
  }

  for (const [key, decision] of [
    ['TAIL_QUANTILE', input.tailQuantile],
    ['MEANINGFUL_FAILURE_EFFECT_SIZE', input.meaningfulFailureEffectSize],
  ] as const) {
    if (decision.value === null || !Number.isFinite(decision.value)) {
      pushUnique(errors, `${key}_VALUE_MISSING_OR_INVALID`);
    }
    if (!decision.unit?.trim()) {
      pushUnique(errors, `${key}_UNIT_MISSING`);
    } else if (decision.unit !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS[key].unit) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_UNIT_BINDING_INVALID');
      pushUnique(errors, `${key}_UNIT_BINDING_INVALID`);
    }
  }

  validateHumanIdentity(input.releaseApprover, 'RELEASE_APPROVER_MISSING', errors);
  validateHumanIdentity(input.riskApprover, 'RISK_APPROVER_MISSING', errors);
  validateHumanIdentity(input.settlementReviewer, 'SETTLEMENT_REVIEWER_MISSING', errors);
  validateGovernance(input, errors);

  if (!input.decisionBasisReference?.trim()) {
    pushUnique(errors, 'DECISION_BASIS_REFERENCE_MISSING');
  } else if (!DECISION_BASIS_REFERENCE_PATTERN.test(input.decisionBasisReference)) {
    pushUnique(errors, 'DECISION_BASIS_REFERENCE_INVALID');
  }
  if (!input.approvalTimestamp?.trim() || Number.isNaN(Date.parse(input.approvalTimestamp))) {
    pushUnique(errors, 'APPROVAL_TIMESTAMP_MISSING_OR_INVALID');
  }
  if (input.declarations.profitabilityOutcomeConsulted !== false) {
    pushUnique(errors, 'PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN');
  }
  if (input.declarations.currentN1UsedToSelectValues !== false) {
    pushUnique(errors, 'CURRENT_N1_VALUE_SELECTION_FORBIDDEN');
  }
  if (input.declarations.currentPassFailConsulted !== false) {
    pushUnique(errors, 'CURRENT_PASS_FAIL_CONSULTED_FORBIDDEN');
  }
  if (input.declarations.aiNumericAuthority !== 'NONE') pushUnique(errors, 'AI_NUMERIC_AUTHORITY_FORBIDDEN');
  if (input.declarations.prospectiveOnly !== true) pushUnique(errors, 'PROSPECTIVE_ONLY_REQUIRED');
  if (input.declarations.executionAuthority !== 'NONE') pushUnique(errors, 'EXECUTION_AUTHORITY_FORBIDDEN');
  return Object.freeze(errors);
}

export function buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(
  context: PublicForwardPartialFillBusinessToleranceDecisionContext,
  humanInput: PublicForwardPartialFillBusinessToleranceHumanInput,
): PublicForwardPartialFillBusinessToleranceDecisionEvidence {
  if (context.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION) {
    throw new Error('BUSINESS_TOLERANCE_EVIDENCE_SCHEMA_MISMATCH');
  }
  if (context.businessToleranceIdentity !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY) {
    throw new Error('BUSINESS_TOLERANCE_IDENTITY_MISMATCH');
  }
  if (context.businessToleranceVersion !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION) {
    throw new Error('BUSINESS_TOLERANCE_VERSION_MISMATCH');
  }
  for (const [field, value] of [
    ['SCOPE_UNIVERSE_IDENTITY', context.scopeUniverseIdentity],
    ['CONSUMER_IDENTITY', context.consumerIdentity],
    ['RISK_METHODOLOGY_IDENTITY', context.riskMethodologyIdentity],
  ] as const) assertNonEmpty(value, field);
  assertDigest(context.scopeUniverseDigest, 'SCOPE_UNIVERSE_DIGEST');
  assertDigest(context.riskMethodologyDigest, 'RISK_METHODOLOGY_DIGEST');
  if (!Number.isSafeInteger(context.effectiveCohortStartMs) || context.effectiveCohortStartMs <= 0) {
    throw new Error('EFFECTIVE_COHORT_START_INVALID');
  }

  const semanticErrors = validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(
    PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS,
  );
  if (semanticErrors.length > 0) {
    throw new Error('BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
  }

  const validationErrors = validatePublicForwardPartialFillBusinessToleranceHumanInput(humanInput);
  const complete = validationErrors.length === 0;
  const governanceInvalid = validationErrors.some((error) => GOVERNANCE_ERROR_CODES.has(error));
  const canonicalContext: PublicForwardPartialFillBusinessToleranceDecisionContext = {
    ...context,
    schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
    businessToleranceIdentity: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
    businessToleranceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION,
  };
  const body: Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'> = {
    evidenceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
    context: canonicalContext,
    decisionSemantics: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS,
    humanInput,
    validationStatus: complete ? 'COMPLETE_AWAITING_FREEZE' : 'INCOMPLETE',
    firstZero: complete
      ? null
      : governanceInvalid
        ? 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED'
        : 'BUSINESS_TOLERANCE_VALUES_NOT_APPROVED',
    rootCauseClass: complete
      ? null
      : governanceInvalid
        ? 'HUMAN_GOVERNANCE_DECISION_INVALID'
        : 'HUMAN_RISK_NUMERIC_DECISION_MISSING',
    validationErrors,
    numericValuesFrozen: false,
    frozenBusinessToleranceArtifactProduced: false,
    statisticalNumericizationAllowed: false,
    productionAuthority: false,
    policyFrozen: false,
    statisticalNumericizationStarted: false,
    executionAuthority: 'NONE',
    liveTrading: false,
  };
  return Object.freeze({ ...body, digest: computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(body) });
}
