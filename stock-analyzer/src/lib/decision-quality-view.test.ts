import assert from 'node:assert/strict';
import test from 'node:test';
import {
  capitalBucketLabel,
  decisionQualityStatus,
  formatPercent,
  orderCapitalHeatmapCells,
  strategyHealthLabel,
  validateDecisionQualityDashboard,
  type DecisionQualityDashboardView,
} from './decision-quality-view';

function fixture(): DecisionQualityDashboardView {
  return {
    health: {
      strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG',
      strategyVersion: 'V1',
      policyVersion: 'STRATEGY_HEALTH_V1',
      status: 'DEGRADED',
      sampleSize: 80,
      minimumSampleSize: 30,
      reasons: ['EXPECTED_VALUE_BELOW_POLICY'],
      worstObservedHitRateGap: -12,
      alertEligible: true,
    },
    counterfactual: {
      sampleSize: 20,
      decisiveSampleSize: 16,
      goodTradeTakenCount: 7,
      badTradeTakenCount: 3,
      badTradeAvoidedCount: 5,
      goodTradeMissedCount: 1,
      neutralOrUnresolvedCount: 4,
      decisionQualityRatePercent: 75,
      observedLossAvoidedPercentSum: 8.2,
      observedUpsideMissedPercentSum: 1.4,
    },
    heatmap: {
      initialCapitalKrw: 1_000_000,
      evidenceStatus: 'PARTIAL',
      allocatedKrw: 1_000_000,
      invariantPassed: true,
      cells: [
        { bucket: 'CASH_RESERVE', allocationKrw: 200_000, allocationPercent: 20, intensity: 0.2, evidenceStatus: 'RESERVE', confidence: null, researchScore: null, warnings: [] },
        { bucket: 'US_STOCK', allocationKrw: 350_000, allocationPercent: 35, intensity: 0.35, evidenceStatus: 'EVIDENCE_READY', confidence: 0.8, researchScore: 0.7, warnings: [] },
        { bucket: 'KR_STOCK', allocationKrw: 250_000, allocationPercent: 25, intensity: 0.25, evidenceStatus: 'VALIDATING', confidence: 0.6, researchScore: 0.6, warnings: [] },
        { bucket: 'CRYPTO_SPOT', allocationKrw: 100_000, allocationPercent: 10, intensity: 0.1, evidenceStatus: 'INSUFFICIENT', confidence: 0.2, researchScore: 0.4, warnings: ['INSUFFICIENT_DATA'] },
        { bucket: 'CRYPTO_FUTURES', allocationKrw: 100_000, allocationPercent: 10, intensity: 0.1, evidenceStatus: 'INSUFFICIENT', confidence: 0.2, researchScore: 0.4, warnings: ['INSUFFICIENT_DATA'] },
      ],
    },
  };
}

test('decision quality view keeps insufficient data explicit and localizes health labels', () => {
  assert.equal(strategyHealthLabel('INSUFFICIENT_DATA'), '데이터 부족');
  assert.equal(strategyHealthLabel('DEGRADED'), '성능 저하');
  assert.equal(formatPercent(null), 'INSUFFICIENT_DATA');
  assert.equal(decisionQualityStatus({ ...fixture().counterfactual, decisiveSampleSize: 0, decisionQualityRatePercent: null }), 'INSUFFICIENT_DATA');
});

test('capital heatmap orders invested lanes by allocation and keeps cash as an explicit final lane', () => {
  const ordered = orderCapitalHeatmapCells(fixture().heatmap.cells);
  assert.deepEqual(ordered.map((cell) => cell.bucket), ['US_STOCK', 'KR_STOCK', 'CRYPTO_FUTURES', 'CRYPTO_SPOT', 'CASH_RESERVE']);
  assert.equal(capitalBucketLabel('CASH_RESERVE'), '현금');
});

test('valid dashboard passes invariant validation without inventing missing metrics', () => {
  assert.deepEqual(validateDecisionQualityDashboard(fixture()), []);
  assert.equal(decisionQualityStatus(fixture().counterfactual), 'MEASURED');
  assert.equal(formatPercent(fixture().health.worstObservedHitRateGap), '-12.0%');
});

test('dashboard fails closed when 1M allocation invariant or sample ranges are inconsistent', () => {
  const invalid = fixture();
  invalid.heatmap.allocatedKrw = 900_000;
  invalid.heatmap.invariantPassed = true;
  invalid.counterfactual.decisiveSampleSize = 99;
  const errors = validateDecisionQualityDashboard(invalid);
  assert.ok(errors.includes('HEATMAP_ALLOCATION_SUM_MISMATCH'));
  assert.ok(errors.includes('HEATMAP_INVARIANT_FLAG_MISMATCH'));
  assert.ok(errors.includes('INVALID_COUNTERFACTUAL_DECISIVE_SAMPLE'));
});
