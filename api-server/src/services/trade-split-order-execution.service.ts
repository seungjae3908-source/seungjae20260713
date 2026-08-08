import { randomUUID } from 'node:crypto';
import type { TradingOrder, TradingOrderEvent, TradingOrderState, TradingPlan } from './trade-automation.types';
import {
  aggregateSplitOrderState,
  assertNextSplitOrderReady,
  materializeSplitOrders,
  splitOrderLeg,
  type SplitTradingOrder,
} from './trade-split-order-materializer.service';
import type { SplitOrderRepository } from './trade-split-order.repository';

const MAX_REVALIDATION_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;
const MAX_DATA_DELAY_MS = 5_000;
const FAST_MOVE_PERCENT = 5;
const MAINTAINED_SIGNAL_STATES = new Set(['condition_maintained', 'entry_ready', 'approved', 'READY_FOR_APPROVAL']);

export type SplitChildExecutionPayload = {
  orderId: string;
  clientOrderId: string;
  exchange: SplitTradingOrder['exchange'];
  requestedQuantity: number | null;
  requestedQuoteAmount: number | null;
};

export type SplitExecutionSnapshot = {
  orders: SplitTradingOrder[];
  executable: SplitTradingOrder | null;
  aggregateState: TradingOrderState;
  providerPayload: SplitChildExecutionPayload | null;
};

export type SplitLegRevalidationEvidence = {
  checkedAt: string;
  signalValid: boolean;
  riskValid: boolean;
  trendValid: boolean;
  volumeValid: boolean;
  volatilityValid: boolean;
  dataValid: boolean;
  oneMinuteMovePercent: number;
};

export interface SplitOrderSafetyPort {
  invalidateSignal(input: {
    userId: string;
    planId: string;
    approvedPlanVersion: number;
    reason: string;
  }): Promise<void>;
  handleRisk(input: {
    userId: string;
    planId: string;
    approvedPlanVersion: number;
    reason: string;
  }): Promise<void>;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function freshTimestamp(value: string | null | undefined, now: Date, maximumAgeMs: number) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed)
    && parsed <= now.getTime() + MAX_FUTURE_SKEW_MS
    && now.getTime() - parsed <= maximumAgeMs;
}

function event(order: SplitTradingOrder, fromState: TradingOrderState | null, toState: TradingOrderState, reason: string): TradingOrderEvent {
  return {
    id: randomUUID(),
    userId: order.userId,
    orderId: order.id,
    fromState,
    toState,
    reason,
    metadata: {
      planId: order.planId,
      legSequenceNo: order.legSequenceNo,
      parentPlanVersion: order.parentPlanVersion,
      orderSubmissionAttempted: false,
    },
    createdAt: new Date().toISOString(),
  };
}

function executableOrder(orders: SplitTradingOrder[]) {
  const active = orders.filter((order) => order.state === 'SUBMITTED');
  if (active.length > 1) throw new Error('TRADE_SPLIT_MULTIPLE_ACTIVE_CHILDREN');
  const order = active[0] ?? null;
  if (order) assertNextSplitOrderReady(order, orders);
  return order;
}

function stopStillValid(plan: TradingPlan, currentPrice: number | null | undefined) {
  if (!finite(currentPrice) || currentPrice <= 0 || !finite(plan.stopPrice) || plan.stopPrice <= 0) return false;
  return plan.side === 'buy' || plan.side === 'long'
    ? currentPrice > plan.stopPrice
    : currentPrice < plan.stopPrice;
}

export function buildSplitLegRevalidationEvidence(
  plan: TradingPlan,
  order: TradingOrder,
  now = new Date(),
): SplitLegRevalidationEvidence {
  const snapshot = order.preSubmissionSnapshot;
  const signalValid = Boolean(snapshot?.signalState && MAINTAINED_SIGNAL_STATES.has(snapshot.signalState));
  const riskValid = order.preSubmissionDecision?.allowed === true;
  const currentPrice = snapshot?.currentPrice;
  const liquidity = snapshot?.availableLiquidityKrw;
  const oneMinuteMovePercent = finite(snapshot?.oneMinuteMovePercent)
    ? snapshot.oneMinuteMovePercent
    : Number.NaN;
  const dataValid = Boolean(snapshot)
    && freshTimestamp(snapshot?.observedAt, now, MAX_REVALIDATION_AGE_MS)
    && freshTimestamp(snapshot?.riskObservedAt, now, MAX_REVALIDATION_AGE_MS)
    && finite(snapshot?.dataDelayMs)
    && snapshot.dataDelayMs >= 0
    && snapshot.dataDelayMs <= MAX_DATA_DELAY_MS;
  return {
    checkedAt: order.preSubmissionCheckedAt ?? '',
    signalValid,
    riskValid,
    trendValid: signalValid && stopStillValid(plan, currentPrice),
    volumeValid: finite(liquidity) && liquidity >= plan.estimatedKrw,
    volatilityValid: finite(oneMinuteMovePercent) && Math.abs(oneMinuteMovePercent) < FAST_MOVE_PERCENT,
    dataValid,
    oneMinuteMovePercent,
  };
}

function revalidationBlockCodes(evidence: SplitLegRevalidationEvidence, now = new Date()) {
  const blockCodes: string[] = [];
  const checkedAt = Date.parse(evidence.checkedAt);
  if (!Number.isFinite(checkedAt)) blockCodes.push('SPLIT_REVALIDATION_TIMESTAMP_INVALID');
  else if (checkedAt > now.getTime() + MAX_FUTURE_SKEW_MS) blockCodes.push('SPLIT_REVALIDATION_FROM_FUTURE');
  else if (now.getTime() - checkedAt > MAX_REVALIDATION_AGE_MS) blockCodes.push('SPLIT_REVALIDATION_STALE');
  if (evidence.signalValid !== true) blockCodes.push('SPLIT_SIGNAL_INVALID');
  if (evidence.riskValid !== true) blockCodes.push('SPLIT_RISK_INVALID');
  if (evidence.trendValid !== true) blockCodes.push('SPLIT_TREND_INVALID');
  if (evidence.volumeValid !== true) blockCodes.push('SPLIT_VOLUME_INVALID');
  if (evidence.volatilityValid !== true) blockCodes.push('SPLIT_VOLATILITY_INVALID');
  if (evidence.dataValid !== true) blockCodes.push('SPLIT_DATA_INVALID');
  if (!Number.isFinite(evidence.oneMinuteMovePercent)) blockCodes.push('SPLIT_VOLATILITY_UNKNOWN');
  else if (Math.abs(evidence.oneMinuteMovePercent) >= FAST_MOVE_PERCENT) blockCodes.push('FAST_MOVE_DETECTED');
  return [...new Set(blockCodes)];
}

export function splitChildProviderPayload(order: SplitTradingOrder): SplitChildExecutionPayload {
  if (order.state !== 'SUBMITTED') throw new Error('TRADE_SPLIT_CHILD_NOT_EXECUTABLE');
  return {
    orderId: order.id,
    clientOrderId: order.clientOrderId,
    exchange: order.exchange,
    requestedQuantity: order.requestedQuantity,
    requestedQuoteAmount: order.requestedQuoteAmount,
  };
}

export class TradeSplitOrderExecutionService {
  constructor(
    private repository: SplitOrderRepository,
    private safety: SplitOrderSafetyPort | null = null,
  ) {}

  async ensureChildren(plan: TradingPlan): Promise<SplitExecutionSnapshot> {
    if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
    const version = Number(plan.version ?? 0);
    let orders = await this.repository.listOrdersByPlan(plan.userId, plan.id, version);
    if (orders.length === 0) {
      const materialized = materializeSplitOrders(plan);
      const created = await this.repository.createSplitOrdersAtomic({
        userId: plan.userId,
        planId: plan.id,
        expectedPlanState: 'SUBMITTED',
        expectedPlanVersion: version,
        legs: materialized.map(splitOrderLeg),
        orders: materialized,
        events: materialized.map((order) => event(order, null, order.state, 'SPLIT_CHILD_CREATED')),
      });
      if (!created) throw new Error('TRADE_SPLIT_ATOMIC_CREATE_FAILED');
      orders = created;
    }
    return this.snapshot(orders);
  }

  async activateAfterFill(
    filled: SplitTradingOrder,
    evidence: SplitLegRevalidationEvidence,
  ): Promise<SplitExecutionSnapshot> {
    if (filled.state !== 'FILLED') throw new Error('TRADE_SPLIT_PREVIOUS_CHILD_NOT_FILLED');
    let orders = await this.repository.listOrdersByPlan(filled.userId, filled.planId, filled.parentPlanVersion);
    const current = orders.find((order) => order.id === filled.id);
    if (!current || current.state !== 'FILLED') throw new Error('TRADE_SPLIT_FILLED_CHILD_NOT_PERSISTED');
    const next = orders.find((order) => order.legSequenceNo === filled.legSequenceNo + 1) ?? null;
    if (!next || next.state !== 'PLANNED') return this.snapshot(orders);

    const blockCodes = revalidationBlockCodes(evidence);
    if (blockCodes.length > 0) {
      const cancelRemaining = blockCodes.includes('FAST_MOVE_DETECTED') || blockCodes.includes('SPLIT_SIGNAL_INVALID');
      if (cancelRemaining) {
        const pending = orders.filter((order) => order.state === 'PLANNED' && order.legSequenceNo >= next.legSequenceNo);
        const canceled = await this.repository.cancelPlannedChildrenAtomic({
          userId: filled.userId,
          planId: filled.planId,
          approvedPlanVersion: filled.parentPlanVersion,
          fromSequenceNo: next.legSequenceNo,
          events: pending.map((order) => event(
            order,
            'PLANNED',
            'CANCELED',
            blockCodes.includes('FAST_MOVE_DETECTED')
              ? 'FAST_MOVE_DETECTED_CANCEL_PENDING_SPLIT'
              : 'SIGNAL_INVALIDATED_CANCEL_PENDING_SPLIT',
          )),
        });
        if (!canceled) throw new Error('TRADE_SPLIT_CANCEL_CONCURRENTLY_CHANGED');
        orders = canceled;
        if (!this.safety) throw new Error(`TRADE_SPLIT_SAFETY_HANDLER_UNAVAILABLE:${blockCodes.join(',')}`);
        await this.safety.invalidateSignal({
          userId: filled.userId,
          planId: filled.planId,
          approvedPlanVersion: filled.parentPlanVersion,
          reason: blockCodes.includes('FAST_MOVE_DETECTED') ? 'FAST_MOVE_DETECTED' : 'SPLIT_SIGNAL_INVALID',
        });
        if (blockCodes.includes('FAST_MOVE_DETECTED')) {
          await this.safety.handleRisk({
            userId: filled.userId,
            planId: filled.planId,
            approvedPlanVersion: filled.parentPlanVersion,
            reason: 'FAST_MOVE_DETECTED',
          });
        }
      }
      throw new Error(`TRADE_SPLIT_REVALIDATION_FAILED:${blockCodes.join(',')}`);
    }

    assertNextSplitOrderReady(next, orders);
    const activated = await this.repository.activateNextChildAtomic(
      { ...next, state: 'PLANNED', updatedAt: new Date().toISOString() },
      event(next, 'PLANNED', 'SUBMITTED', 'SPLIT_REVALIDATION_PASSED'),
    );
    if (!activated) throw new Error('TRADE_SPLIT_CHILD_CONCURRENTLY_CHANGED');
    orders = orders.map((order) => order.id === activated.id ? activated : order);
    return this.snapshot(orders);
  }

  async recoverLookupOnly(userId: string, planId: string, approvedPlanVersion: number) {
    const orders = await this.repository.listOrdersByPlan(userId, planId, approvedPlanVersion);
    return this.snapshot(orders);
  }

  private snapshot(orders: SplitTradingOrder[]): SplitExecutionSnapshot {
    const executable = executableOrder(orders);
    return {
      orders,
      executable,
      aggregateState: aggregateSplitOrderState(orders),
      providerPayload: executable ? splitChildProviderPayload(executable) : null,
    };
  }
}
