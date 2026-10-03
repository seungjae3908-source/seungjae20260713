import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_RULE_PACK_AI_REVIEW_PROMPT_VERSION,
  STRATEGY_RULE_PACK_AI_REVIEW_SCHEMA,
  evidenceBackedAutoStrategyCatalog,
  evaluateStrategyRulePackDeterministicGate,
  evaluateStrategyRulePackGate,
  strategyRulePackAiEvidenceDigest,
  type StrategyRulePackGateInput,
  type StrategyRulePackId,
} from './evidence-backed-auto-strategy-catalog.service';

const NOW = Date.parse('2026-10-03T15:00:00.000Z');

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
      ...extra,
    },
  };
}

function baseInput(
  strategyId: StrategyRulePackId,
  market: StrategyRulePackGateInput['market'],
  direction: StrategyRulePackGateInput['direction'],
  extra: Record<string, unknown>,
): StrategyRulePackGateInput {
  return {
    strategyId,
    market,
    direction,
    signalId: 'signal-ai-gate-1',
    symbol: market === 'CRYPTO_SPOT' ? 'BTC' : market === 'CRYPTO_FUTURES' ? 'BTCUSDT' : 'TEST',
    timeframe: '15m',
    learningSnapshot: evidence(strategyId, extra),
    dataEvidence: {
      publicOnly: true,
      dataQuality: 'READY',
      provider: 'public-test',
      asOfMs: NOW - 1_000,
      maxAgeMs: 30_000,
    },
    publicQuote: {
      bid: 100,
      ask: 101,
      asOfMs: NOW - 1_000,
      maxAgeMs: 30_000,
    },
  };
}

function reviewed(
  input: StrategyRulePackGateInput,
  decision: 'PASS' | 'ABSTAIN' | 'VETO' = 'PASS',
  overrides: Record<string, unknown> = {},
): StrategyRulePackGateInput {
  const digest = strategyRulePackAiEvidenceDigest(input);
  return {
    ...input,
    expectedAiEvidenceDigest: digest,
    nowMs: NOW,
    aiReview: {
      schemaVersion: STRATEGY_RULE_PACK_AI_REVIEW_SCHEMA,
      status: 'READY',
      decision,
      strategyId: input.strategyId,
      signalId: input.signalId,
      market: input.market,
      direction: input.direction,
      symbol: input.symbol,
      timeframe: input.timeframe,
      evidenceDigest: digest,
      promptVersion: STRATEGY_RULE_PACK_AI_REVIEW_PROMPT_VERSION,
      provider: 'google-gemini',
      model: 'gemini-test',
      generatedAt: new Date(NOW - 1_000).toISOString(),
      expiresAt: new Date(NOW + 30_000).toISOString(),
      safety: {
        executionAuthority: 'NONE',
        orderAllowed: false,
        riskOverrideAllowed: false,
        positionSizeAuthority: false,
        leverageAuthority: false,
      },
      ...overrides,
    },
  };
}

test('registers six rule packs with automatic live promotion disabled', () => {
  const catalog = evidenceBackedAutoStrategyCatalog();
  assert.equal(catalog.length, 6);
  assert.equal(catalog.every((row) => row.pilotProfile.initialOperatingCapitalKrw === 500_000), true);
  assert.equal(catalog.every((row) => row.pilotProfile.profitCompoundShare === 0.5), true);
  assert.equal(catalog.every((row) => row.pilotProfile.profitReserveShare === 0.5), true);
  assert.equal(catalog.every((row) => row.pilotProfile.riskPerTradePercentCeiling === 0.5), true);
  assert.equal(catalog.every((row) => row.pilotProfile.futuresMaxLeverage === 3), true);
  assert.equal(catalog.every((row) => row.pilotProfile.automaticLiveExecutionAllowed === false), true);
  assert.equal(catalog.every((row) => row.automaticLivePromotionAllowed === false), true);
});

test('missing deterministic evidence fails closed before AI review', () => {
  const input: StrategyRulePackGateInput = {
    strategyId: 'TREND_PULLBACK_REACCEL_V1',
    market: 'CRYPTO_SPOT',
    direction: 'BUY',
    signalId: 'signal-1',
    symbol: 'BTC',
    timeframe: '15m',
    learningSnapshot: null,
  };
  const deterministic = evaluateStrategyRulePackDeterministicGate(input);
  assert.equal(deterministic.recognized, true);
  assert.equal(deterministic.readyForAiReview, false);
  assert.ok(deterministic.blockers.includes('STRATEGY_RULE_PACK_EVIDENCE_REQUIRED'));

  const finalGate = evaluateStrategyRulePackGate(input);
  assert.equal(finalGate.state, 'NO_TRADE');
  assert.equal(finalGate.paperAllowed, false);
  assert.equal(finalGate.blockers.includes('STRATEGY_RULE_PACK_AI_REVIEW_REQUIRED'), false);
});

test('complete deterministic evidence still fails closed without runtime AI review', () => {
  const input = baseInput('TREND_PULLBACK_REACCEL_V1', 'CRYPTO_SPOT', 'BUY', {
    trendRegimeReady: true,
    pullbackReady: true,
    reaccelerationReady: true,
    volumeAccelerationReady: true,
  });
  const deterministic = evaluateStrategyRulePackDeterministicGate(input);
  assert.equal(deterministic.readyForAiReview, true);

  const result = evaluateStrategyRulePackGate(input);
  assert.equal(result.paperAllowed, false);
  assert.ok(result.blockers.includes('STRATEGY_RULE_PACK_AI_REVIEW_REQUIRED'));
});

test('bound fresh PASS review admits Paper candidate while live stays disabled', () => {
  const input = baseInput('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', 'CRYPTO_SPOT', 'BUY', {
    orderFlowReady: true,
    cvdReady: true,
    takerBuyReady: true,
    orderbookImbalanceReady: true,
    mlRankReady: true,
    modelFrozen: true,
  });
  const result = evaluateStrategyRulePackGate(reviewed(input, 'PASS'));
  assert.equal(result.state, 'PAPER_CANDIDATE');
  assert.equal(result.paperAllowed, true);
  assert.equal(result.liveAllowed, false);
});

test('ABSTAIN remains non-directional support and can continue only when deterministic evidence is complete', () => {
  const input = baseInput('US_EVENT_RVOL_FIRST_PULLBACK_V1', 'US_STOCK', 'BUY', {
    eventCatalystReady: true,
    rvolReady: true,
    firstPullbackReady: true,
    vwapSupportReady: true,
    volumeReaccelerationReady: true,
  });
  const result = evaluateStrategyRulePackGate(reviewed(input, 'ABSTAIN'));
  assert.equal(result.paperAllowed, true);
  assert.equal(result.liveAllowed, false);
});

test('AI VETO blocks even when deterministic evidence is complete', () => {
  const input = baseInput('KR_PRESSURE_BREAKOUT_V1', 'KR_STOCK', 'BUY', {
    pressureReady: true,
    compressionReady: true,
    volumeExpansionReady: true,
    breakoutReady: true,
  });
  const result = evaluateStrategyRulePackGate(reviewed(input, 'VETO'));
  assert.equal(result.paperAllowed, false);
  assert.ok(result.blockers.includes('STRATEGY_RULE_PACK_AI_VETO'));
});

test('mismatched signal identity, evidence digest, stale review, and unsafe authority each fail closed', () => {
  const input = baseInput('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', 'CRYPTO_SPOT', 'BUY', {
    orderFlowReady: true,
    cvdReady: true,
    takerBuyReady: true,
    orderbookImbalanceReady: true,
    mlRankReady: true,
    modelFrozen: true,
  });

  const wrongSignal = evaluateStrategyRulePackGate(reviewed(input, 'PASS', { signalId: 'other-signal' }));
  assert.ok(wrongSignal.blockers.includes('STRATEGY_RULE_PACK_AI_SIGNAL_MISMATCH'));

  const wrongDigest = evaluateStrategyRulePackGate(reviewed(input, 'PASS', { evidenceDigest: 'f'.repeat(64) }));
  assert.ok(wrongDigest.blockers.includes('STRATEGY_RULE_PACK_AI_EVIDENCE_DIGEST_MISMATCH'));

  const stale = evaluateStrategyRulePackGate(reviewed(input, 'PASS', {
    generatedAt: new Date(NOW - 120_000).toISOString(),
    expiresAt: new Date(NOW - 1).toISOString(),
  }));
  assert.ok(stale.blockers.includes('STRATEGY_RULE_PACK_AI_REVIEW_STALE'));

  const unsafe = evaluateStrategyRulePackGate(reviewed(input, 'PASS', {
    safety: {
      executionAuthority: 'ORDER',
      orderAllowed: true,
      riskOverrideAllowed: true,
      positionSizeAuthority: true,
      leverageAuthority: true,
    },
  }));
  assert.ok(unsafe.blockers.includes('STRATEGY_RULE_PACK_AI_SAFETY_INVALID'));
});

test('cash rule packs reject SHORT while futures rule pack accepts LONG and SHORT with valid review', () => {
  const spot = baseInput('CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', 'CRYPTO_SPOT', 'SHORT', {
    orderFlowReady: true, cvdReady: true, takerBuyReady: true,
    orderbookImbalanceReady: true, mlRankReady: true, modelFrozen: true,
  });
  const spotResult = evaluateStrategyRulePackGate(spot);
  assert.equal(spotResult.paperAllowed, false);
  assert.ok(spotResult.blockers.includes('STRATEGY_RULE_PACK_DIRECTION_FORBIDDEN'));

  for (const direction of ['LONG', 'SHORT'] as const) {
    const futures = baseInput('CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', 'CRYPTO_FUTURES', direction, {
      orderFlowReady: true, oiReady: true, cvdReady: true, takerFlowReady: true, fundingRiskReady: true,
    });
    const result = evaluateStrategyRulePackGate(reviewed(futures, 'PASS'));
    assert.equal(result.paperAllowed, true);
    assert.equal(result.liveAllowed, false);
  }
});

test('unknown existing strategies retain pass-through behavior without AI dependency', () => {
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
