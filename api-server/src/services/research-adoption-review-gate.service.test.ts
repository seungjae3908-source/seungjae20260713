import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildResearchAdoptionReview,
  type ResearchAdoptionReviewResult,
} from './research-adoption-review-gate.service';
import type { ResearchPromotionBridgeResult } from './strategy-promotion-research-bridge.service';

const NOW = '2026-09-26T10:30:00.000Z';
const GLOBAL_STRATEGY_ID = 'FF2012_DEVELOPED_WML_FIXED_RULE';
const GLOBAL_PARAMETER_HASH = 'a3f88202e563a76c4c4daa8fa135d66ea9cbc29a77de49d9b8f613c7831b735b';
const GLOBAL_RESEARCH_SHA = 'd2680f3b2a4e282ff427fa51e24a66d6ce693370';

function bridge(overrides: Partial<ResearchPromotionBridgeResult> = {}): ResearchPromotionBridgeResult {
  return {
    contract: 'research-promotion-readonly-bridge-v1',
    status: 'PAPER_ADOPTION_REVIEW_READY',
    generatedAt: NOW,
    candidate: {
      candidateId: `phase3-candidate:sha256:${'a'.repeat(64)}`,
      strategyId: GLOBAL_STRATEGY_ID,
      strategyVersion: 'v1',
      parameterHash: GLOBAL_PARAMETER_HASH,
      researchCodeSha: GLOBAL_RESEARCH_SHA,
      market: 'US_STOCK',
      timeframe: '1D',
      sidePolicy: 'LONG',
      accountMode: 'PAPER',
      costPolicyVersion: 'FF_DEVELOPED_MOMENTUM_COST_POLICY_PREHOLDOUT_V1',
      executionPolicyVersion: 'PAPER_EXECUTION_POLICY_V1',
    },
    scannerProfile: {
      strategyId: GLOBAL_STRATEGY_ID,
      parameterHash: GLOBAL_PARAMETER_HASH,
      market: 'US_STOCK',
      timeframe: '1D',
      direction: 'BUY',
      promotionState: 'PAPER_VALIDATED',
    },
    evidence: {
      trainN: 100,
      validationN: 60,
      oosN: 99,
      settlementN: 20,
      fullCostReady: true,
      validationComplete: true,
      oosComplete: true,
      profitabilityProven: true,
    },
    blockers: [],
    automaticAdoptionAllowed: false,
    paperHandoffAllowed: false,
    scannerMutationAllowed: false,
    liveTradingAllowed: false,
    privateTradingApiAllowed: false,
    orderAllowed: false,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

function readyArtifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    phase: 'PRE_HOLDOUT_PROFITABILITY_GATE',
    researchCodeSha: GLOBAL_RESEARCH_SHA,
    sampleAccounting: {
      ourOosN: 99,
      ourWalkForwardN: 99,
      ourHoldoutN: 30,
      ourShadowN: 25,
      ourPaperN: 20,
      ourSettledN: 20,
      observationCountsAreNeverStudyCounts: true,
    },
    costEvidence: {
      allInCostComplete: true,
      admissionGrade: true,
      unresolvedAllInDimensions: [],
    },
    statisticalEvidence: {
      status: 'EVIDENCE_READY',
      decision: { status: 'STATISTICAL_REVIEW_READY', reasons: [] },
    },
    policyEvaluation: {
      status: 'PRE_HOLDOUT_GATE_PASSED',
      everyRequiredGatePassed: true,
      blockers: [],
    },
    candidateIdentityPreview: {
      strategyId: GLOBAL_STRATEGY_ID,
      parameterHash: GLOBAL_PARAMETER_HASH,
      researchCodeSha: GLOBAL_RESEARCH_SHA,
    },
    frozenResearchCandidate: true,
    finalHoldoutProtection: {
      finalHoldoutNotOpened: false,
      numericHoldoutValuesParsed: 30,
      holdoutUsedForSelection: false,
      holdoutUsedForTuning: false,
      holdoutUsedForCalibration: false,
      ourHoldoutN: 30,
      oneShotFinalHoldoutReady: true,
    },
    safety: {
      profitabilityProven: false,
      liveTrading: false,
      autoTrading: false,
      realOrderEnabled: false,
      privateTradingApiAllowed: false,
      scannerEligibility: false,
      shadowActivation: false,
      paperActivation: false,
      executionAuthority: 'NONE',
      actualOrders: 0,
      actualCancels: 0,
      actualAmends: 0,
      actualTransfers: 0,
      actualWithdrawals: 0,
    },
    ...overrides,
  };
}

function assertNoAuthority(result: ResearchAdoptionReviewResult) {
  assert.equal(result.automaticAdoptionAllowed, false);
  assert.equal(result.humanReviewRequired, true);
  assert.equal(result.paperHandoffAllowed, false);
  assert.equal(result.scannerMutationAllowed, false);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderAllowed, false);
  assert.equal(result.executionAuthority, 'NONE');
}

test('current #547 pre-holdout artifact is blocked and never treated as adoption-ready', () => {
  const result = buildResearchAdoptionReview(bridge(), undefined, NOW);
  assert.equal(result.canonicalOwner, '#547');
  assert.notEqual(result.status, 'HUMAN_REVIEW_READY');
  assert.equal(result.evidence.oosN, 99);
  assert.equal(result.evidence.walkForwardN, 99);
  assert.equal(result.evidence.finalHoldoutN, 0);
  assert.equal(result.evidence.paperN, 0);
  assert.equal(result.evidence.settledN, 0);
  assert.equal(result.evidence.allInCostComplete, false);
  assert.equal(result.evidence.admissionGrade, false);
  assert.equal(result.evidence.frozenResearchCandidate, false);
  assertNoAuthority(result);
});

test('global #547 evidence cannot be transferred to a different Research candidate', () => {
  const result = buildResearchAdoptionReview(bridge({
    candidate: {
      ...bridge().candidate!,
      strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG',
      parameterHash: 'b'.repeat(64),
      researchCodeSha: 'c'.repeat(40),
    },
  }), readyArtifact(), NOW);

  assert.equal(result.status, 'CANDIDATE_MISMATCH');
  assert.equal(result.candidateAligned, false);
  assert.ok(result.blockers.includes('GLOBAL_FIREWALL_CANDIDATE_MISMATCH'));
  assert.ok(result.blockers.includes('CROSS_CANDIDATE_EVIDENCE_TRANSFER_FORBIDDEN'));
  assertNoAuthority(result);
});

test('statistical gate failure blocks review even when identity and bridge stages align', () => {
  const artifact = readyArtifact({
    statisticalEvidence: {
      status: 'EVIDENCE_READY',
      decision: { status: 'RESEARCH_HOLD', reasons: ['DSR_BELOW_POLICY'] },
    },
    policyEvaluation: {
      status: 'PRE_HOLDOUT_GATE_FAILED',
      everyRequiredGatePassed: false,
      blockers: ['dsr:FAIL'],
    },
  });
  const result = buildResearchAdoptionReview(bridge(), artifact, NOW);
  assert.equal(result.status, 'STATISTICAL_REVIEW_BLOCKED');
  assert.equal(result.candidateAligned, true);
  assert.ok(result.blockers.includes('STATISTICAL_REVIEW_NOT_CLEARED'));
  assertNoAuthority(result);
});

test('all-in cost or bridge OOS/Full Cost gaps block economic review', () => {
  const result = buildResearchAdoptionReview(
    bridge({
      evidence: {
        ...bridge().evidence,
        fullCostReady: false,
      },
    }),
    readyArtifact({
      costEvidence: {
        allInCostComplete: false,
        admissionGrade: false,
        unresolvedAllInDimensions: ['commission', 'borrow'],
      },
    }),
    NOW,
  );

  assert.equal(result.status, 'ECONOMIC_EVIDENCE_BLOCKED');
  assert.ok(result.blockers.includes('ALL_IN_COST_NOT_ADMISSION_GRADE'));
  assert.ok(result.blockers.includes('BRIDGE_VALIDATION_OOS_FULL_COST_INCOMPLETE'));
  assert.deepEqual(result.evidence.unresolvedCostDimensions, ['commission', 'borrow']);
  assertNoAuthority(result);
});

test('final holdout and Paper/Shadow/Settlement must exist before human review readiness', () => {
  const holdoutBlocked = buildResearchAdoptionReview(
    bridge(),
    readyArtifact({
      sampleAccounting: {
        ourOosN: 99,
        ourWalkForwardN: 99,
        ourHoldoutN: 0,
        ourShadowN: 25,
        ourPaperN: 20,
        ourSettledN: 20,
        observationCountsAreNeverStudyCounts: true,
      },
      finalHoldoutProtection: {
        finalHoldoutNotOpened: true,
        numericHoldoutValuesParsed: 0,
        holdoutUsedForSelection: false,
        holdoutUsedForTuning: false,
        holdoutUsedForCalibration: false,
        ourHoldoutN: 0,
        oneShotFinalHoldoutReady: false,
      },
    }),
    NOW,
  );
  assert.equal(holdoutBlocked.status, 'FINAL_HOLDOUT_BLOCKED');

  const paperBlocked = buildResearchAdoptionReview(
    bridge(),
    readyArtifact({
      sampleAccounting: {
        ourOosN: 99,
        ourWalkForwardN: 99,
        ourHoldoutN: 30,
        ourShadowN: 0,
        ourPaperN: 0,
        ourSettledN: 0,
        observationCountsAreNeverStudyCounts: true,
      },
    }),
    NOW,
  );
  assert.equal(paperBlocked.status, 'PAPER_EVIDENCE_BLOCKED');
  assertNoAuthority(paperBlocked);
});

test('fully aligned evidence reaches human review only, never automatic adoption', () => {
  const result = buildResearchAdoptionReview(bridge(), readyArtifact(), NOW);
  assert.equal(result.status, 'HUMAN_REVIEW_READY');
  assert.equal(result.candidateAligned, true);
  assert.ok(result.blockers.includes('SEPARATE_HUMAN_ADOPTION_REVIEW_REQUIRED'));
  assertNoAuthority(result);
});

test('unsafe artifact authority escalation fails closed', () => {
  const result = buildResearchAdoptionReview(
    bridge(),
    readyArtifact({
      safety: {
        profitabilityProven: true,
        liveTrading: true,
        autoTrading: false,
        realOrderEnabled: false,
        privateTradingApiAllowed: false,
        scannerEligibility: false,
        shadowActivation: false,
        paperActivation: false,
        executionAuthority: 'LIVE',
        actualOrders: 1,
        actualCancels: 0,
        actualAmends: 0,
        actualTransfers: 0,
        actualWithdrawals: 0,
      },
    }),
    NOW,
  );
  assert.equal(result.status, 'INVALID_EVIDENCE');
  assert.ok(result.blockers.includes('PRE_HOLDOUT_SAFETY_INVALID'));
  assertNoAuthority(result);
});
