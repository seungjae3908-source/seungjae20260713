import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evidenceBackedAutoStrategyCatalog,
  evaluateEvidenceBackedAutoStrategyGate,
} from './evidence-backed-auto-strategy-catalog.service';

function readiness(strategyId: string, extra: Record<string, boolean> = {}) {
  return {
    evidenceBackedStrategyReadiness: {
      strategyId,
      publicDataReady: true,
      sourceFaithfulReplicationReady: true,
      oosPassed: true,
      walkForwardPassed: true,
      fullCostPassed: true,
      strategyHealthPassed: true,
      ...extra,
    },
  };
}

// Node's built-in test runner is used throughout api-server.

  test('registers exactly the four requested strategy axes as NO_TRADE by default', () => {
    const catalog = evidenceBackedAutoStrategyCatalog();
    assert.deepEqual(catalog.map((row) => row.strategyId), [
      'CEX_DEX_ARBITRAGE_V1',
      'US_STOCKS_IN_PLAY_ORB_V1',
      'CRYPTO_WORLD_ORDER_FLOW_ML_V1',
      'KR_ML_CHARTING_V1',
    ]);
    assert.equal(catalog.every((row) => row.defaultState === 'NO_TRADE'), true);
    assert.equal(catalog.every((row) => row.automaticLivePromotionAllowed === false), true);
  });

  test('fails closed when readiness evidence is absent', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'US_STOCKS_IN_PLAY_ORB_V1',
      market: 'US_STOCK',
      learningSnapshot: null,
    });
    assert.equal(result.recognized, true);
    assert.equal(result.state, 'NO_TRADE');
    assert.equal(result.paperAllowed, false);
    assert.equal(result.liveAllowed, false);
    assert.ok(result.blockers.includes('EVIDENCE_STRATEGY_READINESS_REQUIRED'));
  });

  test('allows US Stocks-in-Play only after exact intraday/OOS/full-cost readiness', () => {
    const blocked = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'US_STOCKS_IN_PLAY_ORB_V1',
      market: 'US_STOCK',
      learningSnapshot: readiness('US_STOCKS_IN_PLAY_ORB_V1', {
        pitUniverseReady: true,
        intraday5mReady: false,
        first5mRvolReady: true,
        openingRangeReady: true,
      }),
    });
    assert.equal(blocked.paperAllowed, false);
    assert.equal(blocked.blockers.some((code) => code.includes('INTRADAY5M')), true);

    const ready = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'US_STOCKS_IN_PLAY_ORB_V1',
      market: 'US_STOCK',
      learningSnapshot: readiness('US_STOCKS_IN_PLAY_ORB_V1', {
        pitUniverseReady: true,
        intraday5mReady: true,
        first5mRvolReady: true,
        openingRangeReady: true,
      }),
    });
    assert.equal(ready.state, 'PAPER_CANDIDATE');
    assert.equal(ready.paperAllowed, true);
    assert.equal(ready.liveAllowed, false);
  });

  test('requires multi-exchange flow and frozen model for Crypto World Order Flow ML', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'CRYPTO_WORLD_ORDER_FLOW_ML_V1',
      market: 'CRYPTO_SPOT',
      learningSnapshot: readiness('CRYPTO_WORLD_ORDER_FLOW_ML_V1', {
        multiExchangeOrderFlowReady: true,
        modelFrozen: true,
      }),
    });
    assert.equal(result.paperAllowed, true);
    assert.equal(result.liveAllowed, false);
  });

  test('requires PIT universe and frozen model for KR ML Charting', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'KR_ML_CHARTING_V1',
      market: 'KR_STOCK',
      learningSnapshot: readiness('KR_ML_CHARTING_V1', {
        pitUniverseReady: true,
        modelFrozen: true,
      }),
    });
    assert.equal(result.paperAllowed, true);
    assert.equal(result.liveAllowed, false);
  });

  test('keeps CEX↔DEX arbitrage NO_TRADE until the canonical engine supports atomic multi-leg execution', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'CEX_DEX_ARBITRAGE_V1',
      market: 'CRYPTO_FUTURES',
      learningSnapshot: readiness('CEX_DEX_ARBITRAGE_V1', {
        dexExecutionProviderReady: true,
        atomicHedgeReady: true,
        crossVenueCostReady: true,
        multiLegExecutionAdapterReady: true,
      }),
    });
    assert.equal(result.paperAllowed, false);
    assert.equal(result.state, 'NO_TRADE');
    assert.ok(result.blockers.includes('EVIDENCE_STRATEGY_CROSS_VENUE_ATOMIC_EXECUTION_REQUIRED'));
  });

  test('passes unknown strategies through so existing automation behavior is unchanged', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'EXISTING_STRATEGY',
      market: 'US_STOCK',
      learningSnapshot: null,
    });
    assert.equal(result.recognized, false);
    assert.equal(result.state, 'PASS_THROUGH');
    assert.equal(result.paperAllowed, true);
  });
