import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SignalOutcomeEvaluation, SignalPerformanceMarket } from './signal-performance-learning.service';
import { evaluateProfitFirstRecommendationSet } from './profit-first-recommendation.service';
import {
  calculateProfitEvidence,
  evaluateNoTradeGate,
  rankProfitCandidates,
  totalTradingCostPercent,
  type TradingCostPolicy,
} from './profit-first-signal.service';

function outcome(index: number, returnPercent: number, target1Hit = returnPercent > 0, stopLossHit = returnPercent < 0): SignalOutcomeEvaluation {
  return {
    signalId: `sig-${index}`,
    evaluationHorizon: '1H',
    evaluatedAt: '2026-08-13T01:00:00.000Z',
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
    id: `${market}-runtime-cost-v1`,
    market,
    commissionPercent: 0.1,
    taxPercent: 0.05,
    spreadPercent: 0.1,
    slippagePercent: 0.1,
    source: 'EXPLICIT_RUNTIME_POLICY',
    ...extra,
  };
}

function evidence(overrides: Partial<Parameters<typeof calculateProfitEvidence>[0]> = {}) {
  const outcomes = Array.from({ length: 30 }, (_, index) => outcome(index, index < 21 ? 2 : -1));
  return calculateProfitEvidence({
    market: 'KR_STOCK',
    strategyHorizon: 'SCALP',
    direction: 'BUY',
    timeframe: '5m',
    marketRegime: 'UPTREND',
    strategyVersion: 'KR_STOCK_SCALP_V2',
    evidenceStatus: 'VALIDATED_RUNTIME',
    outcomes,
    costPolicy: policy('KR_STOCK'),
    riskRewardRatio: 2,
    ...overrides,
  });
}

describe('profit-first signal engine', () => {
  it('computes positive EV only from runtime outcomes and explicit costs', () => {
    const value = evidence();
    assert.equal(value.status, 'READY');
    assert.equal(value.sampleSize, 30);
    assert.equal(value.profitProbability, 70);
    assert.equal(value.lossProbability, 30);
    assert.equal(value.targetBeforeStopProbability, 70);
    assert.ok((value.expectedNetReturn ?? 0) > 0);
    assert.ok((value.expectedValue ?? 0) > 0);
    assert.ok(value.confidenceInterval);
    assert.equal(value.executionAuthority, 'NONE');
  });

  it('includes commission tax spread and slippage in net return', () => {
    const cost = policy('KR_STOCK', { commissionPercent: 0.2, taxPercent: 0.3, spreadPercent: 0.4, slippagePercent: 0.5 });
    assert.equal(totalTradingCostPercent(cost), 1.4);
    const value = evidence({ costPolicy: cost });
    assert.equal(value.tradingCostPercent, 1.4);
    assert.equal(value.expectedNetReturn, -0.3);
  });

  it('returns NO_TRADE for negative EV', () => {
    const outcomes = Array.from({ length: 30 }, (_, index) => outcome(index, index < 10 ? 1 : -2));
    const value = evidence({ outcomes });
    assert.ok((value.expectedValue ?? 0) < 0);
    const gate = evaluateNoTradeGate({ evidence: value, dataQualityPass: true, riskEnginePass: true, minimumRiskRewardRatio: 1 });
    assert.equal(gate.decision, 'NO_TRADE');
    assert.ok(gate.reasons.includes('EV_NON_POSITIVE'));
  });

  it('returns aggregate NO_TRADE with zero recommendations when every candidate fails', () => {
    const insufficient = evidence({ outcomes: [outcome(1, 2)] });
    const negative = evidence({
      strategyVersion: 'NEGATIVE',
      outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 8 ? 1 : -2)),
    });
    const result = evaluateProfitFirstRecommendationSet({
      candidates: [
        { signalId: 'insufficient', evidence: insufficient, evidenceQuality: 'INSUFFICIENT', dataQualityPass: true, riskEnginePass: true },
        { signalId: 'negative', evidence: negative, evidenceQuality: 'RUNTIME_VALIDATED', dataQualityPass: true, riskEnginePass: true },
      ],
      minimumExpectedNetReturnPercent: 0,
      minimumRiskRewardRatio: 1,
      maximumRecommendations: 5,
    });
    assert.equal(result.outcome, 'NO_TRADE');
    assert.deepEqual(result.recommendations, []);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.executionAuthority, 'NONE');
  });

  it('ranks only eligible recommendations and never fills the requested maximum with rejected candidates', () => {
    const strong = evidence({ strategyVersion: 'STRONG' });
    const rejected = evidence({ evidenceStatus: 'NOT_EVIDENCED', strategyVersion: 'MISSING' });
    const result = evaluateProfitFirstRecommendationSet({
      candidates: [
        { signalId: 'strong', evidence: strong, evidenceQuality: 'RUNTIME_VALIDATED', dataQualityPass: true, riskEnginePass: true },
        { signalId: 'missing', evidence: rejected, evidenceQuality: 'MISSING', dataQualityPass: true, riskEnginePass: true },
      ],
      maximumRecommendations: 5,
    });
    assert.equal(result.outcome, 'RECOMMENDATIONS_AVAILABLE');
    assert.deepEqual(result.recommendations.map((item) => item.signalId), ['strong']);
    assert.deepEqual(result.rejected.map((item) => item.signalId), ['missing']);
  });

  it('fails closed for insufficient samples and missing evidence without fake probability', () => {
    const insufficient = evidence({ outcomes: [outcome(1, 2)] });
    assert.equal(insufficient.status, 'INSUFFICIENT_SAMPLE');
    assert.equal(insufficient.profitProbability, null);
    assert.equal(insufficient.expectedNetReturn, null);
    const missing = evidence({ evidenceStatus: 'NOT_EVIDENCED' });
    assert.equal(missing.status, 'NOT_EVIDENCED');
    assert.equal(missing.profitProbability, null);
    const noHistory = evidence({ evidenceStatus: 'NO_VALIDATED_HISTORY' });
    assert.equal(noHistory.status, 'NO_VALIDATED_HISTORY');
    assert.equal(noHistory.expectedValue, null);
  });

  it('fails closed when cost policy, data quality, risk engine, or risk reward evidence is missing', () => {
    const missingCost = evidence({ costPolicy: null });
    assert.equal(missingCost.status, 'NOT_EVIDENCED');
    const value = evidence({ riskRewardRatio: 0.8 });
    const gate = evaluateNoTradeGate({ evidence: value, dataQualityPass: false, riskEnginePass: false, minimumRiskRewardRatio: 1 });
    assert.equal(gate.eligible, false);
    assert.ok(gate.reasons.includes('RISK_REWARD_INSUFFICIENT'));
    assert.ok(gate.reasons.includes('DATA_QUALITY_FAIL'));
    assert.ok(gate.reasons.includes('RISK_ENGINE_FAIL'));
  });

  it('supports all four markets and all three strategy horizons without inventing defaults', () => {
    const markets = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const;
    const horizons = ['SCALP', 'SWING', 'POSITION'] as const;
    for (const market of markets) for (const strategyHorizon of horizons) {
      const value = evidence({ market, strategyHorizon, costPolicy: policy(market), strategyVersion: `${market}_${strategyHorizon}_V2` });
      assert.equal(value.status, 'READY');
      assert.equal(value.market, market);
      assert.equal(value.strategyHorizon, strategyHorizon);
    }
  });

  it('uses deterministic evidence-first ranking rather than a synthetic weighted probability', () => {
    const a = evidence({ strategyVersion: 'A' });
    const b = evidence({ strategyVersion: 'B', outcomes: Array.from({ length: 30 }, (_, index) => outcome(index, index < 24 ? 2.5 : -1)) });
    const ranked = rankProfitCandidates([
      { signalId: 'a', evidence: a, evidenceQuality: 'RUNTIME_VALIDATED' },
      { signalId: 'b', evidence: b, evidenceQuality: 'RUNTIME_VALIDATED' },
    ]);
    assert.equal(ranked[0]?.signalId, 'b');
  });
});
