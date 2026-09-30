import { describe, expect, it } from 'vitest';
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

describe('evidence-backed auto strategy catalog', () => {
  it('registers exactly the four requested strategy axes as NO_TRADE by default', () => {
    const catalog = evidenceBackedAutoStrategyCatalog();
    expect(catalog.map((row) => row.strategyId)).toEqual([
      'CEX_DEX_ARBITRAGE_V1',
      'US_STOCKS_IN_PLAY_ORB_V1',
      'CRYPTO_WORLD_ORDER_FLOW_ML_V1',
      'KR_ML_CHARTING_V1',
    ]);
    expect(catalog.every((row) => row.defaultState === 'NO_TRADE')).toBe(true);
    expect(catalog.every((row) => row.automaticLivePromotionAllowed === false)).toBe(true);
  });

  it('fails closed when readiness evidence is absent', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'US_STOCKS_IN_PLAY_ORB_V1',
      market: 'US_STOCK',
      learningSnapshot: null,
    });
    expect(result.recognized).toBe(true);
    expect(result.state).toBe('NO_TRADE');
    expect(result.paperAllowed).toBe(false);
    expect(result.liveAllowed).toBe(false);
    expect(result.blockers).toContain('EVIDENCE_STRATEGY_READINESS_REQUIRED');
  });

  it('allows US Stocks-in-Play only after exact intraday/OOS/full-cost readiness', () => {
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
    expect(blocked.paperAllowed).toBe(false);
    expect(blocked.blockers.some((code) => code.includes('INTRADAY5M'))).toBe(true);

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
    expect(ready.state).toBe('PAPER_CANDIDATE');
    expect(ready.paperAllowed).toBe(true);
    expect(ready.liveAllowed).toBe(false);
  });

  it('requires multi-exchange flow and frozen model for Crypto World Order Flow ML', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'CRYPTO_WORLD_ORDER_FLOW_ML_V1',
      market: 'CRYPTO_SPOT',
      learningSnapshot: readiness('CRYPTO_WORLD_ORDER_FLOW_ML_V1', {
        multiExchangeOrderFlowReady: true,
        modelFrozen: true,
      }),
    });
    expect(result.paperAllowed).toBe(true);
    expect(result.liveAllowed).toBe(false);
  });

  it('requires PIT universe and frozen model for KR ML Charting', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'KR_ML_CHARTING_V1',
      market: 'KR_STOCK',
      learningSnapshot: readiness('KR_ML_CHARTING_V1', {
        pitUniverseReady: true,
        modelFrozen: true,
      }),
    });
    expect(result.paperAllowed).toBe(true);
    expect(result.liveAllowed).toBe(false);
  });

  it('keeps CEX↔DEX arbitrage NO_TRADE until the canonical engine supports atomic multi-leg execution', () => {
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
    expect(result.paperAllowed).toBe(false);
    expect(result.state).toBe('NO_TRADE');
    expect(result.blockers).toContain('EVIDENCE_STRATEGY_CROSS_VENUE_ATOMIC_EXECUTION_REQUIRED');
  });

  it('passes unknown strategies through so existing automation behavior is unchanged', () => {
    const result = evaluateEvidenceBackedAutoStrategyGate({
      strategyId: 'EXISTING_STRATEGY',
      market: 'US_STOCK',
      learningSnapshot: null,
    });
    expect(result.recognized).toBe(false);
    expect(result.state).toBe('PASS_THROUGH');
    expect(result.paperAllowed).toBe(true);
  });
});
