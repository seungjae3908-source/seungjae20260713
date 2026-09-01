import { createHash } from 'node:crypto';

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION =
  'public-forward-partial-fill-business-tolerance-decision-evidence-v2' as const;
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
const def = <T extends PublicForwardPartialFillBusinessToleranceDecisionDefinition>(value: T): T => Object.freeze(value);
export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS = Object.freeze({
  TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE: def({ decisionIdentity: 'TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE', metricIdentity: 'MEAN_ABSOLUTE_CALIBRATION_ERROR', unit: 'percentage_points' }),
  TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE: def({ decisionIdentity: 'TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE', metricIdentity: 'MEAN_ABSOLUTE_FILL_RATIO_ERROR', unit: 'percentage_points' }),
  TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE: def({ decisionIdentity: 'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE', metricIdentity: 'MEAN_SIGNED_FILL_RATIO_ERROR', interpretation: 'tolerance_magnitude', signConvention: 'predicted_fill_ratio_minus_actual_fill_ratio', unit: 'percentage_points' }),
  TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE: def({ decisionIdentity: 'TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE', metricIdentity: 'MEAN_ABSOLUTE_ALL_IN_COST_ERROR', unit: 'basis_points_of_notional' }),
  TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE: def({ decisionIdentity: 'TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE', metricIdentity: 'MEAN_ADVERSE_COST_UNDERESTIMATION', signConvention: 'actual_cost_minus_predicted_cost_positive_is_underestimation', unit: 'basis_points_of_notional' }),
  TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE: def({ decisionIdentity: 'TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE', metricIdentity: 'ADVERSE_TAIL_COST_UNDERESTIMATION', adverseDirection: 'actual_all_in_cost_greater_than_predicted_all_in_cost', unit: 'basis_points_of_notional' }),
  TOL07_INTERVAL_COVERAGE_REQUIREMENT: def({ decisionIdentity: 'TOL07_INTERVAL_COVERAGE_REQUIREMENT', metricIdentity: 'EMPIRICAL_PREDICTION_INTERVAL_COVERAGE', intervalType: 'NOMINAL_95_PERCENT_PREDICTION_INTERVAL', unit: 'percent' }),
  TOL08_SETTLEMENT_MATERIALITY_LIMIT: def({ decisionIdentity: 'TOL08_SETTLEMENT_MATERIALITY_LIMIT', metricIdentity: 'ABSOLUTE_SETTLEMENT_RECONCILIATION_DIFFERENCE', comparisonBasis: 'AUTHORITATIVE_SETTLEMENT_AFTER_DETERMINISTIC_FEE_TICK_AND_CURRENCY_ROUNDING', unit: 'basis_point_of_settlement_notional' }),
  TOL09_CALIBRATION_FRESHNESS_LIMIT: def({ decisionIdentity: 'TOL09_CALIBRATION_FRESHNESS_LIMIT', metricIdentity: 'AGE_SINCE_LAST_AUTHORITATIVE_CALIBRATION', ageReference: 'AUTHORITATIVE_CALIBRATION_FREEZE_TIMESTAMP', unit: 'calendar_days' }),
  TAIL_QUANTILE: def({ decisionIdentity: 'TAIL_QUANTILE', adverseTailDirection: 'HIGHER_ALL_IN_EXECUTION_COST_AND_WORSE_FILL_QUALITY', unit: 'quantile_fraction' }),
  MEANINGFUL_FAILURE_EFFECT_SIZE: def({ decisionIdentity: 'MEANINGFUL_FAILURE_EFFECT_SIZE', application: 'statistical_power_and_minimum_effect_detection_for_primary_calibration_gates', unit: 'standardized_effect_size' }),
} satisfies Readonly<Record<PublicForwardPartialFillBusinessToleranceDecisionKey, PublicForwardPartialFillBusinessToleranceDecisionDefinition>>);
export type PublicForwardPartialFillBusinessToleranceDecisionSemantics =
  typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS;

export interface HumanNumericDecision { value: number | null; unit: string | null; }
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
  schemaVersion: string | null; // assertion-only; builder writes the code-owned constant
  businessToleranceIdentity: typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY;
  businessToleranceVersion: string; // assertion-only; builder writes the code-owned constant
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
  'GOVERNANCE_MODEL_REQUIRED', 'GOVERNANCE_MODEL_INVALID', 'OWNER_IDENTITY_REQUIRED',
  'SOLE_OWNER_ATTESTATION_REQUIRED', 'SOLE_OWNER_APPROVER_IDENTITY_MISMATCH',
  'SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION', 'MULTI_APPROVER_DISTINCTNESS_REQUIRED',
  'GOVERNANCE_MODEL_CONTRADICTION', 'HUMAN_FINAL_AUTHORITY_REQUIRED',
  'PLACEHOLDER_APPROVER_FORBIDDEN', 'SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN',
]);
const FORBIDDEN_EXACT_IDENTITY_TOKENS = new Set([
  'PLACEHOLDER', 'TBD', 'TODO', 'UNKNOWN', 'UNSET', 'NONE', 'N/A', 'NA', 'TEST', 'TEST_USER',
  'TESTUSER', 'DUMMY', 'DUMMY_USER', 'SAMPLE', 'SAMPLE_USER', 'EXAMPLE', 'EXAMPLE_USER',
]);
const KNOWN_INVALID_HUMAN_IDENTITIES = new Set(['이승재1', '이승재2']);
const DECISION_BASIS_REFERENCE_PATTERN = /^https:\/\/github\.com\/seungjae3908-source\/seungjae20260713\/issues\/\d+#issuecomment-\d+$/;

function assertNonEmpty(value: string, field: string): void { if (!value.trim()) throw new Error(`${field}_MISSING`); }
function assertDigest(value: string, field: string): void { if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field}_INVALID`); }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalize(v)]),
  );
  return value;
}
function normalizeIdentity(value: string | null | undefined): string | null { const v = value?.trim(); return v || null; }
function identityComparisonKey(value: string | null | undefined): string | null {
  const v = normalizeIdentity(value); return v ? v.replace(/\s+/g, ' ').toLowerCase() : null;
}
function normalizedIdentityToken(value: string): string { return value.toUpperCase().replace(/[\s-]+/g, '_'); }
function isForbiddenHumanIdentity(value: string | null | undefined): boolean {
  const v = normalizeIdentity(value); if (!v) return false;
  if (KNOWN_INVALID_HUMAN_IDENTITIES.has(v) || /^(?:<[^<>]+>|\{[^{}]+\}|\$\{[^{}]+\})$/.test(v)) return true;
  const token = normalizedIdentityToken(v);
  return FORBIDDEN_EXACT_IDENTITY_TOKENS.has(token)
    || /^(?:AI|BOT|CHATGPT|OPENAI|ASSISTANT|SYSTEM|AUTOMATION)(?:_.+)?$/i.test(token)
    || /^(?:COMMAND(?:_?\d+)?|PENDING(?:_.+)?)$/i.test(token);
}
function pushUnique(errors: string[], error: string): void { if (!errors.includes(error)) errors.push(error); }
function validateHumanIdentity(value: string | null | undefined, missing: string, errors: string[]): void {
  if (!normalizeIdentity(value)) return pushUnique(errors, missing);
  if (isForbiddenHumanIdentity(value)) pushUnique(errors, 'PLACEHOLDER_APPROVER_FORBIDDEN');
}
function validateGovernance(input: PublicForwardPartialFillBusinessToleranceHumanInput, errors: string[]): void {
  const model = input.governanceModel?.trim();
  if (!model) return pushUnique(errors, 'GOVERNANCE_MODEL_REQUIRED');
  if (!PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_GOVERNANCE_MODELS.includes(model as PublicForwardPartialFillBusinessToleranceGovernanceModel)) {
    return pushUnique(errors, 'GOVERNANCE_MODEL_INVALID');
  }
  validateHumanIdentity(input.ownerIdentity, 'OWNER_IDENTITY_REQUIRED', errors);
  if (input.humanFinalAuthority !== true) pushUnique(errors, 'HUMAN_FINAL_AUTHORITY_REQUIRED');
  const owner = identityComparisonKey(input.ownerIdentity), release = identityComparisonKey(input.releaseApprover),
    risk = identityComparisonKey(input.riskApprover), settlement = identityComparisonKey(input.settlementReviewer);
  if (model === 'SOLE_OWNER_SELF_APPROVAL') {
    if (input.soleOwnerSelfApproval !== true) pushUnique(errors, 'SOLE_OWNER_ATTESTATION_REQUIRED');
    if (input.independentReview !== false || input.independentReviewRequired !== false) pushUnique(errors, 'SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION');
    if (owner && release && risk && settlement && (release !== owner || risk !== owner || settlement !== owner)) pushUnique(errors, 'SOLE_OWNER_APPROVER_IDENTITY_MISMATCH');
    return;
  }
  if (input.soleOwnerSelfApproval !== false || input.independentReview !== true || input.independentReviewRequired !== true) pushUnique(errors, 'GOVERNANCE_MODEL_CONTRADICTION');
  if (release && risk && release === risk) {
    pushUnique(errors, 'MULTI_APPROVER_DISTINCTNESS_REQUIRED');
    pushUnique(errors, 'SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN');
  }
}

const FIELD_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  decisionIdentity: 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING',
  metricIdentity: 'BUSINESS_TOLERANCE_METRIC_BINDING_INVALID',
  unit: 'BUSINESS_TOLERANCE_UNIT_BINDING_INVALID',
  interpretation: 'BUSINESS_TOLERANCE_SIGNED_BIAS_INTERPRETATION_INVALID',
  signConvention: 'BUSINESS_TOLERANCE_SIGN_CONVENTION_INVALID',
  adverseDirection: 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID',
  adverseTailDirection: 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID',
  intervalType: 'BUSINESS_TOLERANCE_INTERVAL_TYPE_INVALID',
  comparisonBasis: 'BUSINESS_TOLERANCE_SETTLEMENT_COMPARISON_BASIS_INVALID',
  ageReference: 'BUSINESS_TOLERANCE_CALIBRATION_AGE_REFERENCE_INVALID',
  application: 'BUSINESS_TOLERANCE_EFFECT_SIZE_APPLICATION_INVALID',
});
export function validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(candidate: unknown): readonly string[] {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return Object.freeze(['BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING']);
  const map = candidate as Record<string, unknown>;
  const expectedKeys = [...PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS].sort(), actualKeys = Object.keys(map).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((k, i) => k !== actualKeys[i])) pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_KEYS) {
    const expected = PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS[key] as unknown as Record<string, unknown>;
    const actual = map[key];
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) { pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING'); continue; }
    const actualRecord = actual as Record<string, unknown>;
    if (Object.keys(expected).length !== Object.keys(actualRecord).length) pushUnique(errors, 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
    for (const [field, value] of Object.entries(expected)) if (actualRecord[field] !== value) pushUnique(errors, FIELD_ERRORS[field] ?? 'BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
  }
  return Object.freeze(errors);
}

export function computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(
  evidence: Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'>,
): string { return createHash('sha256').update(JSON.stringify(canonicalize(evidence))).digest('hex'); }

export function validatePublicForwardPartialFillBusinessToleranceHumanInput(input: PublicForwardPartialFillBusinessToleranceHumanInput): readonly string[] {
  const errors: string[] = [];
  const check = (key: PublicForwardPartialFillBusinessToleranceDecisionKey, decision: HumanNumericDecision | undefined): void => {
    if (!decision || decision.value === null || !Number.isFinite(decision.value)) pushUnique(errors, `${key}_VALUE_MISSING_OR_INVALID`);
    if (!decision?.unit?.trim()) pushUnique(errors, `${key}_UNIT_MISSING`);
    else if (decision.unit !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS[key].unit) {
      pushUnique(errors, 'BUSINESS_TOLERANCE_UNIT_BINDING_INVALID'); pushUnique(errors, `${key}_UNIT_BINDING_INVALID`);
    }
  };
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS) check(key, input.tolerances[key]);
  check('TAIL_QUANTILE', input.tailQuantile); check('MEANINGFUL_FAILURE_EFFECT_SIZE', input.meaningfulFailureEffectSize);
  validateHumanIdentity(input.releaseApprover, 'RELEASE_APPROVER_MISSING', errors);
  validateHumanIdentity(input.riskApprover, 'RISK_APPROVER_MISSING', errors);
  validateHumanIdentity(input.settlementReviewer, 'SETTLEMENT_REVIEWER_MISSING', errors);
  validateGovernance(input, errors);
  if (!input.decisionBasisReference?.trim()) pushUnique(errors, 'DECISION_BASIS_REFERENCE_MISSING');
  else if (!DECISION_BASIS_REFERENCE_PATTERN.test(input.decisionBasisReference)) pushUnique(errors, 'DECISION_BASIS_REFERENCE_INVALID');
  if (!input.approvalTimestamp?.trim() || Number.isNaN(Date.parse(input.approvalTimestamp))) pushUnique(errors, 'APPROVAL_TIMESTAMP_MISSING_OR_INVALID');
  if (input.declarations.profitabilityOutcomeConsulted !== false) pushUnique(errors, 'PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN');
  if (input.declarations.currentN1UsedToSelectValues !== false) pushUnique(errors, 'CURRENT_N1_VALUE_SELECTION_FORBIDDEN');
  if (input.declarations.currentPassFailConsulted !== false) pushUnique(errors, 'CURRENT_PASS_FAIL_CONSULTED_FORBIDDEN');
  if (input.declarations.aiNumericAuthority !== 'NONE') pushUnique(errors, 'AI_NUMERIC_AUTHORITY_FORBIDDEN');
  if (input.declarations.prospectiveOnly !== true) pushUnique(errors, 'PROSPECTIVE_ONLY_REQUIRED');
  if (input.declarations.executionAuthority !== 'NONE') pushUnique(errors, 'EXECUTION_AUTHORITY_FORBIDDEN');
  return Object.freeze(errors);
}

export function buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(
  context: PublicForwardPartialFillBusinessToleranceDecisionContext,
  humanInput: PublicForwardPartialFillBusinessToleranceHumanInput,
): PublicForwardPartialFillBusinessToleranceDecisionEvidence {
  if (context.schemaVersion !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION) throw new Error('BUSINESS_TOLERANCE_EVIDENCE_SCHEMA_MISMATCH');
  if (context.businessToleranceIdentity !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY) throw new Error('BUSINESS_TOLERANCE_IDENTITY_MISMATCH');
  if (context.businessToleranceVersion !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION) throw new Error('BUSINESS_TOLERANCE_VERSION_MISMATCH');
  for (const [field, value] of [['SCOPE_UNIVERSE_IDENTITY', context.scopeUniverseIdentity], ['CONSUMER_IDENTITY', context.consumerIdentity], ['RISK_METHODOLOGY_IDENTITY', context.riskMethodologyIdentity]] as const) assertNonEmpty(value, field);
  assertDigest(context.scopeUniverseDigest, 'SCOPE_UNIVERSE_DIGEST'); assertDigest(context.riskMethodologyDigest, 'RISK_METHODOLOGY_DIGEST');
  if (!Number.isSafeInteger(context.effectiveCohortStartMs) || context.effectiveCohortStartMs <= 0) throw new Error('EFFECTIVE_COHORT_START_INVALID');
  if (validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS).length) throw new Error('BUSINESS_TOLERANCE_CANONICAL_REQUIRED_FIELD_BINDING_MISSING');
  const validationErrors = validatePublicForwardPartialFillBusinessToleranceHumanInput(humanInput), complete = validationErrors.length === 0;
  const governanceInvalid = validationErrors.some((error) => GOVERNANCE_ERROR_CODES.has(error));
  const canonicalContext = { ...context, schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION, businessToleranceIdentity: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY, businessToleranceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION };
  const body: Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'> = {
    evidenceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
    context: canonicalContext,
    decisionSemantics: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS,
    humanInput,
    validationStatus: complete ? 'COMPLETE_AWAITING_FREEZE' : 'INCOMPLETE',
    firstZero: complete ? null : governanceInvalid ? 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED' : 'BUSINESS_TOLERANCE_VALUES_NOT_APPROVED',
    rootCauseClass: complete ? null : governanceInvalid ? 'HUMAN_GOVERNANCE_DECISION_INVALID' : 'HUMAN_RISK_NUMERIC_DECISION_MISSING',
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
