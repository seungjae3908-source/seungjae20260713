import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRADING_POLICY, type TradingPlan } from './trade-automation.types';
import {
  buildRiskEnvelope,
  evaluateRiskEnvelope,
  riskEnvelopeForPlan,
  withRiskEnvelope,
} from './trade-risk-envelope.service';
import { validatePaperReadiness, type ReadinessEvidence } from './trade-paper-market-contract.service';

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

test('readiness contract: all scenarios', () => {
  const now = Date.now();
  
  // READY fixture
  const readyEvidence: ReadinessEvidence = {
    market: 'KR_STOCK',
    provider: 'Toss',
    side: 'BUY',
    cost: { commission: 0.1 },
    session: { id: 's1', tick: 1 },
    precision: 0.01,
    liquidity: 1000,
    taxPolicy: { enabled: true },
    timestamp: now,
  };
  assert.equal(validatePaperReadiness(readyEvidence, now).allowed, true);

  // Provider mismatch
  assert.equal(validatePaperReadiness({ ...readyEvidence, provider: 'Wrong' }, now).allowed, false);

  // Cash market short rejection
  assert.equal(validatePaperReadiness({ ...readyEvidence, side: 'SHORT' }, now).allowed, false);

  // Non-reducing SELL rejection
  assert.equal(validatePaperReadiness({ ...readyEvidence, side: 'SELL', isReducing: false }, now).allowed, false);
  assert.equal(validatePaperReadiness({ ...readyEvidence, side: 'SELL', isReducing: true }, now).allowed, true);

  // Missing cost policy (KR_STOCK)
  const missingPolicy = { ...readyEvidence };
  delete missingPolicy.taxPolicy;
  assert.equal(validatePaperReadiness(missingPolicy, now).allowed, false);

  // Stale evidence
  assert.equal(validatePaperReadiness({ ...readyEvidence, timestamp: now - 6000 }, now).allowed, false);

  // Futures missing inputs
  const futuresEvidence: ReadinessEvidence = {
    market: 'CRYPTO_FUTURES',
    provider: 'Bitget',
    side: 'BUY',
    cost: { commission: 0.1 },
    session: { id: 's1', tick: 1 },
    precision: 0, // missing
    liquidity: 0, // missing
    timestamp: now,
  };
  assert.equal(validatePaperReadiness(futuresEvidence, now).allowed, false);
});
