import assert from 'node:assert/strict';
import test from 'node:test';
import type { SignalOutcomeEvaluation, SignalPerformanceDirection, SignalPerformanceMarket } from './signal-performance-learning.service';
import { evaluateProfitFirstRecommendationSet } from './profit-first-recommendation.service';
import {
  calculateProfitEvidence,
  evaluateNoTradeGate,
  rankProfitCandidates,
  totalTradingCostPercent,
  type TradingCostPolicy,
} from './profit-first-signal.service';

function outcome(index: number, returnPercent: number): SignalOutcomeEvaluation {
  const target1Hit = returnPercent > 0;
  const stopLossHit = returnPercent < 0;
  return {
    signalId: `sig-${index}`,
    evaluationHorizon: '1H',
    evaluatedAt: '2026-08-14T00:00:00.000Z',
    returnPercent,
    mfePercent: Math.max(returnPercent, 1),
    maePercent: Math.min(returnPercent, -1),
    target1Hit,
    target2Hit: false,
    stopLossHit,
    timeToTargetMs: target1Hit ? 600_000 : null,
    timeToStopMs: stopLossHit ? 300_000 : null,
    outcome: returnPercent > 0 ? 'WIN' : returnPercent < 0 ? 'LOSS' : 'NEUTRAL',
    usableBars: 1,
    rejectedFutureBars: 0,
    conservativeIntrabarConflict: false,
    executionAuthority: 'NONE',
  };
}

function policy(market: SignalPerformanceMarket, extra: Partial<TradingCostPolicy> = {}): TradingCostPolicy {
  return {
    id: `${market}-explicit-cost-v3`,
    market,
    commissionPercent: 0.10,
    taxPercent: 0.05,
    spreadPercent: 0.10,
    slippagePercent: 0.10,
    fundingPercent: 0.02,
    latencyPercent: 0.03,
    liquidityImpactPercent: 0.04,
    partialFillImpactPercent: 0.06,
    source: 'EXPLICIT_RUNTIME_POLICY',
    ...extra,
  };
}

function evidence(args: {
  market?: SignalPerformanceMarket;
  direction?: SignalPerformanceDirection;
  outcomes?: SignalOutcomeEvaluation[];
  costPolicy?: TradingCostPolicy | null;
  strategyVersion?: string;
  minimumSampleSize?: number;
} = {}) {
  const market = args.market ?? 'KR_STOCK';
  const direction = args.direction ?? (market === 'CRYPTO_FUTURES' ? 'LONG' : 'BUY');
  return calculateProfitEvidence({
    market,
    strategyHorizon: 'SCALP',
    direction,
    timeframe: '5m',
    marketRegime: 'UPTREND',
    strategyVersion: args.strategyVersion ?? 'V3',
    evidenceStatus: 'VALIDATED_RUNTIME',
    outcomes: args.outcomes ?? Array.from({ length: 30 }, (_, index) => outcome(index, index < 21 ? 2 : -1)),
    costPolicy: args.costPolicy === undefined ? policy(market) : args.costPolicy,
    riskRewardRatio: 2,
    minimumSampleSize: args.minimumSampleSize,
  });
}

test('profit-first cost policy includes every V4.1 execution-cost component', () => {
  const cost = policy('CRYPTO_FUTURES');
  assert.equal(totalTradingCostPercent(cost), 0.5);
  const value = evidence({ market: 'CRYPTO_FUTURES', direction: 'LONG', costPolicy: cost });
  assert.equal(value.totalExpectedCostPercent, 0.5);
  assert.equal(value.expectedGrossReturn, 1.1);
  assert.equal(value.expectedNetReturn, 0.6);
  assert.equal(value.expectedNetEdge, 0.6);
  assert.equal(value.profitProbability, 70);
  assert.equal(value.targetBeforeStopProbability, 70);
  assert.equal(value.executionAuthority, 'NONE');
});

test('missing or invalid runtime evidence never fabricates probability or net edge', () => {
  const insufficient = evidence({ outcomes: [outcome(1, 2)] });
  assert.equal(insufficient.status, 'INSUFFICIENT_SAMPLE');
  assert.equal(insufficient.profitProbability, null);
  assert.equal(insufficient.expectedNetEdge, null);
  const missingCost = evidence({ costPolicy: null });
  assert.equal(missingCost.status, 'NOT_EVIDENCED');
  assert.equal(missingCost.expectedNetReturn, null);
});

test('market direction mismatch fails closed before profitability calculation', () => {
  const cashShort = evidence({ market: 'KR_STOCK', direction: 'SHORT', costPolicy: policy('KR_STOCK') });
  const futuresBuy = evidence({ market: 'CRYPTO_FUTURES', direction: 'BUY', costPolicy: policy('CRYPTO_FUTURES') });
  assert.equal(cashShort.status, 'DIRECTION_NOT_SUPPORTED');
  assert.equal(futuresBuy.status, 'DIRECTION_NOT_SUPPORTED');
  assert.equal(cashShort.profitProbability, null);
  assert.equal(futuresBuy.expectedNetEdge, null);
});

test('NO_TRADE is mandatory for non-positive net edge, failed data quality, failed risk, or weak RR', () => {
  const losing = evidence({ outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 8 ? 1 : -2)) });
  const gate = evaluateNoTradeGate({ evidence: losing, dataQualityPass: false, riskEnginePass: false, minimumRiskRewardRatio: 3 });
  assert.equal(gate.decision, 'NO_TRADE');
  assert.ok(gate.reasons.includes('NET_EDGE_NON_POSITIVE'));
  assert.ok(gate.reasons.includes('DATA_QUALITY_FAIL'));
  assert.ok(gate.reasons.includes('RISK_ENGINE_FAIL'));
  assert.ok(gate.reasons.includes('RISK_REWARD_INSUFFICIENT'));
  assert.equal(gate.executionAuthority, 'NONE');
});

test('ranking prioritizes cost-adjusted net edge instead of raw hit rate and never force-fills rejected candidates', () => {
  const highHitLowEdge = evidence({
    strategyVersion: 'HIGH_HIT',
    outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 24 ? 1 : -0.5)),
  });
  const lowerHitHighEdge = evidence({
    strategyVersion: 'HIGH_EDGE',
    outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 18 ? 3 : -1)),
  });
  assert.ok((highHitLowEdge.profitProbability ?? 0) > (lowerHitHighEdge.profitProbability ?? 0));
  assert.ok((lowerHitHighEdge.expectedNetEdge ?? 0) > (highHitLowEdge.expectedNetEdge ?? 0));
  const ranked = rankProfitCandidates([
    { signalId: 'high-hit', evidence: highHitLowEdge, evidenceQuality: 'RUNTIME_VALIDATED' },
    { signalId: 'high-edge', evidence: lowerHitHighEdge, evidenceQuality: 'RUNTIME_VALIDATED' },
  ]);
  assert.equal(ranked[0]?.signalId, 'high-edge');

  const insufficient = evidence({ outcomes: [outcome(99, 4)] });
  const set = evaluateProfitFirstRecommendationSet({
    candidates: [
      { signalId: 'eligible', evidence: lowerHitHighEdge, evidenceQuality: 'RUNTIME_VALIDATED', dataQualityPass: true, riskEnginePass: true },
      { signalId: 'rejected', evidence: insufficient, evidenceQuality: 'INSUFFICIENT', dataQualityPass: true, riskEnginePass: true },
    ],
    maximumRecommendations: 10,
  });
  assert.deepEqual(set.recommendations.map((item) => item.signalId), ['eligible']);
  assert.deepEqual(set.rejected.map((item) => item.signalId), ['rejected']);
  assert.equal(set.executionAuthority, 'NONE');
});

test('four markets use explicit market-matched costs and three horizons without paid or AI authority', () => {
  const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
  const horizons = ['SCALP', 'SWING', 'POSITION'] as const;
  for (const market of markets) for (const strategyHorizon of horizons) {
    const direction: SignalPerformanceDirection = market === 'CRYPTO_FUTURES' ? 'LONG' : 'BUY';
    const value = calculateProfitEvidence({
      market,
      strategyHorizon,
      direction,
      timeframe: '5m',
      marketRegime: 'UPTREND',
      strategyVersion: `${market}-${strategyHorizon}`,
      evidenceStatus: 'VALIDATED_RUNTIME',
      outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 21 ? 2 : -1)),
      costPolicy: policy(market),
      riskRewardRatio: 2,
    });
    assert.equal(value.status, 'READY');
    assert.equal(value.executionAuthority, 'NONE');
  }
});
