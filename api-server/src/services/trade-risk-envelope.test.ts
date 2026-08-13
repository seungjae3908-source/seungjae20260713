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
  evaluateFourMarketPaperReadiness,
  type FourMarketPaperReadinessEvidence,
} from './four-market-paper-readiness.service';

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

function paperEvidence(now: number): FourMarketPaperReadinessEvidence {
  return {
    market: 'KR_STOCK',
    provider: 'TOSS',
    direction: 'BUY',
    reducing: false,
    observedAt: new Date(now).toISOString(),
    dataStatus: 'ready',
    costPolicy: {
      version: 'kr-paper-v1',
      commissionRate: 0,
      taxRate: 0,
      spreadRate: 0.001,
      slippageRate: 0.001,
      fundingRate: null,
      latencyMs: 100,
    },
    session: { id: 'KRX-REGULAR', isOpen: true, halted: false },
    marketRules: {
      tickSize: 1,
      quantityStep: 1,
      minimumQuantity: null,
      minimumNotional: 1,
      maximumLeverage: null,
      maintenanceMarginRate: null,
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

test('four-market Paper readiness accepts explicit zero stock fees but requires Toss and a tradable session', () => {
  const now = Date.now();
  const ready = paperEvidence(now);
  assert.deepEqual(evaluateFourMarketPaperReadiness(ready, now), {
    ready: true,
    blockCodes: [],
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
  const wrongProvider = evaluateFourMarketPaperReadiness({ ...ready, provider: 'UPBIT' }, now);
  assert.ok(wrongProvider.blockCodes.includes('PAPER_PROVIDER_MISMATCH'));
  const closed = evaluateFourMarketPaperReadiness({ ...ready, session: { ...ready.session, isOpen: false } }, now);
  assert.ok(closed.blockCodes.includes('PAPER_STOCK_SESSION_NOT_TRADABLE'));
});

test('cash Paper readiness forbids synthetic long/short and non-reducing exits', () => {
  const now = Date.now();
  const ready = paperEvidence(now);
  const short = evaluateFourMarketPaperReadiness({ ...ready, direction: 'SHORT' }, now);
  assert.ok(short.blockCodes.includes('PAPER_CASH_DIRECTION_INVALID'));
  const exit = evaluateFourMarketPaperReadiness({ ...ready, direction: 'SELL_EXIT', reducing: false }, now);
  assert.ok(exit.blockCodes.includes('PAPER_CASH_EXIT_MUST_REDUCE'));
});

test('Upbit spot Paper readiness remains cash-like and forbids futures-only rules', () => {
  const now = Date.now();
  const spot: FourMarketPaperReadinessEvidence = {
    ...paperEvidence(now),
    market: 'CRYPTO_SPOT',
    provider: 'UPBIT',
    costPolicy: { ...paperEvidence(now).costPolicy, version: 'upbit-paper-v1', taxRate: null },
    session: { id: null, isOpen: true, halted: false },
    marketRules: { ...paperEvidence(now).marketRules, tickSize: 0.00000001, minimumNotional: 5_000 },
  };
  assert.equal(evaluateFourMarketPaperReadiness(spot, now).ready, true);
  const invalid = evaluateFourMarketPaperReadiness({
    ...spot,
    marketRules: { ...spot.marketRules, maximumLeverage: 2 },
  }, now);
  assert.ok(invalid.blockCodes.includes('PAPER_SPOT_FUTURES_RULES_FORBIDDEN'));
});

test('Bitget futures Paper readiness requires LONG/SHORT plus funding, mark/OI and contract risk rules', () => {
  const now = Date.now();
  const futures: FourMarketPaperReadinessEvidence = {
    ...paperEvidence(now),
    market: 'CRYPTO_FUTURES',
    provider: 'BITGET',
    direction: 'LONG',
    costPolicy: {
      ...paperEvidence(now).costPolicy,
      version: 'bitget-paper-v1',
      taxRate: null,
      fundingRate: 0,
    },
    session: { id: null, isOpen: true, halted: false },
    marketRules: {
      tickSize: 0.1,
      quantityStep: 0.001,
      minimumQuantity: 0.001,
      minimumNotional: 5,
      maximumLeverage: 5,
      maintenanceMarginRate: 0.005,
    },
    futures: { markPrice: 100_000, openInterest: 0, marginMode: 'isolated' },
  };
  assert.equal(evaluateFourMarketPaperReadiness(futures, now).ready, true);
  const syntheticBuy = evaluateFourMarketPaperReadiness({ ...futures, direction: 'BUY' }, now);
  assert.ok(syntheticBuy.blockCodes.includes('PAPER_FUTURES_DIRECTION_INVALID'));
  const missingInputs = evaluateFourMarketPaperReadiness({
    ...futures,
    costPolicy: { ...futures.costPolicy, fundingRate: null },
    futures: { markPrice: null, openInterest: null, marginMode: null },
  }, now);
  assert.ok(missingInputs.blockCodes.includes('PAPER_FUTURES_FUNDING_MISSING'));
  assert.ok(missingInputs.blockCodes.includes('PAPER_FUTURES_MARK_OI_MISSING'));
  assert.ok(missingInputs.blockCodes.includes('PAPER_FUTURES_MARGIN_MODE_MISSING'));
});

test('Paper readiness rejects stale or future-dated market evidence', () => {
  const now = Date.now();
  const stale = evaluateFourMarketPaperReadiness({ ...paperEvidence(now), observedAt: new Date(now - 5_001).toISOString() }, now);
  assert.ok(stale.blockCodes.includes('PAPER_EVIDENCE_STALE_OR_INVALID'));
  const future = evaluateFourMarketPaperReadiness({ ...paperEvidence(now), observedAt: new Date(now + 1).toISOString() }, now);
  assert.ok(future.blockCodes.includes('PAPER_EVIDENCE_STALE_OR_INVALID'));
});
