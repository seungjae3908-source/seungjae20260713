import test from 'node:test';
import assert from 'node:assert/strict';
import { assessMicrocapDiagnostic, buildMicrocapResearchTaskPlan } from '../src/microcap-task.mjs';

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

test('microcap task plan is research-only and never grants canonical sample credit', () => {
  const plan = buildMicrocapResearchTaskPlan({ researchSha: SHA });
  assert.equal(plan.id, 'us-microcap-recent-intraday-diagnostic');
  assert.equal(plan.runtime, 'python3');
  assert.equal(plan.steps.length, 2);
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

test('unexpected result status fails closed', () => {
  assert.throws(() => assessMicrocapDiagnostic({ status: 'PROFITABILITY_PROVEN', validationState: {} }), /unexpected microcap diagnostic status/);
});

test('task plan requires an immutable exact SHA', () => {
  assert.throws(() => buildMicrocapResearchTaskPlan({ researchSha: 'main' }), /exact 40-character research SHA/);
});
