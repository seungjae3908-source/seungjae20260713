import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMicrocapDiagnostic,
  assessMicrocapPitRiskGate,
  buildMicrocapResearchTaskPlan,
} from '../src/microcap-task.mjs';

const SHA = 'a'.repeat(40);

function diagnostic(overrides = {}) {
  return {
    status: 'RECENT_EXTENDED_HOURS_DIAGNOSTIC_ONLY',
    source: 'Yahoo public chart 1m range=7d includePrePost=true',
    validationState: {
      extendedHoursBars: true,
      vwap: true,
      firstPullback: true,
      rebreak: true,
      volumeReacceleration: true,
      ladderExit: true,
      breakevenVwapProtection: true,
      timeStop: true,
      tenYearMinuteHistory: false,
      pointInTimeFloat: false,
      archivedFreshCatalyst: false,
      pointInTimeDilutionOfferingFilter: false,
    },
    ...overrides,
  };
}

function pitGate(overrides = {}) {
  return {
    status: 'DATA_BLOCKED_PIT_RISK_EVIDENCE',
    counts: { eligible: 0, rejected: 0, blocked: 8 },
    pointInTimeRiskGate: true,
    canonicalEvidenceEligible: false,
    canonicalSampleDelta: 0,
    ...overrides,
  };
}

test('microcap task plan is research-only, requires PIT gate, and never grants canonical sample credit', () => {
  const plan = buildMicrocapResearchTaskPlan({ researchSha: SHA });
  assert.equal(plan.id, 'us-microcap-recent-intraday-diagnostic');
  assert.equal(plan.runtime, 'python3');
  assert.equal(plan.steps.length, 3);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'sec-dilution-contract-self-test',
    'recent-intraday-ladder',
    'point-in-time-risk-gate',
  ]);
  assert.equal(plan.canonicalEvidenceEligible, false);
  assert.equal(plan.canonicalSampleDelta, 0);
  assert.equal(plan.liveTrading, false);
  assert.equal(plan.privateApi, false);
  assert.equal(plan.orderAuthority, false);
});

test('recent Yahoo microcap diagnostic stays DATA_BLOCKED for promotion-quality validation', () => {
  const result = assessMicrocapDiagnostic(diagnostic());
  assert.equal(result.status, 'DATA_BLOCKED');
  assert.equal(result.promotionEvidenceEligible, false);
  assert.equal(result.canonicalEvidenceEligible, false);
  assert.equal(result.canonicalSampleDelta, 0);
  assert.equal(result.duplicateCountingAllowed, false);
  assert.deepEqual(result.dataBlocked, [
    'TEN_YEAR_ALL_SESSION_MINUTE_HISTORY_MISSING',
    'POINT_IN_TIME_FLOAT_MISSING',
    'ARCHIVED_FRESH_CATALYST_MISSING',
    'POINT_IN_TIME_DILUTION_FILTER_MISSING',
  ]);
});

test('even complete prerequisite flags cannot relabel recent diagnostic as canonical profitability evidence', () => {
  const result = assessMicrocapDiagnostic(diagnostic({
    validationState: {
      tenYearMinuteHistory: true,
      pointInTimeFloat: true,
      archivedFreshCatalyst: true,
      pointInTimeDilutionOfferingFilter: true,
    },
  }));
  assert.equal(result.status, 'DIAGNOSTIC_COMPLETE');
  assert.deepEqual(result.dataBlocked, []);
  assert.equal(result.promotionEvidenceEligible, false);
  assert.equal(result.canonicalEvidenceEligible, false);
  assert.equal(result.canonicalSampleDelta, 0);
});

test('PIT risk gate blocks missing point-in-time manifests without sample credit', () => {
  const result = assessMicrocapPitRiskGate(pitGate());
  assert.equal(result.status, 'DATA_BLOCKED_PIT_RISK_EVIDENCE');
  assert.equal(result.blocked, 8);
  assert.equal(result.rejected, 0);
  assert.equal(result.eligible, 0);
  assert.equal(result.dataBlocked, true);
  assert.equal(result.canonicalEvidenceEligible, false);
  assert.equal(result.canonicalSampleDelta, 0);
});

test('evaluated PIT risk gate remains research-only even when entries become eligible', () => {
  const result = assessMicrocapPitRiskGate(pitGate({
    status: 'PIT_RISK_GATE_EVALUATED',
    counts: { eligible: 3, rejected: 2, blocked: 0 },
  }));
  assert.equal(result.dataBlocked, false);
  assert.equal(result.eligible, 3);
  assert.equal(result.rejected, 2);
  assert.equal(result.canonicalEvidenceEligible, false);
  assert.equal(result.canonicalSampleDelta, 0);
});

test('PIT gate cannot grant canonical sample credit or use unknown status', () => {
  assert.throws(
    () => assessMicrocapPitRiskGate(pitGate({ canonicalEvidenceEligible: true })),
    /never grant canonical sample credit/,
  );
  assert.throws(
    () => assessMicrocapPitRiskGate(pitGate({ status: 'PROFITABILITY_PROVEN' })),
    /unexpected PIT risk-gate status/,
  );
});

test('unexpected result status fails closed', () => {
  assert.throws(() => assessMicrocapDiagnostic({ status: 'PROFITABILITY_PROVEN', validationState: {} }), /unexpected microcap diagnostic status/);
});

test('task plan requires an immutable exact SHA', () => {
  assert.throws(() => buildMicrocapResearchTaskPlan({ researchSha: 'main' }), /exact 40-character research SHA/);
});
