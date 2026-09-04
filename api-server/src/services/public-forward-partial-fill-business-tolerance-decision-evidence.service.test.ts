import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_SCHEMA_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS,
  buildPublicForwardPartialFillBusinessToleranceDecisionEvidence,
  computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest,
  validatePublicForwardPartialFillBusinessToleranceDecisionSemantics,
  type PublicForwardPartialFillBusinessToleranceDecisionEvidence,
  type PublicForwardPartialFillBusinessToleranceHumanInput,
} from './public-forward-partial-fill-business-tolerance-decision-evidence.service';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const DECISION_REF = 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5487034182';
const context = {
  schemaVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_SCHEMA_VERSION,
  businessToleranceIdentity: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  businessToleranceVersion: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_VERSION,
  scopeUniverseIdentity: 'TEST_ONLY_SCOPE', scopeUniverseDigest: digest('scope'),
  consumerIdentity: 'TEST_ONLY_SETTLEMENT_CONSUMER', riskMethodologyIdentity: 'TEST_ONLY_RISK_METHOD',
  riskMethodologyDigest: digest('risk'), effectiveCohortStartMs: 2_000,
};
function blankInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  return {
    tolerances: Object.fromEntries(PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS.map((key) => [key, { value: null, unit: null }])) as PublicForwardPartialFillBusinessToleranceHumanInput['tolerances'],
    tailQuantile: { value: null, unit: null }, meaningfulFailureEffectSize: { value: null, unit: null },
    governanceModel: null, ownerIdentity: null, releaseApprover: null, riskApprover: null, settlementReviewer: null,
    soleOwnerSelfApproval: null, independentReview: null, independentReviewRequired: null, humanFinalAuthority: null,
    decisionBasisReference: null, approvalTimestamp: null,
    declarations: { profitabilityOutcomeConsulted: false, currentN1UsedToSelectValues: false, currentPassFailConsulted: false, aiNumericAuthority: 'NONE', prospectiveOnly: true, executionAuthority: 'NONE' },
  };
}
function fillHumanNumericDecisions(input: PublicForwardPartialFillBusinessToleranceHumanInput): void {
  Object.assign(input.tolerances, {
    TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE: { value: 10, unit: 'percentage_points' },
    TOL02_ACTUAL_FILL_PRIMARY_ERROR_TOLERANCE: { value: 10, unit: 'percentage_points' },
    TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE: { value: 5, unit: 'percentage_points' },
    TOL04_ACTUAL_COST_ABSOLUTE_ERROR_TOLERANCE: { value: 5, unit: 'basis_points_of_notional' },
    TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE: { value: 3, unit: 'basis_points_of_notional' },
    TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE: { value: 10, unit: 'basis_points_of_notional' },
    TOL07_INTERVAL_COVERAGE_REQUIREMENT: { value: 95, unit: 'percent' },
    TOL08_SETTLEMENT_MATERIALITY_LIMIT: { value: 1, unit: 'basis_point_of_settlement_notional' },
    TOL09_CALIBRATION_FRESHNESS_LIMIT: { value: 14, unit: 'calendar_days' },
  });
  input.tailQuantile = { value: 0.95, unit: 'quantile_fraction' };
  input.meaningfulFailureEffectSize = { value: 0.35, unit: 'standardized_effect_size' };
  input.decisionBasisReference = DECISION_REF; input.approvalTimestamp = '2026-09-01T00:18:51+09:00';
}
function setSoleOwnerIdentity(input: PublicForwardPartialFillBusinessToleranceHumanInput, identity: string): void {
  input.ownerIdentity = identity; input.releaseApprover = identity; input.riskApprover = identity; input.settlementReviewer = identity;
}
function completeSoleOwnerInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  const input = blankInput(); fillHumanNumericDecisions(input); setSoleOwnerIdentity(input, 'SOLE_OWNER_HUMAN');
  input.governanceModel = 'SOLE_OWNER_SELF_APPROVAL'; input.soleOwnerSelfApproval = true;
  input.independentReview = false; input.independentReviewRequired = false; input.humanFinalAuthority = true; return input;
}
function approvedSoleOwnerInput(): PublicForwardPartialFillBusinessToleranceHumanInput { const input = completeSoleOwnerInput(); setSoleOwnerIdentity(input, '이승재'); return input; }
function completeMultiApproverInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  const input = blankInput(); fillHumanNumericDecisions(input); input.governanceModel = 'INDEPENDENT_MULTI_APPROVER';
  input.ownerIdentity = 'OWNER_HUMAN'; input.releaseApprover = 'RELEASE_HUMAN'; input.riskApprover = 'RISK_HUMAN'; input.settlementReviewer = 'SETTLEMENT_HUMAN';
  input.soleOwnerSelfApproval = false; input.independentReview = true; input.independentReviewRequired = true; input.humanFinalAuthority = true; return input;
}
function expectPlaceholderIdentityFailure(identity: string): void {
  const input = completeSoleOwnerInput(); setSoleOwnerIdentity(input, identity);
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'INCOMPLETE'); assert.ok(result.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN'));
}
function cloneSemantics(): Record<string, Record<string, unknown>> { return JSON.parse(JSON.stringify(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS)); }
function bodyWithoutDigest(result: PublicForwardPartialFillBusinessToleranceDecisionEvidence): Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'> { const { digest: _digest, ...body } = result; return body; }
function digestWithSemanticMutation(result: PublicForwardPartialFillBusinessToleranceDecisionEvidence, mutate: (s: Record<string, Record<string, unknown>>) => void): string {
  const semantics = cloneSemantics(); mutate(semantics); return computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest({ ...bodyWithoutDigest(result), decisionSemantics: semantics as unknown as typeof PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS });
}

// Preserved #858/#860 tests.
test('blank human form remains fail-closed without numeric or governance defaults', () => {
  const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, blankInput()); assert.equal(r.evidenceVersion, PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION);
  assert.equal(r.validationStatus, 'INCOMPLETE'); assert.equal(r.firstZero, 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED'); assert.equal(r.rootCauseClass, 'HUMAN_GOVERNANCE_DECISION_INVALID');
  assert.equal(r.numericValuesFrozen, false); assert.equal(r.productionAuthority, false); assert.ok(r.validationErrors.includes('GOVERNANCE_MODEL_REQUIRED')); assert.ok(r.validationErrors.includes('TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE_VALUE_MISSING_OR_INVALID'));
});
test('valid sole-owner triple-role input passes governance validation', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput()); assert.equal(r.validationStatus, 'COMPLETE_AWAITING_FREEZE'); assert.equal(r.firstZero, null); assert.equal(r.rootCauseClass, null); assert.deepEqual(r.validationErrors, []); assert.equal(r.humanInput.releaseApprover, r.humanInput.ownerIdentity); assert.equal(r.humanInput.riskApprover, r.humanInput.ownerIdentity); assert.equal(r.humanInput.settlementReviewer, r.humanInput.ownerIdentity); });
test('sole-owner identity mismatch fails closed', () => { const i = completeSoleOwnerInput(); i.riskApprover = 'DIFFERENT_HUMAN'; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('SOLE_OWNER_APPROVER_IDENTITY_MISMATCH')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('sole-owner missing owner fails closed', () => { const i = completeSoleOwnerInput(); i.ownerIdentity = null; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('OWNER_IDENTITY_REQUIRED')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('sole-owner independent-review=true is contradictory', () => { const i = completeSoleOwnerInput(); i.independentReview = true; assert.ok(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors.includes('SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION')); });
test('sole-owner independent-review-required=true is contradictory', () => { const i = completeSoleOwnerInput(); i.independentReviewRequired = true; assert.ok(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors.includes('SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION')); });
test('multi-approver identical release/risk identities fail closed', () => { const i = completeMultiApproverInput(); i.riskApprover = i.releaseApprover; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('MULTI_APPROVER_DISTINCTNESS_REQUIRED')); assert.ok(r.validationErrors.includes('SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('multi-approver distinct valid identities pass governance validation', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeMultiApproverInput()); assert.deepEqual(r.validationErrors, []); assert.equal(r.validationStatus, 'COMPLETE_AWAITING_FREEZE'); });
test('missing governance model fails without inferring legacy inputs', () => { const i = completeSoleOwnerInput(); delete i.governanceModel; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('GOVERNANCE_MODEL_REQUIRED')); assert.equal(r.firstZero, 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED'); });
test('placeholder and AI/BOT identities fail governance validation', () => { const i = completeSoleOwnerInput(); i.ownerIdentity = '<OWNER>'; i.releaseApprover = 'AI'; i.riskApprover = 'BOT'; i.settlementReviewer = 'ChatGPT'; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('governance changes alter canonical evidence digest', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput()); const i = completeSoleOwnerInput(); i.independentReview = true; const b = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.notEqual(a.digest, b.digest); assert.equal(a.digest, computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(bodyWithoutDigest(a))); });
test('valid governance never freezes business tolerance policy', () => { for (const r of [buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput()), buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeMultiApproverInput())]) { assert.equal(r.numericValuesFrozen, false); assert.equal(r.frozenBusinessToleranceArtifactProduced, false); assert.equal(r.statisticalNumericizationAllowed, false); assert.equal(r.policyFrozen, false); assert.equal(r.statisticalNumericizationStarted, false); } });
test('valid governance never grants Production or trading authority', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput()); assert.equal(r.productionAuthority, false); assert.equal(r.executionAuthority, 'NONE'); assert.equal(r.liveTrading, false); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.productionPolicyAuthorityConnected, false); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.executionAuthority, 'NONE'); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.privateApiAllowed, false); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.liveTrading, false); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.orderSubmissionAllowed, false); });
test('non-governance contamination declarations remain fail-closed', () => { const i = completeSoleOwnerInput(); Object.assign(i.declarations, { profitabilityOutcomeConsulted: true, currentN1UsedToSelectValues: true, currentPassFailConsulted: true, aiNumericAuthority: 'AI', prospectiveOnly: false, executionAuthority: 'LIVE' }); const e = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors; for (const code of ['PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN', 'CURRENT_N1_VALUE_SELECTION_FORBIDDEN', 'CURRENT_PASS_FAIL_CONSULTED_FORBIDDEN', 'AI_NUMERIC_AUTHORITY_FORBIDDEN', 'PROSPECTIVE_ONLY_REQUIRED', 'EXECUTION_AUTHORITY_FORBIDDEN']) assert.ok(e.includes(code)); });
test('safety contract explicitly scopes same-person approval to sole-owner governance', () => { const s = PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY; assert.equal(s.numericDefaultsAllowed, false); assert.equal(s.aiNumericAuthority, 'NONE'); assert.equal(s.governanceModelRequired, true); assert.equal(s.soleOwnerSelfApprovalSupported, true); assert.equal(s.singleApproverSelfAuthorizationRequiresExplicitSoleOwnerGovernance, true); assert.equal(s.frozenArtifactProduced, false); assert.equal(s.fullCostReady, false); assert.equal(s.evidenceComplete, 0); assert.equal(s.executionAuthority, 'NONE'); assert.equal(s.currentPassFailConsultedAllowed, false); });
test('approved additional generic, automation, and template identity forms fail closed', () => { for (const id of ['TODO', 'UNSET', 'N/A', 'NA', 'TEST', 'TESTUSER', 'DUMMY_USER', 'SAMPLE', 'SAMPLE_USER', 'EXAMPLE', 'EXAMPLE_USER', 'OPENAI', 'ASSISTANT', 'AUTOMATION', 'AI_REVIEWER', 'BOT-REVIEWER', 'SYSTEM REVIEWER', '{OWNER}', '{APPROVER}', '{NAME}', '{USER}', '${OWNER}', '${APPROVER}']) expectPlaceholderIdentityFailure(id); });

test('IDENTITY T01 valid sole-owner 이승재 triple-role PASS', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.equal(r.validationStatus, 'COMPLETE_AWAITING_FREEZE'); assert.deepEqual(r.validationErrors, []); });
test('IDENTITY T02 valid distinct multi-approver identities PASS', () => { const i = completeMultiApproverInput(); Object.assign(i, { ownerIdentity: 'Minseo Park', releaseApprover: 'Jisoo Han', riskApprover: 'Daniel Kim', settlementReviewer: 'Sora Lee' }); const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.equal(r.validationStatus, 'COMPLETE_AWAITING_FREEZE'); assert.deepEqual(r.validationErrors, []); });
for (const [name, field, value, code] of [
  ['IDENTITY T03 owner empty FAIL', 'ownerIdentity', '', 'OWNER_IDENTITY_REQUIRED'], ['IDENTITY T04 release empty FAIL', 'releaseApprover', '', 'RELEASE_APPROVER_MISSING'], ['IDENTITY T05 risk whitespace-only FAIL', 'riskApprover', '   ', 'RISK_APPROVER_MISSING'], ['IDENTITY T06 settlement missing FAIL', 'settlementReviewer', null, 'SETTLEMENT_REVIEWER_MISSING'],
] as const) test(name, () => { const i = completeSoleOwnerInput(); (i as unknown as Record<string, unknown>)[field] = value; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes(code)); assert.equal(r.validationStatus, 'INCOMPLETE'); });
for (const [n, id] of [['T07', 'PLACEHOLDER'], ['T08', 'placeholder'], ['T09', 'TEST_USER'], ['T10', 'TBD'], ['T11', 'UNKNOWN'], ['T12', 'DUMMY'], ['T13', 'AI'], ['T14', 'BOT'], ['T15', 'ChatGPT'], ['T16', 'SYSTEM'], ['T17', '<OWNER>'], ['T18', '<APPROVER>'], ['T19', '이승재1'], ['T20', '이승재2']] as const) test(`IDENTITY ${n} ${id} FAIL`, () => expectPlaceholderIdentityFailure(id));
test('IDENTITY T21 legitimate human Latin-name fixture PASS', () => { const i = completeSoleOwnerInput(); setSoleOwnerIdentity(i, 'Aiko Botkin'); assert.deepEqual(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors, []); });
test('IDENTITY T22 legitimate human Korean-name fixture PASS', () => { const i = completeSoleOwnerInput(); setSoleOwnerIdentity(i, '김민수'); assert.deepEqual(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors, []); });
test('IDENTITY T23 case and whitespace normalization preserves valid sole-owner equality PASS', () => { const i = completeSoleOwnerInput(); Object.assign(i, { ownerIdentity: '  Alice Smith  ', releaseApprover: 'alice smith', riskApprover: 'ALICE   SMITH', settlementReviewer: 'Alice Smith ' }); assert.deepEqual(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).validationErrors, []); });
test('IDENTITY T24 distinct identities with one TEST_USER FAIL', () => { const i = completeMultiApproverInput(); Object.assign(i, { ownerIdentity: 'Owner Person', releaseApprover: 'Release Person', riskApprover: 'TEST_USER', settlementReviewer: 'Settlement Person' }); const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('IDENTITY T25 two valid but identical humans FAIL multi-approver distinctness', () => { const i = completeMultiApproverInput(); i.releaseApprover = 'Jordan Lee'; i.riskApprover = '  jordan   lee  '; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('MULTI_APPROVER_DISTINCTNESS_REQUIRED')); assert.ok(r.validationErrors.includes('SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN')); assert.equal(r.validationStatus, 'INCOMPLETE'); });

// Approved schema/semantic binding matrix T01-T43.
test('SEMANTIC T01 valid exact approved sole-owner bundle PASS', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.equal(r.validationStatus, 'COMPLETE_AWAITING_FREEZE'); assert.deepEqual(r.validationErrors, []); assert.equal(r.context.schemaVersion, PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION); });
test('SEMANTIC T02 caller arbitrary schema version FAIL', () => assert.throws(() => buildPublicForwardPartialFillBusinessToleranceDecisionEvidence({ ...context, schemaVersion: 'anything' }, approvedSoleOwnerInput()), /BUSINESS_TOLERANCE_EVIDENCE_SCHEMA_MISMATCH/));
test('SEMANTIC T03 missing schema authority FAIL', () => assert.throws(() => buildPublicForwardPartialFillBusinessToleranceDecisionEvidence({ ...context, schemaVersion: null }, approvedSoleOwnerInput()), /BUSINESS_TOLERANCE_EVIDENCE_SCHEMA_MISMATCH/));
test('SEMANTIC T04 TOL01 correct metric PASS', () => { assert.deepEqual(validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS), []); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE.metricIdentity, 'MEAN_ABSOLUTE_CALIBRATION_ERROR'); });
function semanticMutationTest(name: string, key: string, field: string, value: string, error: string): void { test(name, () => { const s = cloneSemantics(); s[key][field] = value; assert.ok(validatePublicForwardPartialFillBusinessToleranceDecisionSemantics(s).includes(error)); }); }
semanticMutationTest('SEMANTIC T05 TOL01 wrong metric FAIL', 'TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE', 'metricIdentity', 'MEAN_ABSOLUTE_FILL_RATIO_ERROR', 'BUSINESS_TOLERANCE_METRIC_BINDING_INVALID');
test('SEMANTIC T06 TOL01 correct value but wrong non-empty unit FAIL', () => { const i = approvedSoleOwnerInput(); i.tolerances.TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE.unit = 'basis_points'; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('BUSINESS_TOLERANCE_UNIT_BINDING_INVALID')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('SEMANTIC T07 TOL03 tolerance_magnitude PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE.interpretation, 'tolerance_magnitude'));
semanticMutationTest('SEMANTIC T08 TOL03 signed_target interpretation FAIL', 'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE', 'interpretation', 'signed_target', 'BUSINESS_TOLERANCE_SIGNED_BIAS_INTERPRETATION_INVALID');
test('SEMANTIC T09 TOL03 canonical sign convention PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE.signConvention, 'predicted_fill_ratio_minus_actual_fill_ratio'));
semanticMutationTest('SEMANTIC T10 TOL03 reversed sign FAIL', 'TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE', 'signConvention', 'actual_fill_ratio_minus_predicted_fill_ratio', 'BUSINESS_TOLERANCE_SIGN_CONVENTION_INVALID');
test('SEMANTIC T11 TOL05 canonical sign PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE.signConvention, 'actual_cost_minus_predicted_cost_positive_is_underestimation'));
semanticMutationTest('SEMANTIC T12 TOL05 reversed sign FAIL', 'TOL05_ACTUAL_COST_UNDERESTIMATION_TOLERANCE', 'signConvention', 'predicted_cost_minus_actual_cost_positive_is_underestimation', 'BUSINESS_TOLERANCE_SIGN_CONVENTION_INVALID');
test('SEMANTIC T13 TOL06 canonical adverse direction PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE.adverseDirection, 'actual_all_in_cost_greater_than_predicted_all_in_cost'));
semanticMutationTest('SEMANTIC T14 TOL06 opposite direction FAIL', 'TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE', 'adverseDirection', 'predicted_all_in_cost_greater_than_actual_all_in_cost', 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID');
test('SEMANTIC T15 TOL07 nominal 95% interval type PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL07_INTERVAL_COVERAGE_REQUIREMENT.intervalType, 'NOMINAL_95_PERCENT_PREDICTION_INTERVAL'));
semanticMutationTest('SEMANTIC T16 TOL07 wrong interval type FAIL', 'TOL07_INTERVAL_COVERAGE_REQUIREMENT', 'intervalType', 'NOMINAL_90_PERCENT_PREDICTION_INTERVAL', 'BUSINESS_TOLERANCE_INTERVAL_TYPE_INVALID');
test('SEMANTIC T17 TOL08 canonical comparison basis PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL08_SETTLEMENT_MATERIALITY_LIMIT.comparisonBasis, 'AUTHORITATIVE_SETTLEMENT_AFTER_DETERMINISTIC_FEE_TICK_AND_CURRENCY_ROUNDING'));
semanticMutationTest('SEMANTIC T18 TOL08 wrong settlement comparison basis FAIL', 'TOL08_SETTLEMENT_MATERIALITY_LIMIT', 'comparisonBasis', 'RAW_UNROUNDED_SETTLEMENT', 'BUSINESS_TOLERANCE_SETTLEMENT_COMPARISON_BASIS_INVALID');
test('SEMANTIC T19 TOL09 authoritative calibration freeze timestamp reference PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TOL09_CALIBRATION_FRESHNESS_LIMIT.ageReference, 'AUTHORITATIVE_CALIBRATION_FREEZE_TIMESTAMP'));
semanticMutationTest('SEMANTIC T20 TOL09 observation timestamp reference FAIL', 'TOL09_CALIBRATION_FRESHNESS_LIMIT', 'ageReference', 'OBSERVATION_TIMESTAMP', 'BUSINESS_TOLERANCE_CALIBRATION_AGE_REFERENCE_INVALID');
test('SEMANTIC T21 tail adverse direction PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.TAIL_QUANTILE.adverseTailDirection, 'HIGHER_ALL_IN_EXECUTION_COST_AND_WORSE_FILL_QUALITY'));
semanticMutationTest('SEMANTIC T22 tail adverse direction changed FAIL', 'TAIL_QUANTILE', 'adverseTailDirection', 'LOWER_COST_AND_BETTER_FILL_QUALITY', 'BUSINESS_TOLERANCE_ADVERSE_DIRECTION_INVALID');
test('SEMANTIC T23 meaningful effect application PASS', () => assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SEMANTICS.MEANINGFUL_FAILURE_EFFECT_SIZE.application, 'statistical_power_and_minimum_effect_detection_for_primary_calibration_gates'));
semanticMutationTest('SEMANTIC T24 meaningful effect application changed FAIL', 'MEANINGFUL_FAILURE_EFFECT_SIZE', 'application', 'profitability_tuning', 'BUSINESS_TOLERANCE_EFFECT_SIZE_APPLICATION_INVALID');
test('SEMANTIC T25 all 11 numeric decisions complete PASS', () => { assert.equal(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).validationStatus, 'COMPLETE_AWAITING_FREEZE'); assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS.length + 2, 11); });
test('SEMANTIC T26 missing one numeric value FAIL', () => { const i = approvedSoleOwnerInput(); i.tolerances.TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE.value = null; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('TOL06_ADVERSE_TAIL_UNDERESTIMATION_TOLERANCE_VALUE_MISSING_OR_INVALID')); assert.equal(r.validationStatus, 'INCOMPLETE'); });
test('SEMANTIC T27 governance sole-owner valid PASS', () => assert.deepEqual(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).validationErrors, []));
test('SEMANTIC T28 placeholder, AI, automation, and invalid aliases FAIL', () => { for (const id of ['PLACEHOLDER', 'TEST_USER', 'AI', 'BOT', 'ChatGPT', 'SYSTEM', 'AUTOMATION', '<OWNER>', '<APPROVER>', '{OWNER}', '${APPROVER}', '이승재1', '이승재2']) expectPlaceholderIdentityFailure(id); });
test('SEMANTIC T29 exact decisionBasisReference permalink PASS', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.equal(r.humanInput.decisionBasisReference, DECISION_REF); assert.ok(!r.validationErrors.includes('DECISION_BASIS_REFERENCE_INVALID')); });
test('SEMANTIC T30 TBD, PENDING, #838, and issue-only references FAIL', () => { for (const ref of ['TBD', 'PENDING', '#838', 'https://github.com/seungjae3908-source/seungjae20260713/issues/838']) { const i = approvedSoleOwnerInput(); i.decisionBasisReference = ref; const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.ok(r.validationErrors.includes('DECISION_BASIS_REFERENCE_INVALID')); assert.equal(r.validationStatus, 'INCOMPLETE'); } });
test('SEMANTIC T31 same bundle same context digest deterministic PASS', () => assert.equal(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).digest, buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).digest));
test('SEMANTIC T32 owner mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const i = approvedSoleOwnerInput(); setSoleOwnerIdentity(i, '김민수'); assert.notEqual(a.digest, buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).digest); });
test('SEMANTIC T33 metric mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.notEqual(a.digest, digestWithSemanticMutation(a, s => { s.TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE.metricIdentity = 'MEAN_ABSOLUTE_FILL_RATIO_ERROR'; })); });
test('SEMANTIC T34 sign semantic mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.notEqual(a.digest, digestWithSemanticMutation(a, s => { s.TOL03_ACTUAL_FILL_SIGNED_BIAS_TOLERANCE.signConvention = 'actual_fill_ratio_minus_predicted_fill_ratio'; })); });
test('SEMANTIC T35 numeric mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const i = approvedSoleOwnerInput(); i.tolerances.TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE.value = 11; assert.notEqual(a.digest, buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).digest); });
test('SEMANTIC T36 unit mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const i = approvedSoleOwnerInput(); i.tolerances.TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE.unit = 'basis_points'; const b = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i); assert.notEqual(a.digest, b.digest); assert.ok(b.validationErrors.includes('BUSINESS_TOLERANCE_UNIT_BINDING_INVALID')); });
test('SEMANTIC T37 decision basis mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const i = approvedSoleOwnerInput(); i.decisionBasisReference = 'https://github.com/seungjae3908-source/seungjae20260713/issues/838#issuecomment-5487034183'; assert.notEqual(a.digest, buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).digest); });
test('SEMANTIC T38 approval timestamp mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const i = approvedSoleOwnerInput(); i.approvalTimestamp = '2026-09-01T00:18:52+09:00'; assert.notEqual(a.digest, buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, i).digest); });
test('SEMANTIC T39 schema identity mutation changes digest PASS', () => { const a = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); const mutated = JSON.parse(JSON.stringify(bodyWithoutDigest(a))) as Record<string, unknown>; mutated.evidenceVersion = 'mutated-schema'; (mutated.context as Record<string, unknown>).schemaVersion = 'mutated-schema'; const changed = computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(mutated as unknown as Omit<PublicForwardPartialFillBusinessToleranceDecisionEvidence, 'digest'>); assert.notEqual(a.digest, changed); });
test('SEMANTIC T40 valid validation leaves policyFrozen=false PASS', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.equal(r.policyFrozen, false); assert.equal(r.numericValuesFrozen, false); });
test('SEMANTIC T41 valid validation leaves productionAuthority=false PASS', () => assert.equal(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).productionAuthority, false));
test('SEMANTIC T42 valid validation leaves executionAuthority=NONE PASS', () => assert.equal(buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()).executionAuthority, 'NONE'));
test('SEMANTIC T43 valid validation leaves liveTrading=false PASS', () => { const r = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, approvedSoleOwnerInput()); assert.equal(r.liveTrading, false); assert.equal(r.statisticalNumericizationStarted, false); });
