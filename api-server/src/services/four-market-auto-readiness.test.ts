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
import type { TradeProfitabilityAttestation } from './trade-profitability-attestation.service';

const NOW = Date.parse('2026-08-14T01:00:00.000Z');
const OBSERVED_AT = '2026-08-14T00:59:59.000Z';
const SHA = '5bd461ade78a9adde84aa9dd49c31219fda87523';
const PARAMETER_HASH = 'a'.repeat(64);

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

function profitabilityAttestation(input: FourMarketAutoReadinessInput): TradeProfitabilityAttestation {
  return {
    required: true,
    allowed: true,
    blockCodes: [],
    source: 'SERVER_STRATEGY_PROMOTION',
    strategyId: String(input.strategyIdentity.strategyId),
    promotionState: 'PROMOTION_CANDIDATE',
    researchCodeSha: input.strategyIdentity.researchCodeSha,
    parameterHash: input.strategyIdentity.parameterHash,
    costPolicyVersion: input.strategyIdentity.costPolicyVersion,
    clientEconomicsTrusted: false,
    serverEconomics: {
      sampleSize: 60,
      winProbability: 0.58,
      averageWinR: 1.4,
      averageLossR: 0.9,
      estimatedCostsR: 0.08,
      profitFactor: 1.45,
      maxDrawdownPercent: 8,
      marketRegime: 'bull',
      calibratedAt: OBSERVED_AT,
    },
    orderAuthorityGranted: false,
  };
}

function inputFor(
  market: FourMarketAutoMarket,
  provider: FourMarketAutoProvider,
  direction: FourMarketAutoDirection,
  reduceOnly = false,
): FourMarketAutoReadinessInput {
  const symbol = market === 'KR_STOCK' ? '005930'
    : market === 'US_STOCK' ? 'AAPL'
      : market === 'CRYPTO_SPOT' ? 'KRW-BTC' : 'BTCUSDT';
  return {
    market,
    provider,
    symbol,
    direction,
    reduceOnly,
    observedAt: OBSERVED_AT,
    staleAfterMs: 5_000,
    strategyIdentity: {
      strategyId: `${market}:${direction}:trend-v1`,
      provider,
      market,
      symbolOrUniverse: symbol,
      strategyFamily: 'trend',
      strategyVersion: 'v1',
      parameterHash: PARAMETER_HASH,
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

function evaluate(
  input: FourMarketAutoReadinessInput,
  attestation: TradeProfitabilityAttestation = profitabilityAttestation(input),
) {
  return evaluateFourMarketAutoPredeployReadiness(input, NOW, () => attestation);
}

test('four fixed markets require canonical provider, server profitability, and keep the frozen plan non-executable', () => {
  const valid = [
    inputFor('KR_STOCK', 'TOSS', 'BUY'),
    inputFor('US_STOCK', 'TOSS', 'SELL_EXIT', true),
    inputFor('CRYPTO_SPOT', 'UPBIT', 'BUY'),
    inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG'),
  ];
  for (const item of valid) {
    const result = evaluate(item);
    assert.equal(result.status, 'AUTO_PREDEPLOY_READY', `${item.market}: ${result.reasons.join(',')}`);
    assert.ok(result.frozenOrderPlan);
    assert.equal(Object.isFrozen(result.frozenOrderPlan), true);
    assert.equal(result.frozenOrderPlan.strategyId, item.strategyIdentity.strategyId);
    assert.equal(result.frozenOrderPlan.parameterHash, PARAMETER_HASH);
    assert.equal(result.frozenOrderPlan.researchCodeSha, SHA);
    assert.equal(result.frozenOrderPlan.profitabilitySource, 'SERVER_STRATEGY_PROMOTION');
    assert.equal(result.frozenOrderPlan.clientEconomicsTrusted, false);
    assert.equal(result.frozenOrderPlan.orderAuthorityGranted, false);
    assert.equal(result.orderSubmitted, false);
    assert.equal(result.exchangeRequestSent, false);
    assert.equal(result.privateTradingRequestAllowed, false);
    assert.equal(result.liveActivationAllowed, false);
  }
});

test('client-shaped attestation data cannot replace the server-only profitability provider', () => {
  const spoofed = inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG');
  (spoofed as unknown as Record<string, unknown>).serverProfitabilityAttestation = profitabilityAttestation(spoofed);
  const result = evaluateFourMarketAutoPredeployReadiness(spoofed, NOW);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.reasons.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  assert.equal(result.frozenOrderPlan, null);
});

test('missing or blocked server profitability provider prevents frozen plan materialization', () => {
  const missing = inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG');
  const missingResult = evaluateFourMarketAutoPredeployReadiness(missing, NOW);
  assert.equal(missingResult.status, 'BLOCKED');
  assert.ok(missingResult.reasons.includes('SERVER_PROFITABILITY_ATTESTATION_REQUIRED'));
  assert.equal(missingResult.frozenOrderPlan, null);

  const blocked = inputFor('CRYPTO_FUTURES', 'BITGET', 'LONG');
  const blockedAttestation: TradeProfitabilityAttestation = {
    ...profitabilityAttestation(blocked),
    allowed: false,
    blockCodes: ['SERVER_STRATEGY_NOT_PROMOTION_READY'],
    promotionState: 'SHADOW_VALIDATED',
    serverEconomics: null,
  };
  const blockedResult = evaluate(blocked, blockedAttestation);
  assert.equal(blockedResult.status, 'BLOCKED');
  assert.ok(blockedResult.reasons.includes('SERVER_PROFITABILITY_ATTESTATION_BLOCKED'));
  assert.equal(blockedResult.frozenOrderPlan, null);
});

test('server profitability identity must match the exact strategy identity', () => {
  const input = inputFor('CRYPTO_SPOT', 'UPBIT', 'BUY');
  const mismatched: TradeProfitabilityAttestation = {
    ...profitabilityAttestation(input),
    parameterHash: 'b'.repeat(64),
  };
  const result = evaluate(input, mismatched);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.reasons.includes('SERVER_PROFITABILITY_IDENTITY_MISMATCH'));
  assert.equal(result.frozenOrderPlan, null);
});

test('readiness rejects malformed server provider output that tries to trust client economics or grant order authority', () => {
  const input = inputFor('US_STOCK', 'TOSS', 'BUY');
  const malformed = {
    ...profitabilityAttestation(input),
    clientEconomicsTrusted: true,
    orderAuthorityGranted: true,
  } as unknown as TradeProfitabilityAttestation;
  const result = evaluate(input, malformed);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.reasons.includes('SERVER_PROFITABILITY_CONTRACT_INVALID'));
  assert.equal(result.frozenOrderPlan, null);
});

test('server profitability provider failure fails closed without materializing an order plan', () => {
  const input = inputFor('KR_STOCK', 'TOSS', 'BUY');
  const result = evaluateFourMarketAutoPredeployReadiness(input, NOW, () => {
    throw new Error('promotion-store-unavailable');
  });
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.reasons.includes('SERVER_PROFITABILITY_ATTESTATION_BLOCKED'));
  assert.equal(result.frozenOrderPlan, null);
});

test('cash markets reject new short semantics and require reducing SELL_EXIT', () => {
  const shortLike = inputFor('CRYPTO_SPOT', 'UPBIT', 'SHORT');
  const shortResult = evaluate(shortLike);
  assert.equal(shortResult.status, 'BLOCKED');
  assert.ok(shortResult.reasons.includes('CASH_DIRECTION_NOT_ALLOWED'));

  const nonReducingExit = inputFor('US_STOCK', 'TOSS', 'SELL_EXIT', false);
  const exitResult = evaluate(nonReducingExit);
  assert.ok(exitResult.reasons.includes('CASH_SELL_MUST_REDUCE'));
});

test('provider mismatch and identity mismatch fail closed instead of falling back', () => {
  const mismatch = inputFor('KR_STOCK', 'UPBIT', 'BUY');
  mismatch.providerEvidence = { kind: 'UPBIT', tickSize: 1, minOrderKrw: 5_000 };
  const result = evaluate(mismatch);
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
  const attestation = profitabilityAttestation(input);
  const result = evaluate(input, attestation);
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
  assert.equal(evaluate(zeroFunding).status, 'AUTO_PREDEPLOY_READY');

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
  const result = evaluate(missing);
  assert.ok(result.reasons.includes('BITGET_CONTRACT_EVIDENCE_INVALID'));
  assert.ok(result.reasons.includes('BITGET_LEVERAGE_OR_MARGIN_INVALID'));
  assert.ok(result.reasons.includes('BITGET_LIQUIDATION_DISTANCE_INVALID'));
});
