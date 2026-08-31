import { createHash } from 'node:crypto';

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION =
  'public-forward-partial-fill-business-tolerance-decision-evidence-v2' as const;

export const PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY =
  'PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_V1' as const;

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
    aiNumericAuthority: 'NONE' | string;
    prospectiveOnly: boolean;
    executionAuthority: 'NONE' | string;
  };
}

export interface PublicForwardPartialFillBusinessToleranceDecisionContext {
  schemaVersion: string;
  businessToleranceIdentity: typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY;
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
  humanInput: PublicForwardPartialFillBusinessToleranceHumanInput;
  validationStatus: 'COMPLETE_AWAITING_FREEZE' | 'INCOMPLETE';
  firstZero: null | 'BUSINESS_TOLERANCE_VALUES_NOT_APPROVED' | 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED';
  rootCauseClass: null | 'HUMAN_RISK_NUMERIC_DECISION_MISSING' | 'HUMAN_GOVERNANCE_DECISION_INVALID';
  validationErrors: readonly string[];
  numericValuesFrozen: false;
  frozenBusinessToleranceArtifactProduced: false;
  statisticalNumericizationAllowed: false;
  productionAuthority: false;
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
    if (!decision || decision.value === null || !Number.isFinite(decision.value)) errors.push(`${key}_VALUE_MISSING_OR_INVALID`);
    if (!decision?.unit?.trim()) errors.push(`${key}_UNIT_MISSING`);
  }
  for (const [key, decision] of [
    ['TAIL_QUANTILE', input.tailQuantile],
    ['MEANINGFUL_FAILURE_EFFECT_SIZE', input.meaningfulFailureEffectSize],
  ] as const) {
    if (decision.value === null || !Number.isFinite(decision.value)) errors.push(`${key}_VALUE_MISSING_OR_INVALID`);
    if (!decision.unit?.trim()) errors.push(`${key}_UNIT_MISSING`);
  }

  validateHumanIdentity(input.releaseApprover, 'RELEASE_APPROVER_MISSING', errors);
  validateHumanIdentity(input.riskApprover, 'RISK_APPROVER_MISSING', errors);
  validateHumanIdentity(input.settlementReviewer, 'SETTLEMENT_REVIEWER_MISSING', errors);
  validateGovernance(input, errors);

  if (!input.decisionBasisReference?.trim()) errors.push('DECISION_BASIS_REFERENCE_MISSING');
  if (!input.approvalTimestamp?.trim() || Number.isNaN(Date.parse(input.approvalTimestamp))) errors.push('APPROVAL_TIMESTAMP_MISSING_OR_INVALID');
  if (input.declarations.profitabilityOutcomeConsulted !== false) errors.push('PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN');
  if (input.declarations.currentN1UsedToSelectValues !== false) errors.push('CURRENT_N1_VALUE_SELECTION_FORBIDDEN');
  if (input.declarations.aiNumericAuthority !== 'NONE') errors.push('AI_NUMERIC_AUTHORITY_FORBIDDEN');
  if (input.declarations.prospectiveOnly !== true) errors.push('PROSPECTIVE_ONLY_REQUIRED');
  if (input.declarations.executionAuthority !== 'NONE') errors.push('EXECUTION_AUTHORITY_FORBIDDEN');
  return Object.freeze(errors);
}

export function buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(
  context: PublicForwardPartialFillBusinessToleranceDecisionContext,
  humanInput: PublicForwardPartialFillBusinessToleranceHumanInput,
): PublicForwardPartialFillBusinessToleranceDecisionEvidence {
  assertNonEmpty(context.schemaVersion, 'SCHEMA_VERSION');
  if (context.businessToleranceIdentity !== PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY) {
    throw new Error('BUSINESS_TOLERANCE_IDENTITY_MISMATCH');
  }
  for (const [field, value] of [
    ['BUSINESS_TOLERANCE_VERSION', context.businessToleranceVersion],
    ['SCOPE_UNIVERSE_IDENTITY', context.scopeUniverseIdentity],
    ['CONSUMER_IDENTITY', context.consumerIdentity],
    ['RISK_METHODOLOGY_IDENTITY', context.riskMethodologyIdentity],
  ] as const) assertNonEmpty(value, field);
  assertDigest(context.scopeUniverseDigest, 'SCOPE_UNIVERSE_DIGEST');
  assertDigest(context.riskMethodologyDigest, 'RISK_METHODOLOGY_DIGEST');
  if (!Number.isSafeInteger(context.effectiveCohortStartMs) || context.effectiveCohortStartMs <= 0) {
    throw new Error('EFFECTIVE_COHORT_START_INVALID');
  }

  const validationErrors = validatePublicForwardPartialFillBusinessToleranceHumanInput(humanInput);
  const complete = validationErrors.length === 0;
  const governanceInvalid = validationErrors.some((error) => GOVERNANCE_ERROR_CODES.has(error));
  const body: Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'> = {
    evidenceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
    context,
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
  };
  return Object.freeze({ ...body, digest: computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(body) });
}
