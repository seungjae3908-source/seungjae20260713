import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import router, { setTradeAutomationRepositoryFactoryForTests } from './trade-automation';
import type { AuthenticatedRequest } from '../middleware/auth';
import { InMemoryTradingRepository } from '../services/trade-automation.repository';
import type { TradingOrder, TradingOrderEvent, TradingPlan } from '../services/trade-automation.types';

const USER = '11111111-1111-1111-1111-111111111111';
const NOW = '2026-09-29T05:10:00.000Z';

function fixturePlan(): TradingPlan {
  return {
    id: 'plan-ledger-route',
    userId: USER,
    idempotencyKey: 'plan-ledger-route-key',
    state: 'SUBMITTED',
    version: 1,
    exchange: 'bitget',
    accountMode: 'live',
    strategyId: 'route-test',
    signalId: 'route-test-signal',
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
    signalReasons: ['route-test'],
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

function fixtureOrder(): TradingOrder {
  return {
    id: 'order-ledger-route',
    userId: USER,
    planId: 'plan-ledger-route',
    exchange: 'bitget',
    clientOrderId: 'client-ledger-route',
    exchangeOrderId: null,
    state: 'RECOVERY_REQUIRED',
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
    retryCount: 1,
    nextRetryAt: null,
    lastReconciledAt: NOW,
    lastErrorCode: 'BITGET_TIMEOUT',
    manualReviewRequired: false,
    executionClaimId: null,
    submissionStartedAt: NOW,
    submissionAttemptId: 'attempt-ledger-route',
    approvedPlanVersion: 1,
    preSubmissionCheckedAt: NOW,
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
  };
}

function fixtureEvent(): TradingOrderEvent {
  return {
    id: 'event-ledger-route',
    userId: USER,
    orderId: 'order-ledger-route',
    fromState: 'SUBMITTED',
    toState: 'RECOVERY_REQUIRED',
    reason: 'AMBIGUOUS_PROVIDER_SUBMISSION_RESULT',
    metadata: { orderResubmitted: false },
    createdAt: NOW,
  };
}

async function startServer(repository: InMemoryTradingRepository) {
  setTradeAutomationRepositoryFactoryForTests(() => repository);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const row = req as AuthenticatedRequest;
    row.member = {
      id: USER,
      login_name: 'test',
      display_name: 'test',
      role: 'user',
      membership_level: 'associate',
      status: 'approved',
      is_active: true,
    };
    row.accessToken = 'test';
    next();
  });
  app.use('/api/trade-automation', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test.after(() => setTradeAutomationRepositoryFactoryForTests(null));

test('execution-ledger route exposes canonical unknown-submission truth without provider or financial mutation', async () => {
  const repository = new InMemoryTradingRepository();
  await repository.savePlan(fixturePlan());
  await repository.saveOrder(fixtureOrder());
  await repository.appendEvent(fixtureEvent());
  const eventCountBefore = (await repository.listEvents(USER)).length;

  const { server, baseUrl } = await startServer(repository);
  try {
    const response = await fetch(`${baseUrl}/api/trade-automation/execution-ledger`);
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('cache-control')), /no-store/u);

    const body = await response.json() as {
      ok: boolean;
      summary: { reconciling: number; unknownSubmission: number };
      entries: Array<{
        orderId: string;
        truthPhase: string;
        submissionOutcome: string;
        safeToResubmit: boolean;
        providerMutationAllowed: boolean;
      }>;
      orderSubmitted: boolean;
      orderCanceled: boolean;
      orderAmended: boolean;
      privateTradingRequestSent: boolean;
    };

    assert.equal(body.ok, true);
    assert.equal(body.summary.reconciling, 1);
    assert.equal(body.summary.unknownSubmission, 1);
    assert.equal(body.entries[0]?.orderId, 'order-ledger-route');
    assert.equal(body.entries[0]?.truthPhase, 'RECONCILING');
    assert.equal(body.entries[0]?.submissionOutcome, 'UNKNOWN');
    assert.equal(body.entries[0]?.safeToResubmit, false);
    assert.equal(body.entries[0]?.providerMutationAllowed, false);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.orderCanceled, false);
    assert.equal(body.orderAmended, false);
    assert.equal(body.privateTradingRequestSent, false);
    assert.equal((await repository.listEvents(USER)).length, eventCountBefore);
  } finally {
    await close(server);
  }
});
