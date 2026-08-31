import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY,
  PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS,
  buildPublicForwardPartialFillBusinessToleranceDecisionEvidence,
  computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest,
  type PublicForwardPartialFillBusinessToleranceHumanInput,
} from './public-forward-partial-fill-business-tolerance-decision-evidence.service';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const context = {
  schemaVersion: '1',
  businessToleranceIdentity: PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_IDENTITY,
  businessToleranceVersion: 'test-only-v1',
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
    releaseApprover: null,
    riskApprover: null,
    settlementReviewer: null,
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

test('blank human form remains fail-closed without invented numeric defaults', () => {
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, blankInput());
  assert.equal(result.validationStatus, 'INCOMPLETE');
  assert.equal(result.firstZero, 'BUSINESS_TOLERANCE_VALUES_NOT_APPROVED');
  assert.equal(result.rootCauseClass, 'HUMAN_RISK_NUMERIC_DECISION_MISSING');
  assert.equal(result.numericValuesFrozen, false);
  assert.equal(result.productionAuthority, false);
  assert.ok(result.validationErrors.includes('TOL01_OPPORTUNITY_PRIMARY_ERROR_TOLERANCE_VALUE_MISSING_OR_INVALID'));
});

test('complete human decision is validated but is not frozen or promoted', () => {
  const input = blankInput();
  for (const key of PUBLIC_FORWARD_PARTIAL_FILL_TOLERANCE_KEYS) input.tolerances[key] = { value: 123, unit: 'TEST_ONLY_UNIT' };
  input.tailQuantile = { value: 123, unit: 'TEST_ONLY_UNIT' };
  input.meaningfulFailureEffectSize = { value: 123, unit: 'TEST_ONLY_UNIT' };
  input.releaseApprover = 'TEST_ONLY_RELEASE_APPROVER';
  input.riskApprover = 'TEST_ONLY_DISTINCT_RISK_APPROVER';
  input.settlementReviewer = 'TEST_ONLY_SETTLEMENT_REVIEWER';
  input.decisionBasisReference = 'TEST_ONLY_REFERENCE';
  input.approvalTimestamp = '2026-08-31T00:00:00.000Z';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.equal(result.validationStatus, 'COMPLETE_AWAITING_FREEZE');
  assert.equal(result.firstZero, null);
  assert.deepEqual(result.validationErrors, []);
  assert.equal(result.numericValuesFrozen, false);
  assert.equal(result.frozenBusinessToleranceArtifactProduced, false);
  assert.equal(result.statisticalNumericizationAllowed, false);
  assert.equal(result.productionAuthority, false);
  const { digest: resultDigest, ...body } = result;
  assert.equal(resultDigest, computePublicForwardPartialFillBusinessToleranceDecisionEvidenceDigest(body));
});

test('governance declarations and distinct approvers fail closed', () => {
  const input = blankInput();
  input.releaseApprover = 'SAME';
  input.riskApprover = 'SAME';
  input.declarations.profitabilityOutcomeConsulted = true;
  input.declarations.currentN1UsedToSelectValues = true;
  input.declarations.aiNumericAuthority = 'AI';
  input.declarations.prospectiveOnly = false;
  input.declarations.executionAuthority = 'LIVE';
  const result = buildPublicForwardPartialFillBusinessToleranceDecisionEvidence(context, input);
  assert.ok(result.validationErrors.includes('SINGLE_APPROVER_SELF_AUTHORIZATION_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('PROFITABILITY_OUTCOME_CONSULTED_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('CURRENT_N1_VALUE_SELECTION_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('AI_NUMERIC_AUTHORITY_FORBIDDEN'));
  assert.ok(result.validationErrors.includes('PROSPECTIVE_ONLY_REQUIRED'));
  assert.ok(result.validationErrors.includes('EXECUTION_AUTHORITY_FORBIDDEN'));
});

test('safety contract preserves zero authority and economic truth', () => {
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.numericDefaultsAllowed, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.aiNumericAuthority, 'NONE');
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.frozenArtifactProduced, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.fullCostReady, false);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.evidenceComplete, 0);
  assert.equal(PUBLIC_FORWARD_PARTIAL_FILL_BUSINESS_TOLERANCE_DECISION_SAFETY.executionAuthority, 'NONE');
});
