import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateAllocatorShadowLeague,
  evaluateEvidenceWeightedCapital,
  type EvidenceCapitalInput,
} from './evidence-weighted-capital-allocation';

function validEvidence(overrides: Partial<EvidenceCapitalInput> = {}): EvidenceCapitalInput {
  return {
    evidenceSource: 'FORWARD_PAPER',
    afterCostExpectancyPercent: 0.35,
    profitFactor: 1.4,
    maximumDrawdownPercent: 6,
    settledSampleSize: 240,
    effectiveSampleSize: 180,
    regimeCount: 4,
    predictionCollapse: false,
    validatedChampion: true,
    strategyHealth: 'HEALTHY',
    calibrationHealthy: true,
    dataHealthy: true,
    executionFeasible: true,
    ...overrides,
  };
}

test('evidence capital allocation fails closed without forward evidence', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ evidenceSource: 'BACKTEST' }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.safeCapitalState, 'CASH_OR_NO_TRADE');
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('NON_FORWARD_EVIDENCE'));
});

test('holdout-only evidence cannot receive paper capital', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ evidenceSource: 'HOLDOUT' }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('NON_FORWARD_EVIDENCE'));
});

test('non-positive after-cost expectancy fails closed', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ afterCostExpectancyPercent: 0 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('EXPECTANCY_NOT_POSITIVE'));
});

test('profit factor must be above one', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ profitFactor: 1 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('PROFIT_FACTOR_NOT_ABOVE_ONE'));
});

test('prediction collapse forces cash or no trade', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ predictionCollapse: true }));
  assert.equal(result.safeCapitalState, 'CASH_OR_NO_TRADE');
  assert.ok(result.blockers.includes('PREDICTION_COLLAPSE'));
});

test('missing validated champion forces zero allocation', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ validatedChampion: false }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('CHAMPION_NOT_VALIDATED'));
});

test('insufficient effective samples force zero allocation', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ effectiveSampleSize: 99 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('INSUFFICIENT_EFFECTIVE_SAMPLES'));
});

test('effective sample size cannot exceed settled sample size', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ settledSampleSize: 120, effectiveSampleSize: 121 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('INSUFFICIENT_EFFECTIVE_SAMPLES'));
});

test('excessive drawdown forces zero allocation', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ maximumDrawdownPercent: 15.01 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('MDD_MISSING_OR_EXCESSIVE'));
});

test('insufficient regime coverage forces zero allocation', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence({ regimeCount: 2 }));
  assert.equal(result.paperCapitalWeight, 0);
  assert.ok(result.blockers.includes('INSUFFICIENT_REGIME_COVERAGE'));
});

test('unhealthy strategy, calibration, data, or execution force zero allocation', () => {
  for (const override of [
    { strategyHealth: 'DEGRADED' as const },
    { calibrationHealthy: false },
    { dataHealthy: false },
    { executionFeasible: false },
  ]) {
    const result = evaluateEvidenceWeightedCapital(validEvidence(override));
    assert.equal(result.paperCapitalWeight, 0);
    assert.equal(result.liveCapitalWeight, 0);
  }
});

test('fully valid synthetic forward evidence allows only bounded paper capital', () => {
  const result = evaluateEvidenceWeightedCapital(validEvidence());
  assert.equal(result.status, 'CAPITAL_ELIGIBLE_PAPER_ONLY');
  assert.equal(result.safeCapitalState, 'PAPER_CAPITAL_ELIGIBLE');
  assert.ok(result.paperCapitalWeight > 0);
  assert.ok(result.paperCapitalWeight <= 0.25);
  assert.equal(result.liveCapitalWeight, 0);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderAuthority, 'none');
});

test('allocator shadow league does not promote with insufficient paired outcomes', () => {
  const result = evaluateAllocatorShadowLeague(Array.from({ length: 25 }, (_, index) => ({
    opportunityId: `op-${index}`,
    settled: true,
    baselineAfterCostReturnPercent: 0,
    candidateAfterCostReturnPercent: index % 2 === 0 ? 0.4 : -0.1,
  })));
  assert.equal(result.status, 'INSUFFICIENT_PAIRED_EVIDENCE');
  assert.equal(result.promotionEligible, false);
  assert.equal(result.liveTradingAllowed, false);
});

test('allocator shadow league rejects sufficient samples when candidate after-cost edge is not better', () => {
  const result = evaluateAllocatorShadowLeague(Array.from({ length: 120 }, (_, index) => ({
    opportunityId: `op-${index}`,
    settled: true,
    baselineAfterCostReturnPercent: 0.2,
    candidateAfterCostReturnPercent: index % 2 === 0 ? 0.3 : -0.2,
  })));
  assert.equal(result.status, 'NO_PROMOTION');
  assert.equal(result.promotionEligible, false);
});

test('allocator shadow league promotes only a sufficient after-cost paired winner and remains paper only', () => {
  const result = evaluateAllocatorShadowLeague(Array.from({ length: 120 }, (_, index) => ({
    opportunityId: `op-${index}`,
    settled: true,
    baselineAfterCostReturnPercent: 0,
    candidateAfterCostReturnPercent: index % 4 === 0 ? -0.2 : 0.3,
  })));
  assert.equal(result.pairedSettledSampleSize, 120);
  assert.equal(result.status, 'PROMOTION_ELIGIBLE_PAPER_ONLY');
  assert.equal(result.promotionEligible, true);
  assert.ok(result.candidateExpectancyPercent > 0);
  assert.ok((result.candidateProfitFactor ?? 0) > 1);
  assert.ok(result.incrementalExpectancyPercent > 0);
  assert.equal(result.liveTradingAllowed, false);
  assert.equal(result.privateTradingApiAllowed, false);
  assert.equal(result.orderAuthority, 'none');
});

test('allocator shadow league de-duplicates opportunity ids', () => {
  const duplicate = {
    opportunityId: 'same-opportunity',
    settled: true,
    baselineAfterCostReturnPercent: 0,
    candidateAfterCostReturnPercent: 1,
  };
  const result = evaluateAllocatorShadowLeague([duplicate, duplicate], { minimumPairedSettledSamples: 2, minimumIncrementalExpectancyPercent: 0 });
  assert.equal(result.pairedSettledSampleSize, 1);
  assert.equal(result.status, 'INSUFFICIENT_PAIRED_EVIDENCE');
});
