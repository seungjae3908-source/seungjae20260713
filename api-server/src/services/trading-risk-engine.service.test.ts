import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTradingRisk,
  floorQuantityToStep,
  TRADING_RISK_POLICY,
  type RiskEngineInput,
} from './trading-risk-engine.service';
import { createPaperTradingState } from './paper-trading-core.service';
import { createImmutablePaperTradingStateSnapshot } from './paper-trading-state-snapshot.service';
import {
  buildAuthoritativePaperRiskSizingEvidence,
  type AuthoritativePaperRiskSizingInput,
  type AuthoritativePaperRiskSizingMarket,
} from './authoritative-paper-risk-sizing-source.service';
import {
  buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource,
  createAuthoritativePaperGenericRiskPolicyProducer,
  type AuthoritativePaperGenericRiskPolicyRecordV1,
} from './authoritative-paper-generic-risk-policy-producer.service';

const baseInput = (patch: Partial<RiskEngineInput> = {}): RiskEngineInput => ({
  market: 'crypto-futures',
  symbol: 'BTCUSDT',
  side: 'long',
  accountBalance: 10_000,
  entryPrice: 100,
  stopLossPrice: 99,
  targetPrice1: 103,
  targetPrice2: 105,
  leverage: 2,
  riskPercent: 0.5,
  entryFeeRate: 0.0006,
  exitFeeRate: 0.0006,
  slippageRate: 0.0005,
  estimatedFundingRate: 0.0001,
  quantityStep: 0.001,
  minimumQuantity: 0.001,
  minimumNotional: 5,
  dailyRealizedPnl: 0,
  weeklyRealizedPnl: 0,
  consecutiveLosses: 0,
  openExposure: 0,
  sameDirectionExposure: 0,
  dataStatus: 'live',
  ...patch,
});

function closeTo(actual: number | null, expected: number, tolerance = 1e-8) {
  assert.notEqual(actual, null);
  assert.ok(Math.abs((actual as number) - expected) <= tolerance, `${actual} != ${expected}`);
}

test('blocks zero account balance', () => {
  const result = calculateTradingRisk(baseInput({ accountBalance: 0 }));
  assert.equal(result.allowed, false);
  assert.ok(result.blockCodes.includes('INVALID_ACCOUNT_BALANCE'));
});

test('blocks invalid long stop at or above entry', () => {
  const result = calculateTradingRisk(baseInput({ stopLossPrice: 100 }));
  assert.ok(result.blockCodes.includes('INVALID_STOP_LOSS'));
});

test('blocks invalid short stop at or below entry', () => {
  const result = calculateTradingRisk(baseInput({ side: 'short', stopLossPrice: 100, targetPrice1: 97, targetPrice2: 95 }));
  assert.ok(result.blockCodes.includes('INVALID_STOP_LOSS'));
});

test('blocks invalid target direction', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 99 }));
  assert.ok(result.blockCodes.includes('INVALID_TARGET_PRICE'));
});

test('blocks NaN numeric input', () => {
  const result = calculateTradingRisk(baseInput({ entryPrice: Number.NaN }));
  assert.ok(result.blockCodes.includes('INVALID_ENTRY_PRICE'));
});

test('blocks Infinity numeric input', () => {
  const result = calculateTradingRisk(baseInput({ leverage: Number.POSITIVE_INFINITY }));
  assert.ok(result.blockCodes.includes('INVALID_LEVERAGE'));
});

test('blocks risk percent above policy maximum', () => {
  const result = calculateTradingRisk(baseInput({ riskPercent: TRADING_RISK_POLICY.maximumRiskPercent + 0.01 }));
  assert.ok(result.blockCodes.includes('INVALID_RISK_PERCENT'));
});

test('blocks negative fee or slippage rate', () => {
  const result = calculateTradingRisk(baseInput({ entryFeeRate: -0.0001 }));
  assert.ok(result.blockCodes.includes('INVALID_COST_RATE'));
});

test('calculates long position quantity from total per-unit loss', () => {
  const result = calculateTradingRisk(baseInput());
  assert.equal(result.allowed, true);
  assert.ok((result.rawQuantity ?? 0) > 40);
  assert.ok((result.recommendedQuantity ?? 0) <= (result.rawQuantity ?? 0));
});

test('calculates short position quantity', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
  }));
  assert.equal(result.allowed, true);
  assert.ok((result.recommendedQuantity ?? 0) > 0);
});

test('floors quantity to exchange step without rounding up', () => {
  assert.equal(floorQuantityToStep(12.3499, 0.01), 12.34);
  assert.equal(floorQuantityToStep(0.000099, 0.00001), 0.00009);
});

test('applies quantity step to recommended quantity', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0,
    exitFeeRate: 0,
    slippageRate: 0,
    estimatedFundingRate: 0,
    quantityStep: 3,
  }));
  assert.equal(result.rawQuantity, 50);
  assert.equal(result.recommendedQuantity, 48);
});

test('blocks quantity below minimum quantity', () => {
  const result = calculateTradingRisk(baseInput({ minimumQuantity: 100 }));
  assert.ok(result.blockCodes.includes('MINIMUM_QUANTITY'));
});

test('blocks notional below minimum notional', () => {
  const result = calculateTradingRisk(baseInput({ minimumNotional: 10_000 }));
  assert.ok(result.blockCodes.includes('MINIMUM_NOTIONAL'));
});

test('keeps estimated maximum loss within maximum risk after all costs', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0.002,
    exitFeeRate: 0.002,
    slippageRate: 0.003,
    estimatedFundingRate: 0.001,
  }));
  assert.ok((result.estimatedMaximumLoss ?? Infinity) <= (result.maximumRiskAmount ?? 0) + 1e-8);
});

test('higher leverage does not increase maximum permitted loss', () => {
  const low = calculateTradingRisk(baseInput({ leverage: 2 }));
  const high = calculateTradingRisk(baseInput({ leverage: 20 }));
  closeTo(low.maximumRiskAmount, high.maximumRiskAmount as number);
  closeTo(low.estimatedMaximumLoss, high.estimatedMaximumLoss as number);
  closeTo(low.recommendedQuantity, high.recommendedQuantity as number);
  assert.ok((high.requiredMargin ?? Infinity) < (low.requiredMargin ?? 0));
});

test('calculates entry fee from entry notional', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(result.estimatedEntryFee, (result.notionalValue as number) * input.entryFeeRate);
});

test('calculates stop exit fee from stop notional', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(result.estimatedExitFeeAtStop, (result.recommendedQuantity as number) * input.stopLossPrice * input.exitFeeRate);
});

test('calculates two-sided slippage cost', () => {
  const input = baseInput();
  const result = calculateTradingRisk(input);
  closeTo(
    result.estimatedSlippageCost,
    (result.recommendedQuantity as number) * (input.entryPrice + input.stopLossPrice) * input.slippageRate,
  );
});

test('uses absolute funding rate as conservative cost', () => {
  const positive = calculateTradingRisk(baseInput({ estimatedFundingRate: 0.001 }));
  const negative = calculateTradingRisk(baseInput({ estimatedFundingRate: -0.001 }));
  closeTo(positive.estimatedFundingCost, negative.estimatedFundingCost as number);
});

test('supports zero fee, slippage, and funding costs', () => {
  const result = calculateTradingRisk(baseInput({
    entryFeeRate: 0,
    exitFeeRate: 0,
    slippageRate: 0,
    estimatedFundingRate: 0,
  }));
  assert.equal(result.recommendedQuantity, 50);
  assert.equal(result.estimatedMaximumLoss, 50);
});

test('calculates target one net profit and risk reward', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.estimatedProfit1 ?? 0) > 0);
  assert.ok((result.riskReward1 ?? 0) >= 1.5);
});

test('calculates target two independently', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.estimatedProfit2 ?? 0) > (result.estimatedProfit1 ?? 0));
  assert.ok((result.riskReward2 ?? 0) > (result.riskReward1 ?? 0));
});

test('blocks risk reward below one', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 101.1, targetPrice2: null }));
  assert.ok(result.blockCodes.includes('RISK_REWARD_TOO_LOW'));
});

test('warns for risk reward between one and one point five', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: 101.7, targetPrice2: null }));
  assert.equal(result.blockCodes.includes('RISK_REWARD_TOO_LOW'), false);
  assert.ok(result.warnings.some((warning) => warning.includes('강한 경고 구간')));
});

test('leaves risk reward null when no target is supplied', () => {
  const result = calculateTradingRisk(baseInput({ targetPrice1: null, targetPrice2: null }));
  assert.equal(result.riskReward1, null);
  assert.equal(result.riskReward2, null);
  assert.equal(result.blockCodes.includes('RISK_REWARD_TOO_LOW'), false);
  assert.ok(result.warnings.some((warning) => warning.includes('목표가가 없어')));
});

test('blocks at daily realized loss limit', () => {
  const result = calculateTradingRisk(baseInput({ dailyRealizedPnl: -100 }));
  assert.ok(result.blockCodes.includes('DAILY_LOSS_LIMIT'));
});

test('blocks at weekly realized loss limit', () => {
  const result = calculateTradingRisk(baseInput({ weeklyRealizedPnl: -300 }));
  assert.ok(result.blockCodes.includes('WEEKLY_LOSS_LIMIT'));
});

test('blocks after configured consecutive loss count', () => {
  const result = calculateTradingRisk(baseInput({ consecutiveLosses: 3 }));
  assert.ok(result.blockCodes.includes('CONSECUTIVE_LOSS_LIMIT'));
});

test('blocks total exposure above account multiple', () => {
  const result = calculateTradingRisk(baseInput({ openExposure: 27_000 }));
  assert.ok(result.blockCodes.includes('EXPOSURE_LIMIT'));
});

test('blocks same direction exposure above account multiple', () => {
  const result = calculateTradingRisk(baseInput({ sameDirectionExposure: 17_000 }));
  assert.ok(result.blockCodes.includes('EXPOSURE_LIMIT'));
});

test('cached data is visible but blocked for entry assessment', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'cached' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
  assert.ok(result.warnings.some((warning) => warning.includes('캐시 데이터')));
});

test('delayed data is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'delayed' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('error data status is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'error' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('insufficient data status is blocked', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'insufficient' }));
  assert.ok(result.blockCodes.includes('DATA_NOT_LIVE'));
});

test('live data permits an otherwise valid scenario', () => {
  const result = calculateTradingRisk(baseInput({ dataStatus: 'live' }));
  assert.equal(result.allowed, true);
});

test('calculates long liquidation approximation', () => {
  const result = calculateTradingRisk(baseInput({ leverage: 10, maintenanceMarginRate: 0.005 }));
  closeTo(result.estimatedLiquidationPrice, 90.5);
});

test('calculates short liquidation approximation', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
    leverage: 10,
    maintenanceMarginRate: 0.005,
  }));
  closeTo(result.estimatedLiquidationPrice, 109.5);
});

test('blocks when stop is beyond or too close to liquidation estimate', () => {
  const result = calculateTradingRisk(baseInput({ leverage: 100 }));
  assert.ok(result.blockCodes.includes('LIQUIDATION_TOO_CLOSE'));
});

test('warns when maintenance margin rate is assumed', () => {
  const result = calculateTradingRisk(baseInput({ maintenanceMarginRate: null }));
  assert.ok(result.warnings.some((warning) => warning.includes('유지증거금률 정보가 없어')));
  assert.ok(result.warnings.some((warning) => warning.includes('실제 청산가격')));
});

test('long break-even price is above entry after fees and slippage', () => {
  const result = calculateTradingRisk(baseInput());
  assert.ok((result.breakEvenPrice ?? 0) > 100);
});

test('short break-even price is below entry after fees and slippage', () => {
  const result = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
  }));
  assert.ok((result.breakEvenPrice ?? Infinity) < 100);
});

test('funding direction warning distinguishes likely payment or receipt', () => {
  const longPositive = calculateTradingRisk(baseInput({ estimatedFundingRate: 0.001 }));
  const shortPositive = calculateTradingRisk(baseInput({
    side: 'short',
    stopLossPrice: 101,
    targetPrice1: 97,
    targetPrice2: 95,
    estimatedFundingRate: 0.001,
  }));
  assert.ok(longPositive.warnings.some((warning) => warning.includes('지급 가능성')));
  assert.ok(shortPositive.warnings.some((warning) => warning.includes('수취 가능성')));
});

test('missing exchange quantity rules do not fabricate values', () => {
  const result = calculateTradingRisk(baseInput({
    quantityStep: null,
    minimumQuantity: null,
    minimumNotional: null,
  }));
  assert.ok((result.recommendedQuantity ?? 0) > 0);
  assert.ok(result.warnings.includes('거래소 최소 주문 규칙을 확인할 수 없습니다.'));
});

const AUTHORITATIVE_NOW_MS = Date.parse('2026-08-28T04:30:00.000Z');
const AUTHORITATIVE_RESEARCH_SHA = 'a'.repeat(40);
const AUTHORITATIVE_PAPER_SHA = 'b'.repeat(40);
const AUTHORITATIVE_ACCOUNT_BINDING = 'c'.repeat(64);

function authoritativeSnapshot(
  market: AuthoritativePaperRiskSizingMarket,
  observedAtMs = AUTHORITATIVE_NOW_MS - 1_000,
  maximumAgeMs = 30_000,
) {
  const state = createPaperTradingState(10_000, new Date(observedAtMs));
  return createImmutablePaperTradingStateSnapshot({
    state,
    sourceOwner: 'authoritative-paper-risk-sizing-test',
    sourceSha: AUTHORITATIVE_PAPER_SHA,
    market,
    currency: market === 'US_STOCK' ? 'USD' : market === 'CRYPTO_FUTURES' ? 'USDT' : 'KRW',
    provenance: ['TEST_AUTHORITATIVE_PAPER_STATE'],
    publisherAccountIdSha256: AUTHORITATIVE_ACCOUNT_BINDING,
    observedAtMs,
    maximumAgeMs,
  });
}

function authoritativeSizingInput(
  market: AuthoritativePaperRiskSizingMarket = 'CRYPTO_FUTURES',
  symbol = 'BTCUSDT',
): AuthoritativePaperRiskSizingInput {
  const observedAtMs = AUTHORITATIVE_NOW_MS - 1_000;
  const snapshot = authoritativeSnapshot(market, observedAtMs);
  const isFutures = market === 'CRYPTO_FUTURES';
  const isStock = market === 'KR_STOCK' || market === 'US_STOCK';
  const quantityStep = isStock ? 1 : 0.001;
  const quantityPrecision = isStock ? 0 : 3;
  return {
    market,
    symbol,
    strategyScope: 'swing',
    side: 'LONG',
    researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
    paperStateSourceSha: AUTHORITATIVE_PAPER_SHA,
    paperAccountId: snapshot.accountId,
    riskPolicy: {
      schemaVersion: 'authoritative-paper-generic-risk-policy-evidence-v1',
      policyId: 'TEST_EXPLICIT_POLICY',
      policyVersion: 'v1',
      source: 'TEST_EXPLICIT_RISK_POLICY_SOURCE',
      provenance: ['TEST_POLICY_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
      marketScopes: [market],
      strategyScopes: ['swing'],
      symbolScopes: [symbol],
      riskPercent: 0.5,
      requestedLeverage: isFutures ? 2 : 1,
      maximumLeverage: isFutures ? 5 : null,
      marginMode: isFutures ? 'isolated' : 'cash',
    },
    paperStateSnapshot: snapshot,
    contractRulesEvidence: {
      schemaVersion: 'authoritative-paper-contract-rules-evidence-v1',
      ruleVersion: 'TEST_RULES_V1',
      market,
      symbol,
      source: 'TEST_CANONICAL_CONTRACT_RULES',
      provenance: ['TEST_CONTRACT_RULES_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      rules: {
        symbol,
        quantityStep,
        quantityPrecision,
        minimumQuantity: quantityStep,
        minimumNotional: 1,
        maximumLeverage: isFutures ? 50 : null,
        maintenanceMarginRate: isFutures ? 0.005 : null,
        status: 'live',
        updatedAt: new Date(observedAtMs).toISOString(),
        warnings: [],
      },
    },
    marketEvidence: {
      schemaVersion: 'authoritative-paper-market-risk-evidence-v1',
      market,
      symbol,
      entryPrice: 100,
      stopLossPrice: 99,
      source: 'TEST_PUBLIC_MARKET_EVIDENCE',
      provenance: ['TEST_MARKET_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      status: 'live',
    },
    costEvidence: {
      schemaVersion: 'authoritative-paper-risk-cost-evidence-v1',
      market,
      symbol,
      source: 'TEST_EXECUTION_COST_EVIDENCE',
      provenance: ['TEST_COST_PROVENANCE'],
      observedAtMs,
      maximumAgeMs: 30_000,
      entryFeeRate: 0.0006,
      exitFeeRate: 0.0006,
      slippageRate: 0.0005,
      estimatedFundingRate: isFutures ? 0.0001 : 0,
    },
  };
}

test('authoritative Paper risk sizing builds target quantity only from fresh explicit evidence', () => {
  const result = buildAuthoritativePaperRiskSizingEvidence(authoritativeSizingInput(), AUTHORITATIVE_NOW_MS);
  assert.equal(result.status, 'PRESENT');
  assert.equal(result.valid, true);
  assert.equal(result.eligible, true);
  assert.ok((result.targetQuantity ?? 0) > 0);
  assert.equal(result.targetQuantity, result.roundedQuantity);
  assert.equal(result.equity, 10_000);
  assert.equal(result.riskPercent, 0.5);
  assert.equal(result.requestedLeverage, 2);
  assert.equal(result.effectiveLeverage, 2);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.liveTrading, false);
  assert.equal(result.privateApiAllowed, false);
  assert.equal(result.privateProviderCallCount, 0);
  assert.equal(result.realOrderSideEffectCount, 0);
});

test('authoritative Paper risk sizing supports all four markets without generic policy defaults', () => {
  const cases: Array<[AuthoritativePaperRiskSizingMarket, string]> = [
    ['KR_STOCK', '005930'],
    ['US_STOCK', 'AAPL'],
    ['CRYPTO_SPOT', 'KRW-BTC'],
    ['CRYPTO_FUTURES', 'BTCUSDT'],
  ];
  for (const [market, symbol] of cases) {
    const result = buildAuthoritativePaperRiskSizingEvidence(
      authoritativeSizingInput(market, symbol),
      AUTHORITATIVE_NOW_MS,
    );
    assert.equal(result.status, 'PRESENT', `${market} should be evidence-complete`);
    assert.ok((result.targetQuantity ?? 0) > 0, `${market} should have a target quantity`);
  }
});

test('authoritative Paper risk sizing blocks missing and stale risk policy', () => {
  const missing = authoritativeSizingInput();
  const missingResult = buildAuthoritativePaperRiskSizingEvidence(
    { ...missing, riskPolicy: null },
    AUTHORITATIVE_NOW_MS,
  );
  assert.equal(missingResult.status, 'BLOCKED_DATA');
  assert.equal(missingResult.targetQuantity, null);
  assert.ok(missingResult.blockers.includes('RISK_POLICY_MISSING'));

  const stale = authoritativeSizingInput();
  const staleResult = buildAuthoritativePaperRiskSizingEvidence({
    ...stale,
    riskPolicy: {
      ...(stale.riskPolicy as Record<string, unknown>),
      observedAtMs: AUTHORITATIVE_NOW_MS - 60_000,
      maximumAgeMs: 30_000,
    },
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(staleResult.status, 'BLOCKED_DATA');
  assert.equal(staleResult.targetQuantity, null);
  assert.ok(staleResult.blockers.includes('RISK_POLICY_STALE_OR_INVALID'));
});

test('authoritative Paper risk sizing rejects invalid risk percent and missing leverage without inventing values', () => {
  for (const riskPercent of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const input = authoritativeSizingInput();
    const result = buildAuthoritativePaperRiskSizingEvidence({
      ...input,
      riskPolicy: { ...(input.riskPolicy as Record<string, unknown>), riskPercent },
    }, AUTHORITATIVE_NOW_MS);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.targetQuantity, null);
    assert.ok(result.blockers.includes('RISK_POLICY_RISK_PERCENT_INVALID'));
  }

  const input = authoritativeSizingInput();
  const result = buildAuthoritativePaperRiskSizingEvidence({
    ...input,
    riskPolicy: { ...(input.riskPolicy as Record<string, unknown>), requestedLeverage: null },
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(result.status, 'BLOCKED_DATA');
  assert.equal(result.requestedLeverage, null);
  assert.equal(result.targetQuantity, null);
  assert.ok(result.blockers.includes('RISK_POLICY_REQUESTED_LEVERAGE_MISSING_OR_INVALID'));
});

test('authoritative Paper risk sizing blocks wrong market and strategy policy scopes', () => {
  const marketInput = authoritativeSizingInput();
  const wrongMarket = buildAuthoritativePaperRiskSizingEvidence({
    ...marketInput,
    riskPolicy: { ...(marketInput.riskPolicy as Record<string, unknown>), marketScopes: ['US_STOCK'] },
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(wrongMarket.status, 'BLOCKED_DATA');
  assert.ok(wrongMarket.blockers.includes('RISK_POLICY_WRONG_MARKET_SCOPE'));

  const strategyInput = authoritativeSizingInput();
  const wrongStrategy = buildAuthoritativePaperRiskSizingEvidence({
    ...strategyInput,
    riskPolicy: { ...(strategyInput.riskPolicy as Record<string, unknown>), strategyScopes: ['scalping'] },
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(wrongStrategy.status, 'BLOCKED_DATA');
  assert.ok(wrongStrategy.blockers.includes('RISK_POLICY_WRONG_STRATEGY_SCOPE'));
});

test('authoritative Paper risk sizing blocks missing stale and wrong-account Paper state', () => {
  const missingInput = authoritativeSizingInput();
  const missing = buildAuthoritativePaperRiskSizingEvidence(
    { ...missingInput, paperStateSnapshot: null },
    AUTHORITATIVE_NOW_MS,
  );
  assert.equal(missing.status, 'BLOCKED_DATA');
  assert.equal(missing.targetQuantity, null);
  assert.ok(missing.blockers.includes('PAPER_STATE_MISSING_OR_INVALID'));

  const staleInput = authoritativeSizingInput();
  const staleSnapshot = authoritativeSnapshot('CRYPTO_FUTURES', AUTHORITATIVE_NOW_MS - 60_000, 30_000);
  const stale = buildAuthoritativePaperRiskSizingEvidence({
    ...staleInput,
    paperStateSnapshot: staleSnapshot,
    paperAccountId: staleSnapshot.accountId,
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(stale.status, 'BLOCKED_DATA');
  assert.equal(stale.targetQuantity, null);
  assert.ok(stale.blockers.includes('PAPER_STATE_STALE'));

  const wrongAccountInput = authoritativeSizingInput();
  const wrongAccount = buildAuthoritativePaperRiskSizingEvidence({
    ...wrongAccountInput,
    paperAccountId: 'different-paper-account',
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(wrongAccount.status, 'BLOCKED_DATA');
  assert.equal(wrongAccount.targetQuantity, null);
  assert.ok(wrongAccount.blockers.includes('PAPER_STATE_WRONG_ACCOUNT'));
});

test('authoritative Paper risk sizing blocks unavailable contract rules and does not fabricate minimum quantity', () => {
  const missingInput = authoritativeSizingInput();
  const missing = buildAuthoritativePaperRiskSizingEvidence(
    { ...missingInput, contractRulesEvidence: null },
    AUTHORITATIVE_NOW_MS,
  );
  assert.equal(missing.status, 'BLOCKED_DATA');
  assert.equal(missing.targetQuantity, null);
  assert.ok(missing.blockers.includes('CONTRACT_RULES_MISSING'));

  const minimumInput = authoritativeSizingInput();
  const contract = minimumInput.contractRulesEvidence as Record<string, unknown>;
  const rules = contract.rules as Record<string, unknown>;
  const minimumBlocked = buildAuthoritativePaperRiskSizingEvidence({
    ...minimumInput,
    contractRulesEvidence: {
      ...contract,
      rules: { ...rules, minimumQuantity: 1_000 },
    },
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(minimumBlocked.status, 'NO_TRADE');
  assert.equal(minimumBlocked.targetQuantity, null);
  assert.ok(minimumBlocked.blockers.includes('RISK_ENGINE_MINIMUM_QUANTITY'));
});

test('authoritative Paper risk sizing rejects non-finite zero and negative market inputs', () => {
  for (const entryPrice of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    const input = authoritativeSizingInput();
    const result = buildAuthoritativePaperRiskSizingEvidence({
      ...input,
      marketEvidence: { ...(input.marketEvidence as Record<string, unknown>), entryPrice },
    }, AUTHORITATIVE_NOW_MS);
    assert.equal(result.status, 'BLOCKED_DATA');
    assert.equal(result.targetQuantity, null);
    assert.ok(result.blockers.includes('MARKET_ENTRY_PRICE_INVALID'));
  }
});

test('authoritative Paper risk sizing blocks unsupported markets and non-futures short side', () => {
  const unsupportedInput = authoritativeSizingInput();
  const unsupported = buildAuthoritativePaperRiskSizingEvidence({
    ...unsupportedInput,
    market: 'FOREX' as AuthoritativePaperRiskSizingMarket,
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(unsupported.status, 'BLOCKED_DATA');
  assert.equal(unsupported.targetQuantity, null);
  assert.ok(unsupported.blockers.includes('UNSUPPORTED_MARKET'));

  const stockInput = authoritativeSizingInput('US_STOCK', 'AAPL');
  const unsupportedSide = buildAuthoritativePaperRiskSizingEvidence({
    ...stockInput,
    side: 'SHORT',
  }, AUTHORITATIVE_NOW_MS);
  assert.equal(unsupportedSide.status, 'BLOCKED_DATA');
  assert.equal(unsupportedSide.targetQuantity, null);
  assert.ok(unsupportedSide.blockers.includes('UNSUPPORTED_SIDE'));
});

function canonicalRiskPolicyRecord(
  patch: Partial<AuthoritativePaperGenericRiskPolicyRecordV1> = {},
): AuthoritativePaperGenericRiskPolicyRecordV1 {
  return {
    schemaVersion: 'authoritative-paper-generic-risk-policy-record-v1',
    recordId: 'paper-risk-policy-record:test-explicit-v1',
    recordVersion: 'record-v1',
    policyId: 'TEST_EXPLICIT_POLICY',
    policyVersion: 'v1',
    source: 'TEST_CANONICAL_RISK_POLICY_RECORD',
    provenance: ['TEST_SIGNED_POLICY_RECORD'],
    observedAtMs: AUTHORITATIVE_NOW_MS - 1_000,
    maximumAgeMs: 30_000,
    researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
    marketScopes: ['CRYPTO_FUTURES'],
    strategyScopes: ['swing'],
    symbolScopes: ['BTCUSDT'],
    riskPercent: 0.5,
    requestedLeverage: 2,
    maximumLeverage: 5,
    marginMode: 'isolated',
    ...patch,
  };
}

function authoritativeSizingCallerInput() {
  const input = authoritativeSizingInput();
  const { riskPolicy, ...callerInput } = input;
  void riskPolicy;
  return callerInput;
}

test('canonical Paper risk policy producer blocks a missing record before sizing', async () => {
  const producer = createAuthoritativePaperGenericRiskPolicyProducer({
    readCanonicalRecord: async () => null,
    now: () => AUTHORITATIVE_NOW_MS,
  });
  const result = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
    authoritativeSizingCallerInput(),
    producer,
    AUTHORITATIVE_NOW_MS,
  );

  assert.equal(result.policySource.status, 'BLOCKED_DATA');
  assert.ok(result.policySource.blockers.includes('RISK_POLICY_CANONICAL_RECORD_MISSING'));
  assert.equal(result.policySource.policyEvidence, null);
  assert.equal(result.sizingEvidence.status, 'BLOCKED_DATA');
  assert.equal(result.sizingEvidence.targetQuantity, null);
});

test('canonical Paper risk policy producer blocks stale and wrong-research records', async () => {
  const cases: Array<[string, Partial<AuthoritativePaperGenericRiskPolicyRecordV1>, string]> = [
    ['stale', {
      observedAtMs: AUTHORITATIVE_NOW_MS - 60_000,
      maximumAgeMs: 30_000,
    }, 'RISK_POLICY_CANONICAL_RECORD_STALE_OR_INVALID'],
    ['wrong research SHA', {
      researchCodeSha: 'd'.repeat(40),
    }, 'RISK_POLICY_CANONICAL_RECORD_RESEARCH_SHA_MISMATCH'],
  ];

  for (const [label, patch, blocker] of cases) {
    const producer = createAuthoritativePaperGenericRiskPolicyProducer({
      readCanonicalRecord: () => canonicalRiskPolicyRecord(patch),
      now: () => AUTHORITATIVE_NOW_MS,
    });
    const result = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
      authoritativeSizingCallerInput(),
      producer,
      AUTHORITATIVE_NOW_MS,
    );
    assert.equal(result.policySource.status, 'BLOCKED_DATA', label);
    assert.ok(result.policySource.blockers.includes(blocker), label);
    assert.equal(result.sizingEvidence.status, 'BLOCKED_DATA', label);
    assert.equal(result.sizingEvidence.targetQuantity, null, label);
  }
});

test('canonical Paper risk policy producer blocks wrong market strategy and symbol scopes', async () => {
  const cases: Array<[string, Partial<AuthoritativePaperGenericRiskPolicyRecordV1>, string]> = [
    ['market', { marketScopes: ['US_STOCK'] }, 'RISK_POLICY_CANONICAL_RECORD_WRONG_MARKET_SCOPE'],
    ['strategy', { strategyScopes: ['scalping'] }, 'RISK_POLICY_CANONICAL_RECORD_WRONG_STRATEGY_SCOPE'],
    ['symbol', { symbolScopes: ['ETHUSDT'] }, 'RISK_POLICY_CANONICAL_RECORD_WRONG_SYMBOL_SCOPE'],
  ];

  for (const [label, patch, blocker] of cases) {
    const producer = createAuthoritativePaperGenericRiskPolicyProducer({
      readCanonicalRecord: () => canonicalRiskPolicyRecord(patch),
      now: () => AUTHORITATIVE_NOW_MS,
    });
    const result = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
      authoritativeSizingCallerInput(),
      producer,
      AUTHORITATIVE_NOW_MS,
    );
    assert.equal(result.policySource.status, 'BLOCKED_DATA', label);
    assert.ok(result.policySource.blockers.includes(blocker), label);
    assert.equal(result.sizingEvidence.status, 'BLOCKED_DATA', label);
    assert.equal(result.sizingEvidence.targetQuantity, null, label);
  }
});

test('canonical Paper risk policy producer blocks invalid explicit risk and leverage values', async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['risk percent', { riskPercent: 0 }, 'RISK_POLICY_CANONICAL_RECORD_RISK_PERCENT_INVALID'],
    ['requested leverage', { requestedLeverage: 0 }, 'RISK_POLICY_CANONICAL_RECORD_REQUESTED_LEVERAGE_INVALID'],
    ['maximum leverage', { maximumLeverage: 0 }, 'RISK_POLICY_CANONICAL_RECORD_MAXIMUM_LEVERAGE_INVALID'],
    ['leverage ordering', {
      requestedLeverage: 6,
      maximumLeverage: 5,
    }, 'RISK_POLICY_CANONICAL_RECORD_REQUESTED_LEVERAGE_EXCEEDS_MAXIMUM'],
    ['margin mode', { marginMode: 'portfolio' }, 'RISK_POLICY_CANONICAL_RECORD_MARGIN_MODE_INVALID'],
  ];

  for (const [label, patch, blocker] of cases) {
    const producer = createAuthoritativePaperGenericRiskPolicyProducer({
      readCanonicalRecord: () => ({ ...canonicalRiskPolicyRecord(), ...patch }),
      now: () => AUTHORITATIVE_NOW_MS,
    });
    const result = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
      authoritativeSizingCallerInput(),
      producer,
      AUTHORITATIVE_NOW_MS,
    );
    assert.equal(result.policySource.status, 'BLOCKED_DATA', label);
    assert.ok(result.policySource.blockers.includes(blocker), label);
    assert.equal(result.sizingEvidence.status, 'BLOCKED_DATA', label);
    assert.equal(result.sizingEvidence.targetQuantity, null, label);
  }
});

test('canonical record flows through #772 producer into #769 sizing only when complete', async () => {
  let sourceCalls = 0;
  const producer = createAuthoritativePaperGenericRiskPolicyProducer({
    readCanonicalRecord: async (request) => {
      sourceCalls += 1;
      assert.deepEqual(request, {
        market: 'CRYPTO_FUTURES',
        symbol: 'BTCUSDT',
        strategyScope: 'swing',
        researchCodeSha: AUTHORITATIVE_RESEARCH_SHA,
      });
      return canonicalRiskPolicyRecord();
    },
    now: () => AUTHORITATIVE_NOW_MS,
  });
  const result = await buildAuthoritativePaperRiskSizingFromGenericRiskPolicySource(
    authoritativeSizingCallerInput(),
    producer,
    AUTHORITATIVE_NOW_MS,
  );

  assert.equal(sourceCalls, 1);
  assert.equal(result.policySource.status, 'PRESENT');
  assert.equal(result.policySource.policyEvidence?.policyId, 'TEST_EXPLICIT_POLICY');
  assert.equal(result.policySource.policyEvidence?.riskPercent, 0.5);
  assert.equal(result.policySource.policyEvidence?.requestedLeverage, 2);
  assert.equal(result.policySource.policyEvidence?.marginMode, 'isolated');
  assert.equal(result.sizingEvidence.status, 'PRESENT');
  assert.ok((result.sizingEvidence.targetQuantity ?? 0) > 0);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.privateApiAllowed, false);
  assert.equal(result.liveTrading, false);
  assert.equal(result.realOrderAllowed, false);
  assert.equal(result.financialMutationAllowed, false);
  assert.equal(result.sizingEvidence.privateProviderCallCount, 0);
  assert.equal(result.sizingEvidence.realOrderSideEffectCount, 0);
});
