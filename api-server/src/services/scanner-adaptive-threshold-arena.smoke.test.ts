import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAdaptiveThresholdCandidates,
  compareAdaptiveThresholds,
  passesMinimalHardGate,
  researchRegimeAdaptiveThresholds,
  type AdaptiveThresholdObservation,
} from './scanner-adaptive-threshold-arena.service';

function sample(
  id: string,
  regime: string,
  softScore: number,
  sequence: number,
  netEquityReturn: number | null,
  hardPass = true,
): AdaptiveThresholdObservation {
  return {
    id,
    market: 'KR',
    strategy: 'SCALPING',
    regime,
    softScore,
    hardGate: {
      dataQualityPassed: hardPass,
      liquidityPassed: hardPass,
      safetyPassed: hardPass,
    },
    outcome: {
      sequence,
      resolved: netEquityReturn != null,
      netEquityReturn,
    },
  };
}

test('soft score does not become a hard gate', () => {
  assert.equal(passesMinimalHardGate(sample('low', 'RANGE', 1, 1, 0.01)), true);
  assert.equal(passesMinimalHardGate(sample('blocked', 'RANGE', 99, 2, 0.01, false)), false);
});

test('threshold comparison keeps hard gate fixed and compares 1M results plus missed opportunities', () => {
  const rows = compareAdaptiveThresholds({
    observations: [
      sample('A', 'TREND', 90, 1, 0.10),
      sample('B', 'TREND', 80, 2, -0.05),
      sample('C', 'TREND', 70, 3, 0.20),
      sample('BLOCKED', 'TREND', 99, 4, 0.50, false),
    ],
    thresholds: [70, 80, 90],
    initialCapitalKrw: 1_000_000,
    constraints: { maxDrawdownPercent: 20, minimumResolvedTrades: 1 },
  });
  const row = rows.find((item) => item.threshold === 80);
  assert.ok(row);
  assert.equal(row.hardGatePassCount, 3);
  assert.equal(row.candidateCount, 2);
  assert.equal(row.resolvedTradeCount, 2);
  assert.equal(row.finalEquityKrw, 1_045_000);
  assert.equal(row.maxDrawdownPercent, 5);
  assert.equal(row.netProfitableRatePercent, 50);
  assert.equal(row.goodTradeMissedCount, 1);
});

test('regime threshold selection is independent and fails closed on insufficient samples', () => {
  const result = researchRegimeAdaptiveThresholds({
    observations: [
      sample('T1', 'TREND', 90, 1, 0.12),
      sample('T2', 'TREND', 80, 2, -0.08),
      sample('T3', 'TREND', 70, 3, -0.05),
      sample('R1', 'RANGE', 90, 4, -0.06),
      sample('R2', 'RANGE', 80, 5, 0.10),
      sample('R3', 'RANGE', 70, 6, 0.08),
    ],
    thresholds: [70, 80, 90],
    constraints: { maxDrawdownPercent: 20, minimumResolvedTrades: 1 },
  });
  assert.equal(result.byRegime.find((item) => item.regime === 'TREND')?.selectedThreshold, 90);
  assert.equal(result.byRegime.find((item) => item.regime === 'RANGE')?.selectedThreshold, 70);

  const insufficient = researchRegimeAdaptiveThresholds({
    observations: [sample('U1', 'PANIC', 95, 1, null)],
    thresholds: [60, 70, 80, 90],
    constraints: { maxDrawdownPercent: 10, minimumResolvedTrades: 2 },
  }).byRegime[0];
  assert.equal(insufficient.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(insufficient.selectedThreshold, null);
});

test('S A B WATCH and near-miss classification never fills missing candidates', () => {
  const displayed = classifyAdaptiveThresholdCandidates({
    observations: [
      sample('S', 'TREND', 95, 1, 0.01),
      sample('A', 'TREND', 87, 2, 0.01),
      sample('B', 'TREND', 81, 3, 0.01),
      sample('NM', 'TREND', 78, 4, 0.01),
      sample('WATCH', 'TREND', 60, 5, 0.01),
      sample('HARD', 'TREND', 100, 6, 0.01, false),
    ],
    threshold: 80,
    policy: { sMargin: 12, aMargin: 5, nearMissBand: 5 },
    limit: 10,
  });
  assert.deepEqual(displayed.map((item) => [item.id, item.grade, item.nearMiss]), [
    ['S', 'S', false],
    ['A', 'A', false],
    ['B', 'B', false],
    ['NM', 'WATCH', true],
    ['WATCH', 'WATCH', false],
  ]);
  assert.equal(displayed.length, 5);
});
