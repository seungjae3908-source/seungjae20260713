import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCapitalAllocationHeatmap,
  buildStrategyDriftTelegramAlert,
  classifyCounterfactualObservation,
  evaluateStrategyHealth,
  summarizeCounterfactualDecisions,
  type CapitalHeatmapLaneInput,
  type StrategyHealthPolicy,
} from './strategy-health-observatory.service';

const policy: StrategyHealthPolicy = {
  version: 'STRATEGY_HEALTH_V1',
  minimumSampleSize: 30,
  watch: {
    expectedValueBelow: 0.15,
    profitFactorBelow: 1.2,
    maxDrawdownAtOrAbove: 12,
    hitRateGapAtOrBelow: -5,
  },
  degraded: {
    expectedValueBelow: 0.05,
    profitFactorBelow: 1,
    maxDrawdownAtOrAbove: 20,
    hitRateGapAtOrBelow: -10,
  },
  critical: {
    expectedValueBelow: 0,
    profitFactorBelow: 0.8,
    maxDrawdownAtOrAbove: 30,
    hitRateGapAtOrBelow: -20,
  },
};

function healthInput(overrides: Partial<Parameters<typeof evaluateStrategyHealth>[0]> = {}) {
  return {
    strategyId: 'CRYPTO_FUTURES_SCALP_V1_LONG',
    strategyVersion: 'V1',
    sampleSize: 60,
    expectedValue: 0.3,
    profitFactor: 1.5,
    maxDrawdownPercent: 8,
    paperVsBacktestHitRateGap: -1,
    shadowVsBacktestHitRateGap: -2,
    liveVsBacktestHitRateGap: null,
    ...overrides,
  };
}

test('strategy health fails closed on insufficient sample or missing core metrics', () => {
  const small = evaluateStrategyHealth(healthInput({ sampleSize: 10 }), policy);
  assert.equal(small.status, 'INSUFFICIENT_DATA');
  assert.ok(small.reasons.includes('INSUFFICIENT_SAMPLE'));
  assert.equal(small.alertEligible, false);
  assert.equal(small.executionAuthority, 'NONE');

  const missing = evaluateStrategyHealth(healthInput({ expectedValue: null }), policy);
  assert.equal(missing.status, 'INSUFFICIENT_DATA');
  assert.ok(missing.reasons.includes('CORE_PERFORMANCE_METRICS_REQUIRED'));
});

test('strategy health uses explicit versioned policy bands without hidden threshold relaxation', () => {
  assert.equal(evaluateStrategyHealth(healthInput(), policy).status, 'HEALTHY');
  assert.equal(evaluateStrategyHealth(healthInput({ expectedValue: 0.1 }), policy).status, 'WATCH');
  assert.equal(evaluateStrategyHealth(healthInput({ expectedValue: 0.01 }), policy).status, 'DEGRADED');
  assert.equal(evaluateStrategyHealth(healthInput({ expectedValue: -0.1 }), policy).status, 'CRITICAL');
  assert.equal(evaluateStrategyHealth(healthInput({ shadowVsBacktestHitRateGap: -21 }), policy).status, 'CRITICAL');
});

test('counterfactual ledger classifies taken, avoided and missed opportunities without fabricating unresolved outcomes', () => {
  const cases = [
    ['TAKE', 2, 'GOOD_TRADE_TAKEN'],
    ['TAKE', -1, 'BAD_TRADE_TAKEN'],
    ['WAIT', -3, 'BAD_TRADE_AVOIDED'],
    ['REJECT', 4, 'GOOD_TRADE_MISSED'],
  ] as const;

  for (const [decision, netReturnPercent, expected] of cases) {
    const result = classifyCounterfactualObservation({
      signalId: `${decision}-${netReturnPercent}`,
      decision,
      resolved: true,
      netReturnPercent,
      reasonCodes: decision === 'TAKE' ? ['EV_POSITIVE'] : ['RISK_GATE'],
    }, 0.1);
    assert.equal(result.classification, expected);
    assert.equal(result.reasonType, decision === 'TAKE' ? 'WHY_TRADE' : 'WHY_NO_TRADE');
  }

  const unresolved = classifyCounterfactualObservation({
    signalId: 'neutral', decision: 'WATCH', resolved: true, netReturnPercent: 0.05, reasonCodes: ['NEAR_MISS'],
  }, 0.1);
  assert.equal(unresolved.classification, 'NEUTRAL_OR_UNRESOLVED');
});

test('counterfactual summary exposes decision quality, loss avoided and upside missed separately', () => {
  const summary = summarizeCounterfactualDecisions([
    { signalId: '1', decision: 'TAKE', resolved: true, netReturnPercent: 2, reasonCodes: ['EV_POSITIVE'] },
    { signalId: '2', decision: 'TAKE', resolved: true, netReturnPercent: -1, reasonCodes: ['EV_POSITIVE'] },
    { signalId: '3', decision: 'WAIT', resolved: true, netReturnPercent: -3, reasonCodes: ['RISK_GATE'] },
    { signalId: '4', decision: 'REJECT', resolved: true, netReturnPercent: 4, reasonCodes: ['DATA_QUALITY'] },
    { signalId: '5', decision: 'WATCH', resolved: true, netReturnPercent: 0.05, reasonCodes: ['NEAR_MISS'] },
  ], 0.1);

  assert.equal(summary.sampleSize, 5);
  assert.equal(summary.decisiveSampleSize, 4);
  assert.equal(summary.goodTradeTakenCount, 1);
  assert.equal(summary.badTradeTakenCount, 1);
  assert.equal(summary.badTradeAvoidedCount, 1);
  assert.equal(summary.goodTradeMissedCount, 1);
  assert.equal(summary.neutralOrUnresolvedCount, 1);
  assert.equal(summary.decisionQualityRatePercent, 50);
  assert.equal(summary.observedLossAvoidedPercentSum, 3);
  assert.equal(summary.observedUpsideMissedPercentSum, 4);
  assert.equal(summary.executionAuthority, 'NONE');
});

test('strategy drift Telegram contract creates a deduped alert intent only for degraded or critical health', () => {
  const healthy = evaluateStrategyHealth(healthInput(), policy);
  assert.equal(buildStrategyDriftTelegramAlert({ health: healthy, timestamp: '2026-08-14T02:00:00.000Z', cooldownMs: 60_000 }), null);

  const degraded = evaluateStrategyHealth(healthInput({ expectedValue: 0.01 }), policy);
  const alert = buildStrategyDriftTelegramAlert({
    health: degraded,
    timestamp: '2026-08-14T02:00:00.000Z',
    cooldownMs: 3_600_000,
  });
  assert.equal(alert?.type, 'system_critical');
  assert.equal(alert?.symbol, degraded.strategyId);
  assert.match(alert?.dedupeKey ?? '', /^strategy-drift:/);
  assert.equal(alert?.cooldownMs, 3_600_000);
});

function lane(market: CapitalHeatmapLaneInput['market'], allocationKrw: number, evidenceStatus: CapitalHeatmapLaneInput['evidenceStatus']): CapitalHeatmapLaneInput {
  return {
    market,
    allocationKrw,
    allocationWeight: allocationKrw / 800_000,
    evidenceStatus,
    confidence: evidenceStatus === 'INSUFFICIENT' ? 0.1 : 0.8,
    researchScore: evidenceStatus === 'INSUFFICIENT' ? 0.5 : 0.65,
    warnings: evidenceStatus === 'INSUFFICIENT' ? ['INSUFFICIENT_RESEARCH_SAMPLE'] : [],
  };
}

test('capital allocation heatmap keeps CASH visible and checks the 1M KRW invariant', () => {
  const heatmap = buildCapitalAllocationHeatmap({
    initialCapitalKrw: 1_000_000,
    reserveKrw: 200_000,
    lanes: [
      lane('KR_STOCK', 200_000, 'EVIDENCE_READY'),
      lane('US_STOCK', 200_000, 'EVIDENCE_READY'),
      lane('CRYPTO_SPOT', 200_000, 'VALIDATING'),
      lane('CRYPTO_FUTURES', 200_000, 'INSUFFICIENT'),
    ],
  });

  assert.equal(heatmap.allocatedKrw, 1_000_000);
  assert.equal(heatmap.invariantPassed, true);
  assert.equal(heatmap.evidenceStatus, 'PARTIAL');
  assert.equal(heatmap.cells.find((cell) => cell.bucket === 'CASH_RESERVE')?.allocationPercent, 20);
  assert.equal(heatmap.cells.find((cell) => cell.bucket === 'CRYPTO_FUTURES')?.evidenceStatus, 'INSUFFICIENT');
  assert.equal(heatmap.executionAuthority, 'NONE');
});
