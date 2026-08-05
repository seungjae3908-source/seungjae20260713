import { randomUUID } from 'node:crypto';
import type { TradingOrderEvent, TradingOrderState, TradingPlan } from './trade-automation.types';
import {
  aggregateSplitOrderState,
  assertNextSplitOrderReady,
  materializeSplitOrders,
  splitOrderLeg,
  type SplitTradingOrder,
} from './trade-split-order-materializer.service';
import type { SplitOrderRepository } from './trade-split-order.repository';

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
  constructor(private repository: SplitOrderRepository) {}

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

  async activateAfterFill(filled: SplitTradingOrder): Promise<SplitExecutionSnapshot> {
    if (filled.state !== 'FILLED') throw new Error('TRADE_SPLIT_PREVIOUS_CHILD_NOT_FILLED');
    let orders = await this.repository.listOrdersByPlan(filled.userId, filled.planId, filled.parentPlanVersion);
    const current = orders.find((order) => order.id === filled.id);
    if (!current || current.state !== 'FILLED') throw new Error('TRADE_SPLIT_FILLED_CHILD_NOT_PERSISTED');
    const next = orders.find((order) => order.legSequenceNo === filled.legSequenceNo + 1) ?? null;
    if (next && next.state === 'PLANNED') {
      assertNextSplitOrderReady(next, orders);
      const activated = await this.repository.activateNextChildAtomic(
        { ...next, state: 'PLANNED', updatedAt: new Date().toISOString() },
        event(next, 'PLANNED', 'SUBMITTED', 'PREVIOUS_SPLIT_CHILD_FILLED'),
      );
      if (!activated) throw new Error('TRADE_SPLIT_CHILD_CONCURRENTLY_CHANGED');
      orders = orders.map((order) => order.id === activated.id ? activated : order);
    }
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
