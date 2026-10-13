import test from 'node:test';
import assert from 'node:assert/strict';

import {
  StrategyPromotionService,
  strategyCandidateId,
} from './strategy-promotion.service';
import {
  buildResearchPromotionBridge,
} from './strategy-promotion-research-bridge.service';

const SHA = '1111111111111111111111111111111111111111';
const NOW = new Date('2026-08-13T00:00:00.000Z');
const STRATEGY = 'CRYPTO_FUTURES_SCALP_V1_LONG';

function researchOverview(candidatePerformance: Record<string, unknown> | null, safetyOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    safety: {
      readOnlyDashboard: true,
      liveTrading: false,
      privateApi: false,
      orderAuthority: false,
      forbiddenAuthorityObserved: false,
      ...safetyOverrides,
    },
    paper: { candidatePerformance },
  };
}

function promotionRecord() {
  const record = new StrategyPromotionService({ sourceSha: SHA, now: () => NOW }).get(STRATEGY);
  assert.ok(record);
  return record;
}

function trainingCandidate(overrides: Record<string, unknown> = {}) {
  const record = promotionRecord();
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'frozen-candidate-performance-reader-v1',
    identity14Verified: true,
    promotionIdentity: {
      candidateId: strategyCandidateId(record.identity),
      strategyId: record.identity.strategyId,
      strategyVersion: record.identity.strategyVersion,
      parameterHash: record.identity.parameterHash,
      researchCodeSha: record.identity.researchCodeSha,
      market: record.identity.market,
      timeframe: record.identity.timeframe,
      sidePolicy: record.identity.direction,
      accountMode: 'PAPER',
      costPolicyVersion: record.identity.costPolicyVersion,
      executionPolicyVersion: 'PAPER_EXECUTION_POLICY_V1',
    },
    TRAIN_N: 12,
    VALIDATION_N: 0,
    OOS_N: 0,
    Settlement_N: 0,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    Net_PnL: null,
    executionAuthority: 'NONE',
    ...overrides,
  };
}

test('exact Scanner identity maps but current frozen evidence remains RESEARCH_ONLY', () => {
  const bridge = buildResearchPromotionBridge(
    researchOverview(trainingCandidate()),
    SHA,
    NOW.toISOString(),
  );

  assert.equal(bridge.status, 'RESEARCH_ONLY');
  assert.equal(bridge.candidate?.strategyId, STRATEGY);
  assert.equal(bridge.scannerProfile?.strategyId, STRATEGY);
  assert.equal(bridge.evidence.trainN, 12);
  assert.equal(bridge.evidence.validationN, 0);
  assert.equal(bridge.evidence.oosN, 0);
  assert.deepEqual(
    ['TRAIN_DIAGNOSTIC_ONLY', 'VALIDATION_NOT_COMPLETE', 'OOS_NOT_COMPLETE', 'FULL_COST_NOT_READY', 'PROFITABILITY_NOT_PROVEN']
      .filter((reason) => !bridge.blockers.includes(reason)),
    [],
  );
  assert.equal(bridge.automaticAdoptionAllowed, false);
  assert.equal(bridge.paperHandoffAllowed, false);
  assert.equal(bridge.scannerMutationAllowed, false);
  assert.equal(bridge.liveTradingAllowed, false);
  assert.equal(bridge.privateTradingApiAllowed, false);
  assert.equal(bridge.orderAllowed, false);
  assert.equal(bridge.executionAuthority, 'NONE');
});

test('Validation counts are visible without manufacturing Validation completion or OOS credit', () => {
  const bridge = buildResearchPromotionBridge(
    researchOverview(trainingCandidate({ TRAIN_N: 512, VALIDATION_N: 8 })),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(bridge.status, 'VALIDATION_COLLECTING');
  assert.equal(bridge.evidence.validationN, 8);
  assert.equal(bridge.evidence.validationComplete, false);
  assert.equal(bridge.evidence.oosN, 0);
  assert.equal(bridge.evidence.oosComplete, false);
  assert.equal(bridge.paperHandoffAllowed, false);
});

test('immutable identity mismatch remains UNMAPPED with zero adoption authority', () => {
  const original = trainingCandidate();
  const candidate = {
    ...original,
    promotionIdentity: {
      ...original.promotionIdentity,
      strategyId: 'research-only-strategy-alpha',
      parameterHash: 'f'.repeat(64),
    },
  };
  const bridge = buildResearchPromotionBridge(researchOverview(candidate), SHA, NOW.toISOString());
  assert.equal(bridge.status, 'UNMAPPED');
  assert.equal(bridge.scannerProfile, null);
  assert.ok(bridge.blockers.includes('SCANNER_PROFILE_IDENTITY_UNMAPPED'));
  assert.equal(bridge.automaticAdoptionAllowed, false);
});

test('stale research SHA remains UNMAPPED rather than borrowing current Scanner identity', () => {
  const bridge = buildResearchPromotionBridge(
    researchOverview(trainingCandidate()),
    '2'.repeat(40),
    NOW.toISOString(),
  );
  assert.equal(bridge.status, 'UNMAPPED');
  assert.ok(bridge.blockers.includes('RESEARCH_CODE_SHA_NOT_CURRENT'));
  assert.equal(bridge.paperHandoffAllowed, false);
});

test('unsafe Dashboard authority fails closed', () => {
  const bridge = buildResearchPromotionBridge(
    researchOverview(trainingCandidate(), { orderAuthority: true }),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(bridge.status, 'INVALID');
  assert.ok(bridge.blockers.includes('RESEARCH_DASHBOARD_SAFETY_INVALID'));
  assert.equal(bridge.orderAllowed, false);
});

test('missing candidate is explicit and frozen-candidate authority escalation is rejected', () => {
  const missing = buildResearchPromotionBridge(researchOverview(null), SHA, NOW.toISOString());
  assert.equal(missing.status, 'NO_CANDIDATE');
  assert.equal(missing.candidate, null);

  const escalated = buildResearchPromotionBridge(
    researchOverview(trainingCandidate({ FULL_COST_READY: true, PROFITABILITY_PROVEN: true })),
    SHA,
    NOW.toISOString(),
  );
  assert.equal(escalated.status, 'INVALID');
  assert.ok(escalated.blockers.includes('RESEARCH_CANDIDATE_EVIDENCE_INVALID'));
  assert.equal(escalated.automaticAdoptionAllowed, false);
  assert.equal(escalated.paperHandoffAllowed, false);
});
