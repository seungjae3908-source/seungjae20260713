import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceBackedAutoStrategyCatalog,
  evaluateStrategyRulePackGate,
  type StrategyRulePackId,
} from './evidence-backed-auto-strategy-catalog.service';

function evidence(strategyId: StrategyRulePackId, extra: Record<string, unknown> = {}) {
  return {
    strategyRulePackEvidence: {
      strategyId,
      dataReady: true,
      formulaReady: true,
      waveStructureReady: true,
      indicatorReady: true,
      entryTriggerReady: true,
      liquidityReady: true,
      costEvidenceReady: true,
      riskReady: true,
      aiReviewReady: true,
      aiDecision: 'PASS',
      ...extra,
    },
  };
}

test('registers the six requested rule packs and never grants automatic live promotion', () => {
  const catalog = evidenceBackedAutoStrategyCatalog();
  assert.equal(catalog.length, 6);
  assert.deepEqual(catalog.map((row) => row.strategyId), [
    'TREND_PULLBACK_REACCEL_V1',
    'US_EVENT_RVOL_FIRST_PULLBACK_V1',
    'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
    'KR_PRESSURE_BREAKOUT_V1',
    'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
  ]);
  assert.equal(catalog.every((row) => row.pilotProfile.totalBudgetKrw === 500_000), true);
  assert.equal(catalog.every((row) => row.pilotProfile.maxOrderKrw === 50_000), true);
  assert.equal(catalog.every((row) => row.pilotProfile.maxConcurrentLivePositions === 2), true);
  assert.equal(catalog.every((row) => row.pilotProfile.maxDailyLiveEntries === 4), true);
  assert.equal(catalog.every((row) => row.pilotProfile.dailyLossStopKrw === 10_000), true);
  assert.equal(catalog.every((row) => row.pilotProfile.maxConsecutiveLosses === 2), true);
  assert.equal(catalog.every((row) => row.pilotProfile.futuresMaxLeverage === 2), true);
  assert.equal(catalog.every((row) => row.pilotProfile.paperMirrorRequired === true), true);
  assert.equal(catalog.every((row) => row.pilotProfile.pairedFillComparisonRequired === true), true);
  assert.equal(catalog.every((row) => row.pilotProfile.liveOrderRequiresExplicitConfirmation === true), true);
  assert.equal(catalog.every((row) => row.pilotProfile.automaticLiveExecutionAllowed === false), true);
  assert.equal(catalog.every((row) => row.automaticLivePromotionAllowed === false), true);
});

test('missing rule evidence fails closed before Paper plan creation', () => {
  const result = evaluateStrategyRulePackGate({
    strategyId: 'TREND_PULLBACK_REACCEL_V1',
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    learningSnapshot: null,
  });
  assert.equal(result.recognized, true);
  assert.equal(result.state, 'NO_TRADE');
  assert.equal(result.paperAllowed, false);
  assert.equal(result.liveAllowed, false);
  assert.ok(result.blockers.includes('STRATEGY_RULE_PACK_EVIDENCE_REQUIRED'));
});

test('trend pullback can enter Paper only after formula wave indicator reacceleration evidence is complete', () => {
  const result = evaluateStrategyRulePackGate({
    strategyId: 'TREND_PULLBACK_REACCEL_V1',
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    learningSnapshot: evidence('TREND_PULLBACK_REACCEL_V1', {
      trendRegimeReady: true,
      pullbackReady: true,
      reaccelerationReady: true,
      volumeAccelerationReady: true,
    }),
  });
  assert.equal(result.state, 'PAPER_CANDIDATE');
  assert.equal(result.paperAllowed, true);
  assert.equal(result.liveAllowed, false);
});

test('AI VETO blocks even when deterministic market conditions are ready', () => {
  const result = evaluateStrategyRulePackGate({
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    market: 'KR_STOCK',
    direction: 'BUY',
    learningSnapshot: evidence('KR_PRESSURE_BREAKOUT_V1', {
      pressureReady: true,
      compressionReady: true,
      volumeExpansionReady: true,
      breakoutReady: true,
      aiDecision: 'VETO',
    }),
  });
  assert.equal(result.paperAllowed, false);
  assert.ok(result.blockers.includes('STRATEGY_RULE_PACK_AI_VETO'));
});

test('cash rule packs reject SHORT while futures flow admits LONG and SHORT', () => {
  const spot = evaluateStrategyRulePackGate({
    strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
    market: 'CRYPTO_SPOT',
    direction: 'SHORT',
    learningSnapshot: evidence('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', {
      orderFlowReady: true, cvdReady: true, takerBuyReady: true,
      orderbookImbalanceReady: true, mlRankReady: true, modelFrozen: true,
    }),
  });
  assert.equal(spot.paperAllowed, false);
  assert.ok(spot.blockers.includes('STRATEGY_RULE_PACK_DIRECTION_FORBIDDEN'));

  for (const direction of ['LONG', 'SHORT'] as const) {
    const futures = evaluateStrategyRulePackGate({
      strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
      market: 'CRYPTO_FUTURES',
      direction,
      learningSnapshot: evidence('CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', {
        orderFlowReady: true, oiReady: true, cvdReady: true,
        takerFlowReady: true, fundingRiskReady: true,
      }),
    });
    assert.equal(futures.paperAllowed, true);
    assert.equal(futures.liveAllowed, false);
  }
});

test('unknown existing strategies pass through unchanged', () => {
  const result = evaluateStrategyRulePackGate({
    strategyId: 'trend-breakout-v1',
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    learningSnapshot: null,
  });
  assert.equal(result.recognized, false);
  assert.equal(result.state, 'PASS_THROUGH');
  assert.equal(result.paperAllowed, true);
});
