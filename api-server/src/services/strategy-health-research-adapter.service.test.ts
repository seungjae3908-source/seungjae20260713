import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCanonicalStrategyHealth } from './strategy-health-research-adapter.service';

const policy = {
  version: 'STRATEGY_HEALTH_V1',
  minimumSampleSize: 30,
  watch: { expectedValueBelow: 0.15, profitFactorBelow: 1.2, maxDrawdownAtOrAbove: 12, hitRateGapAtOrBelow: -5 },
  degraded: { expectedValueBelow: 0.05, profitFactorBelow: 1, maxDrawdownAtOrAbove: 20, hitRateGapAtOrBelow: -10 },
  critical: { expectedValueBelow: 0, profitFactorBelow: 0.8, maxDrawdownAtOrAbove: 30, hitRateGapAtOrBelow: -20 },
};

function overview(overrides: Record<string, unknown> = {}) {
  return {
    canonicalStrategyHealth: {
      input: {
        strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG', strategyVersion: 'V1', sampleSize: 60,
        expectedValue: 0.3, profitFactor: 1.5, maxDrawdownPercent: 8,
        paperVsBacktestHitRateGap: -1, shadowVsBacktestHitRateGap: -2, liveVsBacktestHitRateGap: null,
      },
      policy,
    },
    safety: { authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
    research: {
      cycles: [
        { profile: 'fast-historical', present: true, status: 'complete', failedCount: 0, tasks: [] },
        {
          profile: 'forward', present: true, status: 'complete', failedCount: 0,
          tasks: [
            { id: 'oos', status: 'success' },
            { id: 'purged-walk-forward', status: 'success' },
            { id: 'final-holdout', status: 'success' },
            { id: 'drift', status: 'success' },
          ],
        },
      ],
    },
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: 2, sampleCount: 60, positionCount: 1, settlementCount: 30 },
    },
    shadow: {
      groups: [{
        name: '15m', collapsed: false, macroF1: 0.55, balancedAccuracy: 0.58,
        bullRecall: 0.6, bearRecall: 0.5, neutralRecall: 0.54,
      }],
    },
    profitability: { proven: true },
    champion: { currentValidatedChampion: { strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG', strategyVersion: 'V1' } },
    ...overrides,
  };
}

test('runtime adapter directly exposes the canonical Strategy Health core result', () => {
  const healthy = bindCanonicalStrategyHealth(overview());
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.canonicalCoreStatus, 'HEALTHY');
  assert.equal(healthy.inputs.canonicalCore.source, 'strategy-health-observatory.service/evaluateStrategyHealth');
  assert.equal(healthy.inputs.canonicalCore.observedCount, 60);
  assert.equal(healthy.executionAuthority, 'NONE');

  const watch = bindCanonicalStrategyHealth(overview({
    canonicalStrategyHealth: {
      input: { ...overview().canonicalStrategyHealth.input, expectedValue: 0.1 },
      policy,
    },
  }));
  assert.equal(watch.status, 'WATCH');
  assert.equal(watch.canonicalCoreStatus, 'WATCH');
});

test('missing canonical input stays MISSING_EVIDENCE without a fabricated zero or PASS', () => {
  const result = bindCanonicalStrategyHealth(overview({
    canonicalStrategyHealth: undefined,
    paper: {
      runtime: { present: true, safetyEvidenceComplete: true },
      ledger: { present: true, cycleCount: null, sampleCount: null, positionCount: null, settlementCount: null },
    },
  }));
  assert.equal(result.status, 'MISSING_EVIDENCE');
  assert.equal(result.canonicalCoreStatus, null);
  assert.equal(result.inputs.canonicalCore.observedCount, null);
  assert.equal(result.inputs.naturalPaper.observedCount, null);
  assert.notEqual(result.status, 'HEALTHY');
});

test('Shadow directional collapse propagates FAIL through the canonical adapter', () => {
  const result = bindCanonicalStrategyHealth(overview({
    shadow: {
      groups: [{
        name: '15m', collapsed: true, macroF1: 0.31, balancedAccuracy: 0.34,
        bullRecall: 0.8, bearRecall: 0, neutralRecall: 0.22,
      }],
    },
  }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.inputs.shadowQuality.status, 'FAIL');
  assert.ok(result.reasons.includes('shadowQuality:SHADOW_DIRECTIONAL_RECALL_ZERO_OR_COLLAPSED'));
});

test('profitability false and Champion NONE remain explicit missing evidence', () => {
  const profitability = bindCanonicalStrategyHealth(overview({ profitability: { proven: false } }));
  assert.equal(profitability.status, 'MISSING_EVIDENCE');
  assert.equal(profitability.inputs.profitability.reason, 'PROFITABILITY_NOT_PROVEN');

  const champion = bindCanonicalStrategyHealth(overview({ champion: { currentValidatedChampion: null } }));
  assert.equal(champion.status, 'MISSING_EVIDENCE');
  assert.equal(champion.inputs.champion.reason, 'CURRENT_VALIDATED_CHAMPION_NONE');
});

test('canonical DEGRADED and CRITICAL statuses map to FAIL without new policy thresholds', () => {
  for (const expectedValue of [0.01, -0.1]) {
    const result = bindCanonicalStrategyHealth(overview({
      canonicalStrategyHealth: {
        input: { ...overview().canonicalStrategyHealth.input, expectedValue },
        policy,
      },
    }));
    assert.equal(result.status, 'FAIL');
    assert.ok(['DEGRADED', 'CRITICAL'].includes(result.canonicalCoreStatus ?? ''));
  }
});
