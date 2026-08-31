import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS,
  buildPublicForwardPartialFillBusinessToleranceDecisionEvidence,
  computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest,
  type PublicForwardPartialFillBusinessToleranceHumanInput,
} from './public-forward-partial-fill-business-tolerance-decision-evidence.service';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const context = {
  schemaVersion: '2',
  businessToleranceIdentity: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  businessToleranceVersion: 'test-only-v1-numerics-unchanged',
  scopeUniverseIdentity: 'TEST_ONLY_SCOPE',
  scopeUniverseDigest: digest('scope'),
  consumerIdentity: 'TEST_ONLY_SETTLEMENT_CONSUMER',
  riskMethodologyIdentity: 'TEST_ONLY_RISK_METHOD',
  riskMethodologyDigest: digest('risk'),
  effectiveCohortStartMs: 2_000,
};

function blankInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  return {
    tolerances: Object.fromEntries(PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS.map((key) => [key, { value: null, unit: null }])) as PublicForwardPartialFillBusinessToleranceHumanInput['tolerances'],
    tailQuantile: { value: null, unit: null },
    meaningfulFailureEffectSize: { value: null, unit: null },
    governanceModel: null,
    ownerIdentity: null,
    releaseApprover: null,
    riskApprover: null,
    settlementReviewer: null,
    soleOwnerSelfApproval: null,
    independentReview: null,
    independentReviewRequired: null,
    humanFinalAuthority: null,
    decisionBasisReference: null,
    approvalTimestamp: null,
    declarations: {
      profitabilityOutcomeConsulted: false,
      currentN1UsedToSelectValues: false,
      aiNumericAuthority: 'NONE',
      prospectiveOnly: true,
      executionAuthority: 'NONE',
    },
  };
}

function fillHumanNumericDecisions(input: PublicForwardPartialFillBusinessToleranceHumanInput): void {
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS) {
    input.tolerances[key] = { value: 123, unit: 'TEST_ONLY_UNIT' };
  }
  input.tailQuantile = { value: 123, unit: 'TEST_ONLY_UNIT' };
  input.meaningfulFailureEffectSize = { value: 123, unit: 'TEST_ONLY_UNIT' };
  input.decisionBasisReference = 'TEST_ONLY_TRACEABLE_DECISION_REFERENCE';
  input.approvalTimestamp = '2026-09-01T00:18:51+09:00';
}

function completeSoleOwnerInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  const input = blankInput();
  fillHumanNumericDecisions(input);
  input.governanceModel = 'SOLE_OWNER_SELF_APPROVAL';
  input.ownerIdentity = 'SOLE_OWNER_HUMAN';
  input.releaseApprover = 'SOLE_OWNER_HUMAN';
  input.riskApprover = 'SOLE_OWNER_HUMAN';
  input.settlementReviewer = 'SOLE_OWNER_HUMAN';
  input.soleOwnerSelfApproval = true;
  input.independentReview = false;
  input.independentReviewRequired = false;
  input.humanFinalAuthority = true;
  return input;
}

function completeMultiApproverInput(): PublicForwardPartialFillBusinessToleranceHumanInput {
  const input = blankInput();
  fillHumanNumericDecisions(input);
  input.governanceModel = 'INDEPENDENT_MULTI_APPROVER';
  input.ownerIdentity = 'OWNER_HUMAN';
  input.releaseApprover = 'RELEASE_HUMAN';
  input.riskApprover = 'RISK_HUMAN';
  input.settlementReviewer = 'SETTLEMENT_HUMAN';
  input.soleOwnerSelfApproval = false;
  input.independentReview = true;
  input.independentReviewRequired = true;
  input.humanFinalAuthority = true;
  return input;
}

function setSoleOwnerIdentity(
  input: PublicForwardPartialFillBusinessToleranceHumanInput,
  identity: string,
): void {
  input.ownerIdentity = identity;
  input.releaseApprover = identity;
  input.riskApprover = identity;
  input.settlementReviewer = identity;
}

function expectPlaceholderIdentityFailure(identity: string): void {
  const input = completeSoleOwnerInput();
  setSoleOwnerIdentity(input, identity);
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'INCOMPLETE');
  assert.ok(result.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN'));
}

test('blank human form remains fail-closed without numeric or governance defaults', () => {
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, blankInput());
  assert.equal(result.evidenceVersion, PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_EVIDENCE_VERSION);
  assert.equal(result.validationStatus, 'INCOMPLETE');
  assert.equal(result.firstZero, 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED');
  assert.equal(result.rootCauseClass, 'HUMAN_GOVERNANCE_DECISION_INVALID');
  assert.equal(result.numericValuesFrozen, false);
  assert.equal(result.productionAuthority, false);
  assert.ok(result.validationErrors.includes('GOVERNANCE_MODEL_REQUIRED'));
  assert.ok(result.validationErrors.includes('TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE_VALUE_MISSING_OR_INVALID'));
});

test('valid sole-owner triple-role input passes governance validation', () => {
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput());
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.equal(result.firstZero, null);
  assert.equal(result.rootCauseClass, null);
  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.humanInput.ownerIdentity, 'SOLE_OWNER_HUMAN');
  assert.equal(result.humanInput.releaseApprover, result.humanInput.ownerIdentity);
  assert.equal(result.humanInput.riskApprover, result.humanInput.ownerIdentity);
  assert.equal(result.humanInput.settlementReviewer, result.humanInput.ownerIdentity);
});

test('sole-owner identity mismatch fails closed', () => {
  const input = completeSoleOwnerInput();
  input.riskApprover = 'DIFFERENT_HUMAN';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('SOLE_OWNER_APPROVER_IDENTITY_MISMATCH'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('sole-owner missing owner fails closed', () => {
  const input = completeSoleOwnerInput();
  input.ownerIdentity = null;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('OWNER_IDENTITY_REQUIRED'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('sole-owner independent-review=true is contradictory', () => {
  const input = completeSoleOwnerInput();
  input.independentReview = true;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION'));
});

test('sole-owner independent-review-required=true is contradictory', () => {
  const input = completeSoleOwnerInput();
  input.independentReviewRequired = true;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('SOLE_OWNER_INDEPENDENT_REVIEW_CONTRADICTION'));
});

test('multi-approver identical release/risk identities fail closed', () => {
  const input = completeMultiApproverInput();
  input.riskApprover = input.releaseApprover;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('MULTI_APPROVER_DISTINCTNESS_REQUIRED'));
  assert.ok(result.validationErrors.includes('SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('multi-approver distinct valid identities pass governance validation', () => {
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeMultiApproverInput());
  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
});

test('missing governance model fails without inferring legacy inputs', () => {
  const input = completeSoleOwnerInput();
  delete input.governanceModel;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('GOVERNANCE_MODEL_REQUIRED'));
  assert.equal(result.firstZero, 'BUSINESS_TOLERANCE_GOVERNANCE_NOT_APPROVED');
});

test('placeholder and AI/BOT identities fail governance validation', () => {
  const input = completeSoleOwnerInput();
  input.ownerIdentity = '<OWNER>';
  input.releaseApprover = 'AI';
  input.riskApprover = 'BOT';
  input.settlementReviewer = 'ChatGPT';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('governance changes alter canonical evidence digest', () => {
  const first = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput());
  const changedInput = completeSoleOwnerInput();
  changedInput.independentReview = true;
  const second = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, changedInput);
  assert.notEqual(first.digest, second.digest);
  const { digest: firstDigest, ...firstBody } = first;
  assert.equal(firstDigest, computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(firstBody));
});

test('valid governance never freezes business tolerance policy', () => {
  const soleOwner = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput());
  const multiApprover = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeMultiApproverInput());
  for (const result of [soleOwner, multiApprover]) {
    assert.equal(result.numericValuesFrozen, false);
    assert.equal(result.frozenBusinessToleranceArtifactProduced, false);
    assert.equal(result.statisticalNumericizationAllowed, false);
  }
});

test('valid governance never grants Production or trading authority', () => {
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, completeSoleOwnerInput());
  assert.equal(result.productionAuthority, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.productionPolicyAuthorityConnected, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.executionAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.privateApiAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.liveTrading, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.orderSubmissionAllowed, false);
});

test('non-governance contamination declarations remain fail-closed', () => {
  const input = completeSoleOwnerInput();
  input.declarations.profitabilityOutcomeConsulted = true;
  input.declarations.currentN1UsedToSelectValues = true;
  input.declarations.aiNumericAuthority = 'AI';
  input.declarations.prospectiveOnly = false;
  input.declarations.executionAuthority = 'LIVE';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('CURRENT_N1_VALUE_SELECTION_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('AI_NUMERIC_AUTHORITY_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('PROSPECTIVE_ONLY_REQUIRED'));
  assert.ok(result.validationErrors.includes('EXECUTION_AUTHORITY_FORBIDDEN'));
});

test('safety contract explicitly scopes same-person approval to sole-owner governance', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.numericDefaultsAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.aiNumericAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.governanceModelRequired, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.soleOwnerSelfApprovalSupported, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.singleApproverSelfAuthorizationRequiresExplicitSoleOwnerGovernance, true);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.frozenArtifactProduced, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.executionAuthority, 'NONE');
});

test('approved additional generic, automation, and template identity forms fail closed', () => {
  for (const identity of [
    'TODO', 'UNSET', 'N/A', 'NA', 'TEST', 'TESTUSER', 'DUMMY_USER', 'SAMPLE', 'SAMPLE_USER',
    'EXAMPLE', 'EXAMPLE_USER', 'OPENAI', 'ASSISTANT', 'AUTOMATION', 'AI_REVIEWER', 'BOT-REVIEWER',
    'SYSTEM REVIEWER', '{OWNER}', '{APPROVER}', '{NAME}', '{USER}', '${OWNER}', '${APPROVER}',
  ]) {
    expectPlaceholderIdentityFailure(identity);
  }
});

test('T01 valid sole-owner 이승재 triple-role PASS', () => {
  const input = completeSoleOwnerInput();
  setSoleOwnerIdentity(input, '이승재');
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.deepEqual(result.validationErrors, []);
});

test('T02 valid distinct multi-approver identities PASS', () => {
  const input = completeMultiApproverInput();
  input.ownerIdentity = 'Minseo Park';
  input.releaseApprover = 'Jisoo Han';
  input.riskApprover = 'Daniel Kim';
  input.settlementReviewer = 'Sora Lee';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.deepEqual(result.validationErrors, []);
});

test('T03 owner empty FAIL', () => {
  const input = completeSoleOwnerInput();
  input.ownerIdentity = '';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('OWNER_IDENTITY_REQUIRED'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('T04 release empty FAIL', () => {
  const input = completeSoleOwnerInput();
  input.releaseApprover = '';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('RELEASE_APPROVER_MISSING'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('T05 risk whitespace-only FAIL', () => {
  const input = completeSoleOwnerInput();
  input.riskApprover = '   ';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('RISK_APPROVER_MISSING'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('T06 settlement missing FAIL', () => {
  const input = completeSoleOwnerInput();
  input.settlementReviewer = null;
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('SETTLEMENT_REVIEWER_MISSING'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('T07 PLACEHOLDER FAIL', () => expectPlaceholderIdentityFailure('PLACEHOLDER'));
test('T08 placeholder FAIL', () => expectPlaceholderIdentityFailure('placeholder'));
test('T09 TEST_USER FAIL', () => expectPlaceholderIdentityFailure('TEST_USER'));
test('T10 TBD FAIL', () => expectPlaceholderIdentityFailure('TBD'));
test('T11 UNKNOWN FAIL', () => expectPlaceholderIdentityFailure('UNKNOWN'));
test('T12 DUMMY FAIL', () => expectPlaceholderIdentityFailure('DUMMY'));
test('T13 AI FAIL', () => expectPlaceholderIdentityFailure('AI'));
test('T14 BOT FAIL', () => expectPlaceholderIdentityFailure('BOT'));
test('T15 ChatGPT FAIL', () => expectPlaceholderIdentityFailure('ChatGPT'));
test('T16 SYSTEM FAIL', () => expectPlaceholderIdentityFailure('SYSTEM'));
test('T17 <OWNER> FAIL', () => expectPlaceholderIdentityFailure('<OWNER>'));
test('T18 <APPROVER> FAIL', () => expectPlaceholderIdentityFailure('<APPROVER>'));
test('T19 이승재1 FAIL', () => expectPlaceholderIdentityFailure('이승재1'));
test('T20 이승재2 FAIL', () => expectPlaceholderIdentityFailure('이승재2'));

test('T21 legitimate human Latin-name fixture PASS', () => {
  const input = completeSoleOwnerInput();
  setSoleOwnerIdentity(input, 'Aiko Botkin');
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.deepEqual(result.validationErrors, []);
});

test('T22 legitimate human Korean-name fixture PASS', () => {
  const input = completeSoleOwnerInput();
  setSoleOwnerIdentity(input, '김민수');
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.deepEqual(result.validationErrors, []);
});

test('T23 case and whitespace normalization preserves valid sole-owner equality PASS', () => {
  const input = completeSoleOwnerInput();
  input.ownerIdentity = '  Alice Smith  ';
  input.releaseApprover = 'alice smith';
  input.riskApprover = 'ALICE   SMITH';
  input.settlementReviewer = 'Alice Smith ';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.deepEqual(result.validationErrors, []);
});

test('T24 distinct identities with one TEST_USER FAIL', () => {
  const input = completeMultiApproverInput();
  input.ownerIdentity = 'Owner Person';
  input.releaseApprover = 'Release Person';
  input.riskApprover = 'TEST_USER';
  input.settlementReviewer = 'Settlement Person';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('PLACEHOLDER_APPROVER_FORBIDDEN'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});

test('T25 two valid but identical humans FAIL multi-approver distinctness', () => {
  const input = completeMultiApproverInput();
  input.releaseApprover = 'Jordan Lee';
  input.riskApprover = '  jordan   lee  ';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('MULTI_APPROVER_DISTINCTNESS_REQUIRED'));
  assert.ok(result.validationErrors.includes('SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN'));
  assert.equal(result.validationStatus, 'INCOMPLETE');
});
