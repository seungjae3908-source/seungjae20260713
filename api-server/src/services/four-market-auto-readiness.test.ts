import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateFourMarketAutoPredeployReadiness,
  type FourMarketAutoDirection,
  type FourMarketAutoMarket,
  type FourMarketAutoProvider,
  type FourMarketAutoProviderEvidence,
  type FourMarketAutoReadinessInput,
} from './four-market-auto-readiness.service';

const NOW = Date.parse('2026-08-14T01:00:00.000Z');
const OBSERVED_AT = '2026-08-14T00:59:59.000Z';
const SHA = '5bd461ade78a9adde84aa9dd49c31219fda87523';

function providerEvidence(market: FourMarketAutoMarket): FourMarketAutoProviderEvidence {
  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    return { kind: 'TOSS', sessionOpen: true, halted: false, tickSize: 1, sellableQuantity: 10 };
  }
  if (market === 'CRYPTO_SPOT') {
    return { kind: 'UPBIT', tickSize: 1, minOrderKrw: 5_000, availableQuantity: 10 };
  }
  return {
    kind: 'BITGET',
    markPrice: 100_000,
    fundingRate: 0,
    openInterest: 0,
    minQty: 0.001,
    qtyStep: 0.001,
    priceTick: 0.1,
    leverage: 2,
    marginMode: 'isolated',
    liquidationDistancePercent: 20,
  };
}

function inputFor(
  market: FourMarketAutoMarket,
  provider: FourMarketAutoProvider,
  direction: FourMarketAutoDirection,
  reduceOnly = false,
): FourMarketAutoReadinessInput {
  return {
    market,
    provider,
    symbol: market === 'KR_STOCK' ? '005930' : market === 'US_STOCK' ? 'AAPL' : market === 'CRYPTO_SPOT' ? 'KRW-BTC' : 'BTCUSDT',
    direction,
    reduceOnly,
    observedAt: OBSERVED_AT,
    staleAfterMs: 5_000,
    strategyIdentity: {
      provider,
      market,
      symbolOrUniverse: market === 'KR_STOCK' ? '005930' : market === 'US_STOCK' ? 'AAPL' : market === 'CRYPTO_SPOT' ? 'KRW-BTC' : 'BTCUSDT',
      strategyFamily: 'trend',
      strategyVersion: 'v1',
      parameterHash: 'params-1',
      timeframe: '15m',
      horizon: 'SWING',
      direction,
      regime: 'TREND',
      costPolicyVersion: 'cost-v1',
      researchCodeSha: SHA,
    },
    costPolicy: {
      version: 'cost-v1',
      commissionBps: 0,
      taxBps: 0,
      spreadBps: 1,
      slippageBps: 1,
      latencyMs: 0,
      fundingBps: market === 'CRYPTO_FUTURES' ? 0 : undefined,
    },
    risk: {
      quantity: 1,
      maxLossPerTradeKrw: 10_000,
      dailyLossLimitKrw: 30_000,
      totalExposureKrw: 100_000,
      concentrationPercent: 10,
      correlatedExposurePercent: 10,
      staleDataKillEnabled: true,
      providerFailureKillEnabled: true,
      strategyDriftKillEnabled: true,
      duplicatePreventionReady: true,
      partialFillStateReady: true,
      restartReconciliationReady: true,
    },
    providerEvidence: providerEvidence(market),
    paperGateReady: true,
    shadowGateReady: true,
  };
}

test('four fixed markets accept only their canonical provider and market-specific directions', () => {
  const valid = [
    inputFor('KR_STOCK', 'TOSS', 'BUY'),
    inputFor('US_STOCK', 'TOSS', 'SELL_EXIT', true),
    inputFor('CRYPTO_SPOT', 'UPBIT', 'BUY'),
    inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG'),
  ];
  for (const item of valid) {
    const result = evaluateFourMarketAutoPredeployReadiness(item, NOW);
    assert.equal(result.status, 'AUTO_PREDEPLOY_READY', `${item.market}: ${result.reasons.join(',')}`);
    assert.ok(result.frozenOrderPlan);
    assert.equal(Object.isFrozen(result.frozenOrderPlan), true);
    assert.equal(result.orderSubmitted, false);
    assert.equal(result.exchangeRequestSent, false);
    assert.equal(result.privateTradingRequestAllowed, false);
    assert.equal(result.liveActivationAllowed, false);
  }
});

test('cash markets reject new short semantics and require reducing SELL_EXIT', () => {
  const shortLike = inputFor('CRYPTO_SPOT', 'UPBIT', 'SHORT');
  const shortResult = evaluateFourMarketAutoPredeployReadiness(shortLike, NOW);
  assert.equal(shortResult.status, 'BLOCKED');
  assert.ok(shortResult.reasons.includes('CASH_DIRECTION_NOT_ALLOWED'));

  const nonReducingExit = inputFor('US_STOCK', 'TOSS', 'SELL_EXIT', false);
  const exitResult = evaluateFourMarketAutoPredeployReadiness(nonReducingExit, NOW);
  assert.ok(exitResult.reasons.includes('CASH_SELL_MUST_REDUCE'));
});

test('provider mismatch and identity mismatch fail closed instead of falling back', () => {
  const mismatch = inputFor('KR_STOCK', 'UPBIT', 'BUY');
  mismatch.providerEvidence = { kind: 'UPBIT', tickSize: 1, minOrderKrw: 5_000 };
  const result = evaluateFourMarketAutoPredeployReadiness(mismatch, NOW);
  assert.ok(result.reasons.includes('PROVIDER_AUTHORITY_MISMATCH'));
  assert.ok(result.reasons.includes('TOSS_EVIDENCE_MISMATCH'));
  assert.equal(result.frozenOrderPlan, null);
});

test('unknown cost, stale data, incomplete stage gates, and missing recovery evidence block auto predeploy', () => {
  const input = inputFor('CRYPTO_FUTURES', 'BITGET', 'SHORT');
  input.observedAt = '2026-08-13T23:00:00.000Z';
  input.costPolicy.version = 'UNKNOWN';
  input.strategyIdentity.costPolicyVersion = 'UNKNOWN';
  input.paperGateReady = false;
  input.shadowGateReady = false;
  input.risk.restartReconciliationReady = false;
  const result = evaluateFourMarketAutoPredeployReadiness(input, NOW);
  for (const reason of [
    'DATA_TIMESTAMP_STALE',
    'UNKNOWN_COST_POLICY',
    'PAPER_GATE_NOT_READY',
    'SHADOW_GATE_NOT_READY',
    'DUPLICATE_OR_RECOVERY_CONTRACT_INCOMPLETE',
  ] as const) {
    assert.ok(result.reasons.includes(reason), reason);
  }
});

test('Bitget futures requires mark/funding/OI/precision/leverage/margin/liquidation evidence while accepting explicit zero funding', () => {
  const zeroFunding = inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG');
  assert.equal(evaluateFourMarketAutoPredeployReadiness(zeroFunding, NOW).status, 'AUTO_PREDEPLOY_READY');

  const missing = inputFor('CRYPTO_FUTURES', 'BITGET', 'SHORT');
  missing.providerEvidence = {
    kind: 'BITGET',
    markPrice: 0,
    fundingRate: Number.NaN,
    openInterest: Number.NaN,
    minQty: 0,
    qtyStep: 0,
    priceTick: 0,
    leverage: 0,
    marginMode: 'isolated',
    liquidationDistancePercent: 0,
  };
  const result = evaluateFourMarketAutoPredeployReadiness(missing, NOW);
  assert.ok(result.reasons.includes('BITGET_CONTRACT_EVIDENCE_INVALID'));
  assert.ok(result.reasons.includes('BITGET_LEVERAGE_OR_MARGIN_INVALID'));
  assert.ok(result.reasons.includes('BITGET_LIQUIDATION_DISTANCE_INVALID'));
});
