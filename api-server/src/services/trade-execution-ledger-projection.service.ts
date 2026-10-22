import type { TradingRepository } from './trade-automation.repository';
import type {
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

const TERMINAL_STATES = new Set<TradingOrderState>(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

export type CanonicalExecutionTruthPhase =
  | 'STABLE'
  | 'RECONCILING'
  | 'MANUAL_REVIEW'
  | 'TERMINAL';

export type CanonicalSubmissionOutcome =
  | 'NOT_ATTEMPTED'
  | 'UNKNOWN'
  | 'PROVIDER_IDENTIFIED'
  | 'TERMINAL_CONFIRMED';

export type CanonicalExecutionLedgerEntry = Readonly<{
  orderId: string;
  planId: string;
  exchange: TradingOrder['exchange'];
  market: string | null;
  symbol: string | null;
  clientOrderId: string;
  exchangeOrderId: string | null;
  orderState: TradingOrderState;
  truthPhase: CanonicalExecutionTruthPhase;
  submissionOutcome: CanonicalSubmissionOutcome;
  requestedQuantity: number | null;
  filledQuantity: number;
  remainingQuantity: number | null;
  averageFillPrice: number | null;
  partialFillPreserved: boolean;
  providerStatusCode: string | null;
  lastReconciledAt: string | null;
  manualReviewRequired: boolean;
  safeToResubmit: boolean;
  cancellationIntent: boolean;
  submissionAttemptId: string | null;
  submissionStartedAt: string | null;
  orderedAt: string;
  updatedAt: string;
  latestEventAt: string | null;
  latestEventReason: string | null;
  latestEventState: TradingOrderState | null;
  lastErrorCode: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  protectionStatus: TradingOrder['protectionStatus'];
  protectionErrorCode: string | null;
  eventCount: number;
  integrityBlockers: readonly string[];
  canonicalSource: 'trade_orders+trade_order_events+trade_order_plans';
  readOnly: true;
  providerMutationAllowed: false;
}>;

function finiteQuantity(value: number | null | undefined) {
  if (value === null || value === undefined) return null;
  return Number.isFinite(value) ? value : null;
}

function truthPhase(order: TradingOrder): CanonicalExecutionTruthPhase {
  if (TERMINAL_STATES.has(order.state)) return 'TERMINAL';
  if (order.manualReviewRequired === true) return 'MANUAL_REVIEW';
  if (order.state === 'RECOVERY_REQUIRED' || order.state === 'CANCEL_REQUESTED') return 'RECONCILING';
  if (order.submissionStartedAt && !order.exchangeOrderId) return 'RECONCILING';
  return 'STABLE';
}

function submissionOutcome(order: TradingOrder): CanonicalSubmissionOutcome {
  if (TERMINAL_STATES.has(order.state)) return 'TERMINAL_CONFIRMED';
  if (order.exchangeOrderId) return 'PROVIDER_IDENTIFIED';
  if (order.submissionStartedAt) return 'UNKNOWN';
  return 'NOT_ATTEMPTED';
}

function countBy<T>(values: readonly T[], key: (value: T) => string | null) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const resolved = key(value);
    if (!resolved) continue;
    counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
  }
  return counts;
}

function eventChain(events: readonly TradingOrderEvent[]) {
  return [...events].sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  ));
}

function integrityBlockers(
  order: TradingOrder,
  plan: TradingPlan | null,
  events: readonly TradingOrderEvent[],
  planCounts: ReadonlyMap<string, number>,
  clientCounts: ReadonlyMap<string, number>,
  exchangeOrderCounts: ReadonlyMap<string, number>,
) {
  const blockers: string[] = [];
  if (!plan) blockers.push('CANONICAL_PLAN_MISSING');
  if ((planCounts.get(order.planId) ?? 0) > 1) blockers.push('CANONICAL_PLAN_HAS_MULTIPLE_ORDERS');
  if ((clientCounts.get(`${order.exchange}:${order.clientOrderId}`) ?? 0) > 1) {
    blockers.push('CANONICAL_CLIENT_ORDER_ID_DUPLICATED');
  }
  if (order.exchangeOrderId
    && (exchangeOrderCounts.get(`${order.exchange}:${order.exchangeOrderId}`) ?? 0) > 1) {
    blockers.push('CANONICAL_EXCHANGE_ORDER_ID_DUPLICATED');
  }

  const requested = finiteQuantity(order.requestedQuantity);
  const remaining = finiteQuantity(order.remainingQuantity);
  if (requested !== null && order.filledQuantity > requested + 1e-12) {
    blockers.push('CANONICAL_FILLED_QUANTITY_EXCEEDS_REQUESTED');
  }
  if (remaining !== null && remaining < -1e-12) blockers.push('CANONICAL_REMAINING_QUANTITY_NEGATIVE');

  const chain = eventChain(events);
  const latest = chain.at(-1) ?? null;
  if (chain.length === 0) blockers.push('CANONICAL_EVENT_CHAIN_MISSING');
  if (latest && latest.toState !== order.state) blockers.push('CANONICAL_EVENT_STATE_DRIFT');
  if (TERMINAL_STATES.has(order.state) && order.nextRetryAt) blockers.push('CANONICAL_TERMINAL_RETRY_PENDING');
  return [...new Set(blockers)];
}

export class TradeExecutionLedgerProjectionService {
  constructor(private repository: TradingRepository) {}

  async list(userId: string) {
    const [orders, plans, events] = await Promise.all([
      this.repository.listOrders(userId),
      this.repository.listPlans(userId),
      this.repository.listEvents(userId),
    ]);

    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const eventsByOrder = new Map<string, TradingOrderEvent[]>();
    for (const event of events) {
      const current = eventsByOrder.get(event.orderId) ?? [];
      current.push(event);
      eventsByOrder.set(event.orderId, current);
    }

    const planCounts = countBy(orders, (order) => order.planId);
    const clientCounts = countBy(orders, (order) => `${order.exchange}:${order.clientOrderId}`);
    const exchangeOrderCounts = countBy(
      orders,
      (order) => order.exchangeOrderId ? `${order.exchange}:${order.exchangeOrderId}` : null,
    );

    const entries: CanonicalExecutionLedgerEntry[] = orders.map((order) => {
      const plan = planById.get(order.planId) ?? null;
      const chain = eventChain(eventsByOrder.get(order.id) ?? []);
      const latest = chain.at(-1) ?? null;
      const cancellationIntent = Boolean(order.cancelRequestClaimId || order.cancelRequestedAt);
      const terminal = TERMINAL_STATES.has(order.state);
      const unknownSubmission = Boolean(order.submissionStartedAt)
        && !order.exchangeOrderId
        && !terminal;

      return Object.freeze({
        orderId: order.id,
        planId: order.planId,
        exchange: order.exchange,
        market: plan?.market ?? null,
        symbol: plan?.symbol ?? null,
        clientOrderId: order.clientOrderId,
        exchangeOrderId: order.exchangeOrderId,
        orderState: order.state,
        truthPhase: truthPhase(order),
        submissionOutcome: submissionOutcome(order),
        requestedQuantity: finiteQuantity(order.requestedQuantity),
        filledQuantity: order.filledQuantity,
        remainingQuantity: finiteQuantity(order.remainingQuantity),
        averageFillPrice: order.averageFillPrice,
        partialFillPreserved: order.filledQuantity > 0
          && (order.state === 'CANCELED' || order.state === 'PARTIALLY_FILLED' || cancellationIntent),
        providerStatusCode: order.providerStatusCode ?? null,
        lastReconciledAt: order.lastReconciledAt ?? null,
        manualReviewRequired: order.manualReviewRequired === true,
        safeToResubmit: order.state === 'SUBMITTED'
          && !order.executionClaimId
          && !order.submissionStartedAt
          && !order.submissionAttemptId
          && !order.exchangeOrderId
          && !order.cancelRequestClaimId
          && order.manualReviewRequired !== true
          && !unknownSubmission,
        cancellationIntent,
        submissionAttemptId: order.submissionAttemptId ?? null,
        submissionStartedAt: order.submissionStartedAt ?? null,
        orderedAt: order.createdAt,
        updatedAt: order.updatedAt,
        latestEventAt: latest?.createdAt ?? null,
        latestEventReason: latest?.reason ?? null,
        latestEventState: latest?.toState ?? null,
        lastErrorCode: order.lastErrorCode ?? null,
        retryCount: order.retryCount,
        nextRetryAt: order.nextRetryAt ?? null,
        protectionStatus: order.protectionStatus,
        protectionErrorCode: order.protectionErrorCode ?? null,
        eventCount: chain.length,
        integrityBlockers: Object.freeze(integrityBlockers(
          order,
          plan,
          chain,
          planCounts,
          clientCounts,
          exchangeOrderCounts,
        )),
        canonicalSource: 'trade_orders+trade_order_events+trade_order_plans',
        readOnly: true,
        providerMutationAllowed: false,
      });
    });

    const summary = Object.freeze({
      total: entries.length,
      stable: entries.filter((entry) => entry.truthPhase === 'STABLE').length,
      reconciling: entries.filter((entry) => entry.truthPhase === 'RECONCILING').length,
      manualReview: entries.filter((entry) => entry.truthPhase === 'MANUAL_REVIEW').length,
      terminal: entries.filter((entry) => entry.truthPhase === 'TERMINAL').length,
      integrityBlocked: entries.filter((entry) => entry.integrityBlockers.length > 0).length,
      unknownSubmission: entries.filter((entry) => entry.submissionOutcome === 'UNKNOWN').length,
    });

    return Object.freeze({
      generatedAt: new Date().toISOString(),
      summary,
      entries: Object.freeze(entries),
      canonicalSource: 'trade_orders+trade_order_events+trade_order_plans' as const,
      readOnly: true as const,
      providerMutationAllowed: false as const,
    });
  }
}
