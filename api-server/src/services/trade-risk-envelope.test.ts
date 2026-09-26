import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY, type TradingPlan } from './trade-automation.types';
import {
  buildRiskEnvelope,
  evaluateRiskEnvelope,
  riskEnvelopeForPlan,
  withRiskEnvelope,
} from './trade-risk-envelope.service';
import {
  validatePaperReadiness,
  type PaperMarket,
  type PaperReadinessBlocker,
  type PaperReadinessEvidence,
} from './trade-paper-market-contract.service';

function plan(): TradingPlan {
  const now = new Date();
  return {
    id: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    idempotencyKey: 'risk-envelope-test',
    state: 'SUBMITTED',
    version: 1,
    approvalExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    approvedAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'risk-envelope',
    signalId: 'signal-envelope',
    symbol: 'BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: 100_000,
    limitPrice: 100_000,
    estimatedKrw: 100_000,
    stopPrice: 95_000,
    targetPrices: [110_000],
    splitRatios: [50, 30, 20],
    signalReasons: ['risk-envelope'],
    marketSnapshot: {
      observedAt: now.toISOString(),
      riskObservedAt: now.toISOString(),
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
      currentPrice: 100_000,
      plannedPrice: 100_000,
      estimatedSlippagePercent: 0.1,
    },
  };
}

test('approval envelope fixes investment, loss, slippage, split count and expiration', () => {
  const candidate = plan();
  const envelope = buildRiskEnvelope(candidate, DEFAULT_TRADING_POLICY, candidate.approvedAt!);
  const approved = withRiskEnvelope(candidate, envelope);
  assert.deepEqual(riskEnvelopeForPlan(approved), envelope);
  assert.equal(envelope.investmentKrw, 100_000);
  assert.equal(envelope.maxLossKrw, 5_250);
  assert.equal(envelope.maxSlippagePercent, 0.25);
  assert.equal(envelope.maxSplitCount, 3);
  assert.equal(envelope.allowCancelUnfilled, true);
  assert.equal(envelope.stopMethod, 'fixed_stop');
  assert.equal(envelope.emergencyExitScope, 'cancel_unfilled_and_reduce_only');
});

test('missing envelope fails closed', () => {
  const candidate = plan();
  const result = evaluateRiskEnvelope({ plan: candidate, snapshot: candidate.marketSnapshot });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.blockCodes, ['RISK_ENVELOPE_MISSING_OR_INVALID']);
});

test('slippage, investment growth and stop breach cannot escape approved envelope', () => {
  const candidate = plan();
  const approved = withRiskEnvelope(candidate,
    buildRiskEnvelope(candidate, DEFAULT_TRADING_POLICY, candidate.approvedAt!));
  const escaped = {
    ...approved,
    estimatedKrw: 100_001,
    marketSnapshot: {
      ...approved.marketSnapshot,
      currentPrice: 94_000,
      estimatedSlippagePercent: 0.5,
    },
  };
  const result = evaluateRiskEnvelope({ plan: escaped, snapshot: escaped.marketSnapshot });
  assert.equal(result.allowed, false);
  assert.ok(result.blockCodes.includes('RISK_ENVELOPE_INVESTMENT_EXCEEDED'));
  assert.ok(result.blockCodes.includes('RISK_ENVELOPE_SLIPPAGE_EXCEEDED'));
  assert.ok(result.blockCodes.includes('RISK_ENVELOPE_STOP_BREACHED'));
});

test('approval refuses a stop-loss envelope above the hard daily loss budget', () => {
  const candidate = { ...plan(), stopPrice: 40_000 };
  assert.throws(
    () => buildRiskEnvelope(candidate, DEFAULT_TRADING_POLICY, candidate.approvedAt!),
    /RISK_ENVELOPE_MAX_LOSS_EXCEEDED/,
  );
});

const PAPER_NOW_MS = 2_000_000_000_000;

function readyPaperEvidence(market: PaperMarket): PaperReadinessEvidence {
  const common = {
    providerProvenance: 'canonical-public-market-snapshot',
    observedAtMs: PAPER_NOW_MS - 1_000,
    costPolicyVersion: 'paper-cost-v1',
    feePercent: 0.05,
    spreadPercent: 0.1,
    slippagePercent: 0.1,
    tickSize: 0.01,
    liquidity: 10_000,
    partialFillModel: 'ORDER_BOOK' as const,
  };
  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    return {
      ...common,
      market,
      provider: 'toss',
      direction: 'BUY',
      sessionCalendarVersion: 'exchange-calendar-v1',
      marketStatus: 'OPEN',
      taxPolicyVersion: 'stock-tax-v1',
      taxPercent: market === 'KR_STOCK' ? 0.15 : 0,
    };
  }
  if (market === 'CRYPTO_SPOT') {
    return {
      ...common,
      market,
      provider: 'upbit',
      direction: 'BUY',
      minimumOrderNotional: 5_000,
    };
  }
  return {
    ...common,
    market,
    provider: 'bitget',
    direction: 'LONG',
    minimumOrderQuantity: 0.001,
    quantityStep: 0.001,
    quantityPrecision: 3,
    markPrice: 100_000,
    fundingRate: -0.0001,
    leverage: 2,
    marginMode: 'isolated',
    liquidationDistancePercent: 25,
  };
}

function withPaperPatch(market: PaperMarket, patch: Record<string, unknown>) {
  return { ...readyPaperEvidence(market), ...patch };
}

function expectPaperBlocked(evidence: unknown, blocker: PaperReadinessBlocker) {
  const readiness = validatePaperReadiness(evidence, PAPER_NOW_MS);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.status, 'BLOCKED');
  assert.ok(readiness.blockers.includes(blocker), `${blocker} missing from ${readiness.blockers.join(', ')}`);
  assert.equal(readiness.simulatedOnly, true);
  assert.equal(readiness.liveOrderAllowed, false);
  assert.equal(readiness.orderSubmitted, false);
  assert.equal(readiness.privateTradingApiAllowed, false);
  assert.equal(readiness.privateProviderRequests, 0);
  assert.equal(readiness.liveAuthority, false);
  assert.equal(Object.isFrozen(readiness), true);
  assert.equal(Object.isFrozen(readiness.blockers), true);
}

for (const market of ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'] as const) {
  test(`paper readiness accepts a complete ${market} simulation fixture`, () => {
    const readiness = validatePaperReadiness(readyPaperEvidence(market), PAPER_NOW_MS);
    assert.deepEqual(readiness, {
      ready: true,
      status: 'READY',
      blockers: [],
      simulatedOnly: true,
      liveOrderAllowed: false,
      orderSubmitted: false,
      privateTradingApiAllowed: false,
      privateProviderRequests: 0,
      liveAuthority: false,
    });
  });
}

test('paper readiness enforces exact canonical provider ids and provenance', () => {
  expectPaperBlocked(withPaperPatch('KR_STOCK', { provider: 'Toss' }), 'PROVIDER_MISMATCH');
  expectPaperBlocked(withPaperPatch('CRYPTO_SPOT', { provider: 'bitget' }), 'PROVIDER_MISMATCH');
  expectPaperBlocked(withPaperPatch('CRYPTO_FUTURES', { providerProvenance: ' ' }), 'PROVIDER_PROVENANCE_REQUIRED');
});

test('paper readiness restricts cash directions to BUY or reducing SELL/EXIT', () => {
  expectPaperBlocked(withPaperPatch('KR_STOCK', { direction: 'LONG' }), 'DIRECTION_UNSUPPORTED');
  expectPaperBlocked(withPaperPatch('US_STOCK', { direction: 'SHORT' }), 'DIRECTION_UNSUPPORTED');
  expectPaperBlocked(withPaperPatch('CRYPTO_SPOT', { direction: 'SELL', isReducing: false }), 'REDUCING_EXIT_REQUIRED');
  expectPaperBlocked(withPaperPatch('CRYPTO_SPOT', { direction: 'EXIT' }), 'REDUCING_EXIT_REQUIRED');
  assert.equal(validatePaperReadiness(
    withPaperPatch('CRYPTO_SPOT', { direction: 'SELL', isReducing: true }), PAPER_NOW_MS,
  ).ready, true);
});

test('paper readiness requires explicit common cost, precision, liquidity, and partial-fill evidence', () => {
  expectPaperBlocked(withPaperPatch('KR_STOCK', { costPolicyVersion: '' }), 'COST_POLICY_VERSION_REQUIRED');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { feePercent: Number.NaN }), 'FEE_PERCENT_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { spreadPercent: undefined }), 'SPREAD_PERCENT_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { slippagePercent: -1 }), 'SLIPPAGE_PERCENT_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { tickSize: 0 }), 'TICK_SIZE_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { liquidity: 0 }), 'LIQUIDITY_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { partialFillModel: undefined }), 'PARTIAL_FILL_MODEL_REQUIRED');
});

test('paper readiness rejects invalid, stale, and future evidence timestamps', () => {
  expectPaperBlocked(withPaperPatch('KR_STOCK', { observedAtMs: Number.NaN }), 'EVIDENCE_TIMESTAMP_INVALID');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { observedAtMs: PAPER_NOW_MS - 30_001 }), 'EVIDENCE_STALE');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { observedAtMs: PAPER_NOW_MS + 1 }), 'EVIDENCE_FROM_FUTURE');
});

test('stock paper readiness requires an open, versioned session and explicit tax policy', () => {
  expectPaperBlocked(withPaperPatch('KR_STOCK', { sessionCalendarVersion: '' }), 'SESSION_CALENDAR_VERSION_REQUIRED');
  for (const marketStatus of ['CLOSED', 'HALTED', 'UNKNOWN']) {
    expectPaperBlocked(withPaperPatch('US_STOCK', { marketStatus }), 'MARKET_NOT_OPEN');
  }
  expectPaperBlocked(withPaperPatch('US_STOCK', { taxPolicyVersion: undefined }), 'TAX_POLICY_VERSION_REQUIRED');
  expectPaperBlocked(withPaperPatch('KR_STOCK', { taxPercent: -0.1 }), 'TAX_PERCENT_INVALID');
});

test('Upbit spot paper readiness requires a positive minimum-order notional', () => {
  expectPaperBlocked(withPaperPatch('CRYPTO_SPOT', { minimumOrderNotional: 0 }), 'MINIMUM_ORDER_NOTIONAL_INVALID');
});

test('Bitget futures paper readiness accepts LONG/SHORT only', () => {
  assert.equal(validatePaperReadiness(
    withPaperPatch('CRYPTO_FUTURES', { direction: 'SHORT' }), PAPER_NOW_MS,
  ).ready, true);
  for (const direction of ['BUY', 'SELL', 'EXIT']) {
    expectPaperBlocked(withPaperPatch('CRYPTO_FUTURES', { direction }), 'DIRECTION_UNSUPPORTED');
  }
});

test('Bitget futures paper readiness requires every venue-specific risk and contract input', () => {
  const failures: Array<[Record<string, unknown>, PaperReadinessBlocker]> = [
    [{ minimumOrderQuantity: 0 }, 'MINIMUM_ORDER_QUANTITY_INVALID'],
    [{ quantityStep: 0 }, 'QUANTITY_STEP_INVALID'],
    [{ quantityPrecision: -1 }, 'QUANTITY_PRECISION_INVALID'],
    [{ quantityPrecision: 1.5 }, 'QUANTITY_PRECISION_INVALID'],
    [{ markPrice: 0 }, 'MARK_PRICE_INVALID'],
    [{ fundingRate: Number.NaN }, 'FUNDING_RATE_INVALID'],
    [{ leverage: 0 }, 'LEVERAGE_INVALID'],
    [{ marginMode: 'portfolio' }, 'MARGIN_MODE_INVALID'],
    [{ liquidationDistancePercent: 0 }, 'LIQUIDATION_DISTANCE_INVALID'],
  ];
  for (const [patch, blocker] of failures) {
    expectPaperBlocked(withPaperPatch('CRYPTO_FUTURES', patch), blocker);
  }
});
