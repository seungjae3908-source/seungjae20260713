import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTradingRepository } from './trade-automation.repository';
import { TradeExecutionLedgerProjectionService } from './trade-execution-ledger-projection.service';
import type {
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

const NOW = '2026-09-29T04:30:00.000Z';

function plan(id: string, state: TradingOrderState = 'SUBMITTED'): TradingPlan {
  return {
    id,
    userId: 'user-1',
    idempotencyKey: `plan-key-${id}`,
    state,
    version: 1,
    exchange: 'bitget',
    accountMode: 'live',
    strategyId: 'strategy-1',
    signalId: `signal-${id}`,
    symbol: 'BTCUSDT',
    market: 'CRYPTO_FUTURES',
    side: 'long',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: null,
    limitPrice: 100,
    estimatedKrw: 100_000,
    stopPrice: 95,
    targetPrices: [110],
    splitRatios: [1],
    leverage: 2,
    marginMode: 'isolated',
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['test'],
    marketSnapshot: {
      observedAt: NOW,
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.01,
      orderbookGapPercent: 0.01,
      halted: false,
      availableBalance: 1_000_000,
      accountValueKrw: 1_000_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    approvalExpiresAt: null,
    approvedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function order(
  id: string,
  planId: string,
  state: TradingOrderState,
  overrides: Partial<TradingOrder> = {},
): TradingOrder {
  return {
    id,
    userId: 'user-1',
    planId,
    exchange: 'bitget',
    clientOrderId: `client-${id}`,
    exchangeOrderId: null,
    state,
    version: 1,
    requestedQuantity: 1,
    remainingQuantity: 1,
    currentLimitPrice: 100,
    filledQuantity: 0,
    averageFillPrice: null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    exchangeCreatedAt: null,
    exchangeUpdatedAt: null,
    cancelable: null,
    providerStatusCode: null,
    retryCount: 0,
    nextRetryAt: null,
    lastReconciledAt: null,
    lastErrorCode: null,
    manualReviewRequired: false,
    executionClaimId: null,
    submissionStartedAt: null,
    submissionAttemptId: null,
    approvedPlanVersion: 1,
    preSubmissionCheckedAt: null,
    preSubmissionDecision: null,
    preSubmissionSnapshot: null,
    cancelRequestedAt: null,
    cancelRequestClaimId: null,
    cancelSubmittedAt: null,
    cancelAcknowledgedAt: null,
    cancelOperationId: null,
    recoveryLeaseOwner: null,
    recoveryLeaseUntil: null,
    protectionStatus: 'NOT_REQUIRED',
    protectionErrorCode: null,
    amendments: [],
    lastAmendRequestId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function event(orderId: string, state: TradingOrderState, reason: string): TradingOrderEvent {
  return {
    id: `event-${orderId}-${reason}`,
    userId: 'user-1',
    orderId,
    fromState: state === 'SUBMITTED' ? null : 'SUBMITTED',
    toState: state,
    reason,
    metadata: {},
    createdAt: NOW,
  };
}

test('ambiguous provider submission is projected as reconciling and never safe to resubmit', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePlan(plan('plan-1'));
  await repository.saveOrder(order('order-1', 'plan-1', 'RECOVERY_REQUIRED', {
    submissionStartedAt: NOW,
    submissionAttemptId: 'attempt-1',
    lastErrorCode: 'BITGET_TIMEOUT',
  }));
  await repository.appendEvent(event(
    'order-1',
    'RECOVERY_REQUIRED',
    'AMBIGUOUS_PROVIDER_SUBMISSION_RESULT',
  ));

  const snapshot = await new TradeExecutionLedgerProjectionService(repository).list('user-1');
  const entry = snapshot.entries[0];

  assert.equal(snapshot.summary.reconciling, 1);
  assert.equal(snapshot.summary.unknownSubmission, 1);
  assert.equal(entry.truthPhase, 'RECONCILING');
  assert.equal(entry.submissionOutcome, 'UNKNOWN');
  assert.equal(entry.safeToResubmit, false);
  assert.equal(entry.providerMutationAllowed, false);
  assert.deepEqual(entry.integrityBlockers, []);
});

test('manual review and partial-fill terminal truth remain explicit', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePlan(plan('plan-review'));
  await repository.savePlan(plan('plan-canceled', 'CANCELED'));

  await repository.saveOrder(order('order-review', 'plan-review', 'RECOVERY_REQUIRED', {
    submissionStartedAt: NOW,
    submissionAttemptId: 'attempt-review',
    retryCount: 3,
    manualReviewRequired: true,
    lastErrorCode: 'RECONCILIATION_STATUS_UNKNOWN',
  }));
  await repository.appendEvent(event(
    'order-review',
    'RECOVERY_REQUIRED',
    'EXCHANGE_RECONCILIATION_MANUAL_REVIEW',
  ));

  await repository.saveOrder(order('order-canceled', 'plan-canceled', 'CANCELED', {
    exchangeOrderId: 'exchange-2',
    requestedQuantity: 2,
    filledQuantity: 1,
    remainingQuantity: 1,
    averageFillPrice: 99,
    cancelRequestClaimId: 'cancel-1',
    cancelRequestedAt: NOW,
  }));
  await repository.appendEvent(event('order-canceled', 'CANCELED', 'EXCHANGE_ORDER_RECONCILED'));

  const snapshot = await new TradeExecutionLedgerProjectionService(repository).list('user-1');
  const review = snapshot.entries.find((entry) => entry.orderId === 'order-review');
  const canceled = snapshot.entries.find((entry) => entry.orderId === 'order-canceled');

  assert.equal(review?.truthPhase, 'MANUAL_REVIEW');
  assert.equal(review?.safeToResubmit, false);
  assert.equal(canceled?.truthPhase, 'TERMINAL');
  assert.equal(canceled?.submissionOutcome, 'TERMINAL_CONFIRMED');
  assert.equal(canceled?.partialFillPreserved, true);
  assert.equal(canceled?.filledQuantity, 1);
  assert.equal(canceled?.remainingQuantity, 1);
});

test('duplicate provider identities are surfaced as canonical integrity blockers', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePlan(plan('plan-a'));
  await repository.savePlan(plan('plan-b'));

  await repository.saveOrder(order('order-a', 'plan-a', 'ACCEPTED', {
    clientOrderId: 'same-client-id',
    exchangeOrderId: 'same-exchange-id',
  }));
  await repository.appendEvent(event('order-a', 'ACCEPTED', 'EXCHANGE_ACCEPTED'));

  await repository.saveOrder(order('order-b', 'plan-b', 'ACCEPTED', {
    clientOrderId: 'same-client-id',
    exchangeOrderId: 'same-exchange-id',
  }));
  await repository.appendEvent(event('order-b', 'ACCEPTED', 'EXCHANGE_ACCEPTED'));

  const snapshot = await new TradeExecutionLedgerProjectionService(repository).list('user-1');

  assert.equal(snapshot.summary.integrityBlocked, 2);
  for (const entry of snapshot.entries) {
    assert.ok(entry.integrityBlockers.includes('CANONICAL_CLIENT_ORDER_ID_DUPLICATED'));
    assert.ok(entry.integrityBlockers.includes('CANONICAL_EXCHANGE_ORDER_ID_DUPLICATED'));
  }
});
