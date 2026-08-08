import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase, hasSupabaseServerKey } from '../lib/supabase';
import type { TradingRepository } from './trade-automation.repository';
import { TradeOrderRecoveryService } from './trade-order-recovery.service';
import type {
  ExchangeConnection,
  TradingExchange,
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

const RECOVERY_STATES = new Set<TradingOrderState>([
  'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED',
]);

export type TradeRecoveryWorkerOptions = {
  batchSize: number;
  concurrency: number;
  leaseSeconds: number;
};

export type TradeRecoveryWorkerResult = {
  workerId: string;
  claimed: number;
  reconciled: number;
  pending: number;
  manualReviewRequired: number;
  failed: number;
  leaseLost: number;
  maxConcurrencyObserved: number;
  exchangeOrdersSubmitted: false;
};

export interface TradeRecoveryWorkerSource {
  claimRecoveryOrders(workerId: string, limit: number, leaseSeconds: number): Promise<TradingOrder[]>;
  prepareRecoveryOrder(order: TradingOrder, workerId: string): Promise<TradingOrder | null>;
  getPlan(userId: string, planId: string): Promise<TradingPlan | null>;
  repositoryFor(userId: string, workerId: string): TradingRepository;
  recordFailure(
    order: TradingOrder,
    workerId: string,
    errorCode: string,
    manualReviewRequired?: boolean,
  ): Promise<TradingOrder | null>;
}

type ItemResult = 'reconciled' | 'pending' | 'manual' | 'failed' | 'lease_lost';

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function orderVersion(order: TradingOrder) {
  return Number.isInteger(order.version) && Number(order.version) >= 0 ? Number(order.version) : 0;
}

function normalizeOrder(order: TradingOrder): TradingOrder {
  return {
    ...structuredClone(order),
    version: orderVersion(order),
    remainingQuantity: order.remainingQuantity ?? (order.requestedQuantity === null
      ? null
      : Math.max(0, order.requestedQuantity - order.filledQuantity)),
    fills: structuredClone(order.fills ?? []),
    feeAmount: order.feeAmount ?? null,
    feeCurrency: order.feeCurrency ?? null,
    exchangeCreatedAt: order.exchangeCreatedAt ?? null,
    exchangeUpdatedAt: order.exchangeUpdatedAt ?? null,
    cancelable: order.cancelable ?? null,
    providerStatusCode: order.providerStatusCode ?? null,
    nextRetryAt: order.nextRetryAt ?? null,
    lastReconciledAt: order.lastReconciledAt ?? null,
    manualReviewRequired: order.manualReviewRequired === true,
    executionClaimId: order.executionClaimId ?? null,
    recoveryLeaseOwner: order.recoveryLeaseOwner ?? null,
    recoveryLeaseUntil: order.recoveryLeaseUntil ?? null,
    protectionStatus: order.protectionStatus ?? 'NOT_REQUIRED',
    protectionErrorCode: order.protectionErrorCode ?? null,
  };
}

function errorCode(error: unknown, fallback = 'TRADE_RECOVERY_WORKER_ITEM_FAILED') {
  const value = error instanceof Error ? error.message.split(':')[0] : fallback;
  return /^[A-Z0-9_]+$/.test(value) ? value : fallback;
}

function recoveryEvent(
  order: TradingOrder,
  fromState: TradingOrderState,
  toState: TradingOrderState,
  reason: string,
  metadata: Record<string, unknown>,
): TradingOrderEvent {
  return {
    id: randomUUID(),
    userId: order.userId,
    orderId: order.id,
    fromState,
    toState,
    reason,
    metadata: { ...metadata, orderSubmissionAttempted: false },
    createdAt: new Date().toISOString(),
  };
}

function toConnection(row: Record<string, unknown>): ExchangeConnection {
  return {
    userId: String(row.user_id),
    exchange: String(row.exchange) as TradingExchange,
    accountMode: String(row.account_mode) as ExchangeConnection['accountMode'],
    configured: row.configured === true,
    encryptedCredentials: row.encrypted_credentials ? String(row.encrypted_credentials) : null,
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    updatedAt: String(row.updated_at),
  };
}

export class SupabaseTradeRecoveryWorkerSource implements TradeRecoveryWorkerSource {
  constructor(private client: SupabaseClient = getSupabase()) {
    if (!hasSupabaseServerKey()) throw new Error('TRADE_RECOVERY_SERVICE_ROLE_REQUIRED');
  }

  async claimRecoveryOrders(workerId: string, limit: number, leaseSeconds: number) {
    const { data, error } = await this.client.rpc('claim_trade_recovery_orders', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_seconds: leaseSeconds,
    });
    if (error) throw new Error('TRADE_RECOVERY_CLAIM_FAILED');
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return rows.map((row) => normalizeOrder(row as TradingOrder));
  }

  async prepareRecoveryOrder(order: TradingOrder, workerId: string) {
    if (order.state === 'RECOVERY_REQUIRED') return order;
    if (!RECOVERY_STATES.has(order.state)) return null;
    const fromState = order.state;
    const next: TradingOrder = {
      ...normalizeOrder(order),
      state: 'RECOVERY_REQUIRED',
      updatedAt: new Date().toISOString(),
    };
    return this.transitionLeaseOwned(
      next,
      fromState,
      orderVersion(order),
      workerId,
      recoveryEvent(next, fromState, 'RECOVERY_REQUIRED', 'RECOVERY_WORKER_CLAIMED', {
        workerLeaseOwned: true,
      }),
      false,
    );
  }

  async getPlan(userId: string, planId: string) {
    const { data, error } = await this.client.from('trade_order_plans').select('payload')
      .eq('user_id', userId).eq('id', planId).maybeSingle();
    if (error) throw new Error('TRADE_RECOVERY_PLAN_LOOKUP_FAILED');
    return data?.payload ? data.payload as TradingPlan : null;
  }

  repositoryFor(userId: string, workerId: string) {
    // Recovery is deliberately scoped to connection lookup and lease-fenced order
    // transitions. No plan creation, execution claim, order submission, or cancel
    // operation is exposed through this adapter.
    return {
      getConnection: async (candidateUserId: string, exchange: TradingExchange) => {
        if (candidateUserId !== userId) throw new Error('USER_SCOPE_MISMATCH');
        const { data, error } = await this.client.from('trade_exchange_connections').select('*')
          .eq('user_id', userId).eq('exchange', exchange).maybeSingle();
        if (error) throw new Error('TRADE_RECOVERY_CONNECTION_LOOKUP_FAILED');
        return data ? toConnection(data as Record<string, unknown>) : null;
      },
      transitionOrderAtomic: async (
        order: TradingOrder,
        expectedState: TradingOrderState,
        expectedVersion: number,
        event: TradingOrderEvent,
      ) => {
        if (order.userId !== userId) throw new Error('USER_SCOPE_MISMATCH');
        const updated = await this.transitionLeaseOwned(
          order, expectedState, expectedVersion, workerId, event, true,
        );
        if (updated) return { order: updated, applied: true };
        const current = await this.getOrder(userId, order.id);
        return { order: current ?? normalizeOrder(order), applied: false };
      },
    } as unknown as TradingRepository;
  }

  async recordFailure(
    order: TradingOrder,
    workerId: string,
    failureCode: string,
    manualReviewRequired = false,
  ) {
    if (!RECOVERY_STATES.has(order.state)) return null;
    const now = new Date();
    const retryCount = order.retryCount + 1;
    const requiresReview = manualReviewRequired || retryCount >= 3;
    const delayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, retryCount - 1)));
    const fromState = order.state;
    const next: TradingOrder = {
      ...normalizeOrder(order),
      state: 'RECOVERY_REQUIRED',
      retryCount,
      lastErrorCode: failureCode,
      lastReconciledAt: now.toISOString(),
      nextRetryAt: requiresReview ? null : new Date(now.getTime() + delayMs).toISOString(),
      manualReviewRequired: requiresReview,
      updatedAt: now.toISOString(),
    };
    return this.transitionLeaseOwned(
      next,
      fromState,
      orderVersion(order),
      workerId,
      recoveryEvent(next, fromState, 'RECOVERY_REQUIRED', requiresReview
        ? 'RECOVERY_WORKER_MANUAL_REVIEW_REQUIRED'
        : 'RECOVERY_WORKER_RETRY_SCHEDULED', {
        errorCode: failureCode,
        retryCount,
        nextRetryAt: next.nextRetryAt,
        manualReviewRequired: requiresReview,
        workerFailureIsolated: true,
      }),
      true,
    );
  }

  private async getOrder(userId: string, orderId: string) {
    const { data, error } = await this.client.from('trade_orders').select('payload')
      .eq('user_id', userId).eq('id', orderId).maybeSingle();
    if (error) throw new Error('TRADE_RECOVERY_ORDER_LOOKUP_FAILED');
    return data?.payload ? normalizeOrder(data.payload as TradingOrder) : null;
  }

  private async transitionLeaseOwned(
    order: TradingOrder,
    expectedState: TradingOrderState,
    expectedVersion: number,
    workerId: string,
    event: TradingOrderEvent,
    releaseLease: boolean,
  ) {
    const { data, error } = await this.client.rpc('transition_trade_recovery_order_atomic', {
      p_worker_id: workerId,
      p_user_id: order.userId,
      p_order_id: order.id,
      p_expected_state: expectedState,
      p_expected_version: expectedVersion,
      p_next_state: order.state,
      p_order_payload: normalizeOrder(order),
      p_event_payload: event,
      p_release_lease: releaseLease,
    });
    if (error) throw new Error('TRADE_RECOVERY_TRANSITION_FAILED');
    return data ? normalizeOrder(data as TradingOrder) : null;
  }
}

export class TradeRecoveryWorker {
  readonly workerId: string;
  private running = false;

  constructor(
    private source: TradeRecoveryWorkerSource,
    private options: TradeRecoveryWorkerOptions,
    workerId = randomUUID(),
  ) {
    this.workerId = workerId;
  }

  async runOnce(): Promise<TradeRecoveryWorkerResult> {
    const result: TradeRecoveryWorkerResult = {
      workerId: this.workerId,
      claimed: 0,
      reconciled: 0,
      pending: 0,
      manualReviewRequired: 0,
      failed: 0,
      leaseLost: 0,
      maxConcurrencyObserved: 0,
      exchangeOrdersSubmitted: false,
    };
    if (this.running) return result;
    this.running = true;
    try {
      const claimed = await this.source.claimRecoveryOrders(
        this.workerId, this.options.batchSize, this.options.leaseSeconds,
      );
      result.claimed = claimed.length;
      let cursor = 0;
      let active = 0;
      const workerCount = Math.min(this.options.concurrency, claimed.length);
      const consume = async () => {
        while (cursor < claimed.length) {
          const index = cursor;
          cursor += 1;
          active += 1;
          result.maxConcurrencyObserved = Math.max(result.maxConcurrencyObserved, active);
          try {
            const item = await this.processOne(claimed[index]);
            if (item === 'reconciled') result.reconciled += 1;
            else if (item === 'pending') result.pending += 1;
            else if (item === 'manual') result.manualReviewRequired += 1;
            else if (item === 'lease_lost') result.leaseLost += 1;
            else result.failed += 1;
          } finally {
            active -= 1;
          }
        }
      };
      await Promise.all(Array.from({ length: workerCount }, () => consume()));
      return result;
    } finally {
      this.running = false;
    }
  }

  private async processOne(claimed: TradingOrder): Promise<ItemResult> {
    let order = claimed;
    try {
      const prepared = await this.source.prepareRecoveryOrder(order, this.workerId);
      if (!prepared) return 'lease_lost';
      order = prepared;
      const plan = await this.source.getPlan(order.userId, order.planId);
      if (!plan) {
        const failed = await this.source.recordFailure(
          order, this.workerId, 'TRADE_RECOVERY_PLAN_NOT_FOUND', true,
        );
        return failed?.manualReviewRequired ? 'manual' : failed ? 'failed' : 'lease_lost';
      }
      const repository = this.source.repositoryFor(order.userId, this.workerId);
      const reconciled = await new TradeOrderRecoveryService(repository)
        .reconcile(order.userId, plan, order);
      if (reconciled.manualReviewRequired) return 'manual';
      return reconciled.state === 'RECOVERY_REQUIRED' ? 'pending' : 'reconciled';
    } catch (error) {
      const failed = await this.source.recordFailure(order, this.workerId, errorCode(error));
      if (!failed) return 'lease_lost';
      return failed.manualReviewRequired ? 'manual' : 'failed';
    }
  }
}

export type TradeRecoveryWorkerControl = {
  worker: TradeRecoveryWorker;
  stop: () => void;
};

export function startTradeRecoveryWorker(): TradeRecoveryWorkerControl | null {
  const enabled = process.env.TRADE_RECOVERY_WORKER_ENABLED === 'true';
  const privateLookupEnabled = process.env.TRADE_PRIVATE_RECOVERY_LOOKUP_ENABLED === 'true';
  if (!enabled || !privateLookupEnabled) {
    console.log('[trade-recovery-worker] disabled; explicit worker and private-lookup flags are required');
    return null;
  }
  if (!hasSupabaseServerKey()) {
    console.error('[trade-recovery-worker] blocked: service-role Supabase configuration is required');
    return null;
  }

  const options: TradeRecoveryWorkerOptions = {
    batchSize: boundedInteger(process.env.TRADE_RECOVERY_BATCH_SIZE, 20, 1, 100),
    concurrency: boundedInteger(process.env.TRADE_RECOVERY_CONCURRENCY, 3, 1, 10),
    leaseSeconds: boundedInteger(process.env.TRADE_RECOVERY_LEASE_SECONDS, 90, 15, 600),
  };
  const intervalMs = boundedInteger(process.env.TRADE_RECOVERY_INTERVAL_MS, 30_000, 10_000, 300_000);
  const worker = new TradeRecoveryWorker(new SupabaseTradeRecoveryWorkerSource(), options);
  const tick = async () => {
    try {
      const result = await worker.runOnce();
      if (result.claimed > 0) {
        console.log('[trade-recovery-worker] cycle', {
          claimed: result.claimed,
          reconciled: result.reconciled,
          pending: result.pending,
          manualReviewRequired: result.manualReviewRequired,
          failed: result.failed,
          leaseLost: result.leaseLost,
          maxConcurrencyObserved: result.maxConcurrencyObserved,
          exchangeOrdersSubmitted: false,
        });
      }
    } catch (error) {
      console.error('[trade-recovery-worker] cycle failed', { errorCode: errorCode(error, 'TRADE_RECOVERY_CYCLE_FAILED') });
    }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return { worker, stop: () => clearInterval(timer) };
}
