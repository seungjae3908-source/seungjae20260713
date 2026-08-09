import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TradingRepository } from './trade-automation.repository';
import {
  TradeRecoveryWorker,
  type TradeRecoveryWorkerSource,
} from './trade-recovery-worker.service';
import type {
  ExchangeConnection,
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

function plan(userId: string, id: string): TradingPlan {
  return {
    id,
    userId,
    idempotencyKey: `key-${id}`,
    exchange: 'upbit',
    accountMode: 'paper',
    strategyId: 'recovery-test',
    signalId: `signal-${id}`,
    symbol: 'KRW-BTC',
    market: 'KRW',
    side: 'buy',
    orderType: 'limit',
    quantity: 1,
    quoteAmount: null,
    limitPrice: 100,
    estimatedKrw: 100,
    stopPrice: 90,
    targetPrices: [110],
    splitRatios: [1],
    leverage: null,
    marginMode: null,
    reduceOnly: false,
    invalidateAction: 'hold',
    signalReasons: ['test'],
    marketSnapshot: {
      observedAt: '2026-08-05T05:00:00.000Z',
      dataDelayMs: 0,
      oneMinuteMovePercent: 0,
      spreadPercent: 0.1,
      orderbookGapPercent: 0.1,
      halted: false,
      availableBalance: 1_000,
      accountValueKrw: 1_000,
      dailyPnlPercent: 0,
      assetExposurePercent: 0,
      openPositionCount: 0,
      dailyOrderCount: 0,
      consecutiveLosses: 0,
    },
    state: 'SUBMITTED',
    version: 0,
    approvalExpiresAt: null,
    approvedAt: '2026-08-05T05:00:00.000Z',
    createdAt: '2026-08-05T05:00:00.000Z',
    updatedAt: '2026-08-05T05:00:00.000Z',
  };
}

function order(userId: string, id: string, planId: string, state: TradingOrderState = 'SUBMITTED'): TradingOrder {
  return {
    id,
    userId,
    planId,
    exchange: 'upbit',
    clientOrderId: `client-${id}`,
    exchangeOrderId: null,
    state,
    version: 0,
    requestedQuantity: 1,
    remainingQuantity: 1,
    filledQuantity: 0,
    averageFillPrice: null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    retryCount: 0,
    nextRetryAt: null,
    lastReconciledAt: null,
    lastErrorCode: null,
    manualReviewRequired: false,
    recoveryLeaseOwner: null,
    recoveryLeaseUntil: null,
    createdAt: '2026-08-05T05:00:00.000Z',
    updatedAt: '2026-08-05T05:00:00.000Z',
  };
}

class FakeRecoverySource implements TradeRecoveryWorkerSource {
  readonly orders = new Map<string, TradingOrder>();
  readonly plans = new Map<string, TradingPlan>();
  readonly events: TradingOrderEvent[] = [];
  readonly failPrepare = new Set<string>();
  globalEmergencyStopped = false;
  now = Date.parse('2026-08-05T05:01:00.000Z');
  transitionDelayMs = 0;
  activeTransitions = 0;
  maxActiveTransitions = 0;

  seed(count: number, state: TradingOrderState = 'SUBMITTED') {
    for (let index = 1; index <= count; index += 1) {
      const userId = `11111111-1111-1111-1111-${String(index).padStart(12, '0')}`;
      const planId = `21111111-1111-1111-1111-${String(index).padStart(12, '0')}`;
      const orderId = `31111111-1111-1111-1111-${String(index).padStart(12, '0')}`;
      this.plans.set(planId, plan(userId, planId));
      this.orders.set(orderId, order(userId, orderId, planId, state));
    }
  }

  async claimRecoveryOrders(workerId: string, limit: number, leaseSeconds: number) {
    const candidates = [...this.orders.values()]
      .filter((item) => ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED'].includes(item.state))
      .filter((item) => !item.manualReviewRequired)
      .filter((item) => !item.nextRetryAt || Date.parse(item.nextRetryAt) <= this.now)
      .filter((item) => !item.recoveryLeaseUntil || Date.parse(item.recoveryLeaseUntil) < this.now)
      .slice(0, limit);
    for (const item of candidates) {
      item.recoveryLeaseOwner = workerId;
      item.recoveryLeaseUntil = new Date(this.now + leaseSeconds * 1_000).toISOString();
    }
    return structuredClone(candidates);
  }

  async prepareRecoveryOrder(candidate: TradingOrder, workerId: string) {
    if (this.failPrepare.delete(candidate.id)) throw new Error('PREPARE_FAILED');
    const current = this.leaseOwned(candidate, workerId);
    if (!current) return null;
    if (current.state === 'RECOVERY_REQUIRED') return structuredClone(current);
    const fromState = current.state;
    current.state = 'RECOVERY_REQUIRED';
    current.version = Number(current.version ?? 0) + 1;
    current.updatedAt = new Date(this.now).toISOString();
    this.events.push({
      id: `prepare-${candidate.id}`,
      userId: current.userId,
      orderId: current.id,
      fromState,
      toState: 'RECOVERY_REQUIRED',
      reason: 'RECOVERY_WORKER_CLAIMED',
      metadata: { orderSubmissionAttempted: false },
      createdAt: current.updatedAt,
    });
    return structuredClone(current);
  }

  async getPlan(userId: string, planId: string) {
    const value = this.plans.get(planId);
    return value?.userId === userId ? structuredClone(value) : null;
  }

  repositoryFor(userId: string, workerId: string) {
    const connection: ExchangeConnection = {
      userId,
      exchange: 'upbit',
      accountMode: 'paper',
      configured: true,
      encryptedCredentials: 'test-encrypted-credentials',
      lastVerifiedAt: null,
      lastErrorCode: null,
      updatedAt: new Date(this.now).toISOString(),
    };
    return {
      getConnection: async (candidateUserId: string) => candidateUserId === userId
        ? structuredClone(connection) : null,
      setGlobalEmergencyStop: async (stopped: boolean, changedBy: string) => {
        if (changedBy !== userId) throw new Error('USER_SCOPE_MISMATCH');
        this.globalEmergencyStopped = stopped;
      },
      transitionOrderAtomic: async (
        next: TradingOrder,
        expectedState: TradingOrderState,
        expectedVersion: number,
        event: TradingOrderEvent,
      ) => {
        this.activeTransitions += 1;
        this.maxActiveTransitions = Math.max(this.maxActiveTransitions, this.activeTransitions);
        try {
          if (this.transitionDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, this.transitionDelayMs));
          }
          const current = this.leaseOwned(next, workerId);
          if (!current || current.state !== expectedState || Number(current.version ?? 0) !== expectedVersion) {
            return { order: structuredClone(current ?? next), applied: false };
          }
          Object.assign(current, structuredClone(next), {
            version: expectedVersion + 1,
            recoveryLeaseOwner: null,
            recoveryLeaseUntil: null,
          });
          this.events.push(structuredClone(event));
          return { order: structuredClone(current), applied: true };
        } finally {
          this.activeTransitions -= 1;
        }
      },
    } as unknown as TradingRepository;
  }

  async recordFailure(
    candidate: TradingOrder,
    workerId: string,
    failureCode: string,
    manualReviewRequired = false,
  ) {
    const current = this.leaseOwned(candidate, workerId);
    if (!current) return null;
    const retryCount = current.retryCount + 1;
    Object.assign(current, {
      state: 'RECOVERY_REQUIRED' as const,
      version: Number(current.version ?? 0) + 1,
      retryCount,
      lastErrorCode: failureCode,
      manualReviewRequired: manualReviewRequired || retryCount >= 3,
      nextRetryAt: manualReviewRequired || retryCount >= 3
        ? null : new Date(this.now + 30_000).toISOString(),
      recoveryLeaseOwner: null,
      recoveryLeaseUntil: null,
      updatedAt: new Date(this.now).toISOString(),
    });
    return structuredClone(current);
  }

  private leaseOwned(candidate: TradingOrder, workerId: string) {
    const current = this.orders.get(candidate.id);
    if (!current || current.userId !== candidate.userId) return null;
    if (current.recoveryLeaseOwner !== workerId) return null;
    if (!current.recoveryLeaseUntil || Date.parse(current.recoveryLeaseUntil) < this.now) return null;
    return current;
  }
}

test('two workers claim each order once, stay bounded, halt new orders, and never resubmit', async () => {
  const source = new FakeRecoverySource();
  source.seed(6);
  source.transitionDelayMs = 10;
  const first = new TradeRecoveryWorker(source, { batchSize: 10, concurrency: 2, leaseSeconds: 60 },
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const second = new TradeRecoveryWorker(source, { batchSize: 10, concurrency: 2, leaseSeconds: 60 },
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');

  const [left, right] = await Promise.all([first.runOnce(), second.runOnce()]);

  assert.equal(left.claimed + right.claimed, 6);
  assert.equal(left.manualReviewRequired + right.manualReviewRequired, 6);
  assert.ok(Math.max(left.maxConcurrencyObserved, right.maxConcurrencyObserved) <= 2);
  assert.ok(source.maxActiveTransitions <= 2);
  assert.equal([...source.orders.values()].filter((item) => item.recoveryLeaseOwner !== null).length, 0);
  assert.equal(source.globalEmergencyStopped, true);
  assert.equal(left.exchangeOrdersSubmitted, false);
  assert.equal(right.exchangeOrdersSubmitted, false);
});

test('an uncompleted lease is not stolen before expiry and is recoverable after expiry', async () => {
  const source = new FakeRecoverySource();
  source.seed(1, 'RECOVERY_REQUIRED');
  const firstClaims = await source.claimRecoveryOrders(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1, 15,
  );
  assert.equal(firstClaims.length, 1);
  assert.equal((await source.claimRecoveryOrders(
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1, 15,
  )).length, 0);

  source.now += 16_000;
  const restarted = new TradeRecoveryWorker(source, { batchSize: 1, concurrency: 1, leaseSeconds: 15 },
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  const result = await restarted.runOnce();

  assert.equal(result.claimed, 1);
  assert.equal(result.manualReviewRequired, 1);
  assert.equal(source.globalEmergencyStopped, true);
  assert.equal([...source.orders.values()][0].recoveryLeaseOwner, null);
});

test('terminal, manual-review, and future-retry orders are excluded from claims', async () => {
  const source = new FakeRecoverySource();
  source.seed(4, 'RECOVERY_REQUIRED');
  const values = [...source.orders.values()];
  values[0].state = 'FILLED';
  values[1].manualReviewRequired = true;
  values[2].nextRetryAt = new Date(source.now + 60_000).toISOString();

  const worker = new TradeRecoveryWorker(source, { batchSize: 10, concurrency: 3, leaseSeconds: 60 },
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  const result = await worker.runOnce();

  assert.equal(result.claimed, 1);
  assert.equal(result.manualReviewRequired, 1);
  assert.equal(source.globalEmergencyStopped, true);
});

test('one item failure is recorded and does not stop the remaining recovery batch', async () => {
  const source = new FakeRecoverySource();
  source.seed(3);
  source.failPrepare.add([...source.orders.keys()][1]);
  const worker = new TradeRecoveryWorker(source, { batchSize: 3, concurrency: 2, leaseSeconds: 60 },
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

  const result = await worker.runOnce();

  assert.equal(result.claimed, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.manualReviewRequired, 2);
  assert.equal(result.leaseLost, 0);
  assert.equal(source.globalEmergencyStopped, true);
  assert.equal([...source.orders.values()].filter((item) => item.recoveryLeaseOwner !== null).length, 0);
  assert.equal(result.exchangeOrdersSubmitted, false);
});
