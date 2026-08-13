import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SignalPerformanceDirection, SignalSnapshotInput } from './signal-performance-learning.service';
import {
  ProfitFirstRuntimeLedger,
  aggregateProfitFirstPerformance,
  createProfitFirstRuntimeSnapshot,
  trackProfitFirstOutcome,
  type ProfitFirstPerformanceRecord,
} from './profit-first-runtime.service';
import type { ProfitEvidence, TradingCostPolicy } from './profit-first-signal.service';

const costPolicy: TradingCostPolicy = {
  id: 'KR-runtime-cost-v1',
  market: 'KR_STOCK',
  commissionPercent: 0.1,
  taxPercent: 0.05,
  spreadPercent: 0.1,
  slippagePercent: 0.15,
  source: 'EXPLICIT_RUNTIME_POLICY',
};

function snapshotInput(direction: SignalPerformanceDirection, signalId = `sig-${direction}`): SignalSnapshotInput {
  const longSide = direction === 'BUY' || direction === 'LONG';
  return {
    signalId,
    timestamp: '2026-08-13T00:00:00.000Z',
    market: 'KR_STOCK',
    symbol: 'TEST',
    symbolName: 'Test',
    strategyHorizon: 'SCALP',
    direction,
    signalScore: 84,
    displayConfidence: 82,
    referencePrice: 100,
    entryPrice: 100,
    stopLoss: longSide ? 97 : 103,
    target1: longSide ? 105 : 95,
    target2: longSide ? 110 : 90,
    riskReward: 5 / 3,
    timeframes: ['5m', '15m'],
    strategyProfileVersion: 'KR_STOCK_SCALP_V2',
    indicatorSnapshot: { rsi: 55 },
    indicatorScores: { trend: 80 },
    patternSnapshot: {},
    volumeContext: {},
    volatilityContext: {},
    trendContext: {},
    marketRegime: 'UPTREND',
    liquidityContext: {},
    aiValidatorResult: { status: 'PASS' },
    riskEngineResult: { status: 'PASS' },
    dataProvenance: ['PUBLIC_RUNTIME_TEST'],
    dataTimestamp: '2026-08-12T23:59:59.000Z',
  };
}

function evidence(direction: SignalPerformanceDirection): ProfitEvidence {
  return {
    status: 'READY',
    market: 'KR_STOCK',
    strategyHorizon: 'SCALP',
    direction,
    timeframe: '5m',
    marketRegime: 'UPTREND',
    strategyVersion: 'KR_STOCK_SCALP_V2',
    profitProbability: 60,
    targetBeforeStopProbability: 55,
    lossProbability: 40,
    expectedGrossReturn: 1.5,
    expectedNetReturn: 1.1,
    expectedLoss: 1,
    expectedValue: 0.8,
    riskRewardRatio: 5 / 3,
    sampleSize: 40,
    confidenceInterval: { level: 0.95, lowerPercent: 44.6, upperPercent: 73.6 },
    tradingCostPercent: 0.4,
    costPolicyId: costPolicy.id,
    executionAuthority: 'NONE',
  };
}

function targetBar(direction: SignalPerformanceDirection) {
  const longSide = direction === 'BUY' || direction === 'LONG';
  return [{ timestamp: '2026-08-13T00:05:00.000Z', high: longSide ? 106 : 101, low: longSide ? 99 : 94, close: longSide ? 104 : 96 }];
}

function stopBar(direction: SignalPerformanceDirection) {
  const longSide = direction === 'BUY' || direction === 'LONG';
  return [{ timestamp: '2026-08-13T00:05:00.000Z', high: longSide ? 101 : 104, low: longSide ? 96 : 99, close: longSide ? 98 : 102 }];
}

describe('profit-first runtime', () => {
  it('reuses the immutable #197 snapshot contract and preserves profit evidence', () => {
    const value = createProfitFirstRuntimeSnapshot(snapshotInput('BUY'), evidence('BUY'));
    assert.equal(value.immutable, true);
    assert.equal(Object.isFrozen(value), true);
    assert.equal(value.executionAuthority, 'NONE');
    assert.equal(value.profitProbability, 60);
    assert.equal(value.expectedNetReturn, 1.1);
    assert.equal(value.profitSampleSize, 40);
  });

  for (const direction of ['BUY', 'SELL', 'LONG', 'SHORT'] as const) {
    it(`tracks TARGET_FIRST, MFE, MAE, and net return for ${direction}`, () => {
      const snapshot = createProfitFirstRuntimeSnapshot(snapshotInput(direction), evidence(direction));
      const result = trackProfitFirstOutcome({
        snapshot,
        bars: targetBar(direction),
        evaluationHorizon: '1H',
        evaluatedAt: '2026-08-13T01:00:00.000Z',
        costPolicy,
      });
      assert.equal(result.outcome, 'WIN');
      assert.equal(result.targetBeforeStop, true);
      assert.equal(result.target1Hit, true);
      assert.equal(result.stopLossHit, false);
      assert.ok((result.mfePercent ?? 0) > 0);
      assert.ok((result.maePercent ?? 0) <= 0);
      assert.equal(result.grossReturnPercent, 5);
      assert.equal(result.netReturnPercent, 4.6);
    });

    it(`tracks STOP_FIRST for ${direction}`, () => {
      const snapshot = createProfitFirstRuntimeSnapshot(snapshotInput(direction), evidence(direction));
      const result = trackProfitFirstOutcome({
        snapshot,
        bars: stopBar(direction),
        evaluationHorizon: '1H',
        evaluatedAt: '2026-08-13T01:00:00.000Z',
        costPolicy,
      });
      assert.equal(result.outcome, 'LOSS');
      assert.equal(result.targetBeforeStop, false);
      assert.equal(result.stopLossHit, true);
      assert.equal(result.grossReturnPercent, -3);
      assert.equal(result.netReturnPercent, -3.4);
    });
  }

  it('fails closed with STOP_FIRST when target and stop are possible in the same candle', () => {
    const snapshot = createProfitFirstRuntimeSnapshot(snapshotInput('BUY'), evidence('BUY'));
    const result = trackProfitFirstOutcome({
      snapshot,
      bars: [{ timestamp: '2026-08-13T00:05:00.000Z', high: 106, low: 96, close: 101 }],
      evaluationHorizon: '1H',
      evaluatedAt: '2026-08-13T01:00:00.000Z',
      costPolicy,
    });
    assert.equal(result.conservativeIntrabarConflict, true);
    assert.equal(result.outcome, 'LOSS');
    assert.equal(result.targetBeforeStop, false);
    assert.equal(result.netReturnPercent, -3.4);
  });

  it('rejects future bars through the inherited look-ahead guard', () => {
    const snapshot = createProfitFirstRuntimeSnapshot(snapshotInput('BUY'), evidence('BUY'));
    const result = trackProfitFirstOutcome({
      snapshot,
      bars: [
        { timestamp: '2026-08-13T00:10:00.000Z', high: 101, low: 99, close: 100 },
        { timestamp: '2026-08-13T02:00:00.000Z', high: 120, low: 99, close: 119 },
      ],
      evaluationHorizon: '1H',
      evaluatedAt: '2026-08-13T01:00:00.000Z',
      costPolicy,
    });
    assert.equal(result.rejectedFutureBars, 1);
    assert.equal(result.target1Hit, false);
  });

  it('aggregates net outcomes by market strategy direction timeframe regime and version', () => {
    const records: ProfitFirstPerformanceRecord[] = [];
    for (let index = 0; index < 30; index += 1) {
      const snapshot = createProfitFirstRuntimeSnapshot(snapshotInput('BUY', `agg-${index}`), evidence('BUY'));
      const outcome = trackProfitFirstOutcome({
        snapshot,
        bars: index < 20 ? targetBar('BUY') : stopBar('BUY'),
        evaluationHorizon: '1H',
        evaluatedAt: '2026-08-13T01:00:00.000Z',
        costPolicy,
      });
      records.push({ snapshot, outcome });
    }
    const aggregated = aggregateProfitFirstPerformance(records, 30);
    assert.equal(aggregated.length, 1);
    assert.equal(aggregated[0]?.dimension.market, 'KR_STOCK');
    assert.equal(aggregated[0]?.dimension.horizon, 'SCALP');
    assert.equal(aggregated[0]?.dimension.direction, 'BUY');
    assert.equal(aggregated[0]?.dimension.timeframe, '5m');
    assert.equal(aggregated[0]?.statistics.sampleStatus, 'READY');
    assert.equal(aggregated[0]?.statistics.sampleSize, 30);
    assert.equal(aggregated[0]?.statistics.wins, 20);
    assert.equal(aggregated[0]?.statistics.losses, 10);
    assert.ok((aggregated[0]?.statistics.averageReturn ?? 0) > 0);
  });

  it('provides append-only in-memory runtime orchestration without execution authority', () => {
    const ledger = new ProfitFirstRuntimeLedger();
    const snapshot = ledger.recordExposure(snapshotInput('BUY', 'ledger-1'), evidence('BUY'));
    assert.equal(snapshot.executionAuthority, 'NONE');
    assert.throws(() => ledger.recordExposure(snapshotInput('BUY', 'ledger-1'), evidence('BUY')));
    const outcome = ledger.recordOutcome({
      signalId: 'ledger-1',
      bars: targetBar('BUY'),
      evaluationHorizon: '1H',
      evaluatedAt: '2026-08-13T01:00:00.000Z',
      costPolicy,
    });
    assert.equal(outcome.executionAuthority, 'NONE');
    assert.equal(ledger.records().length, 1);
  });
});
