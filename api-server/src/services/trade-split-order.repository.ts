import type { TradingOrderEvent, TradingOrderLeg, TradingOrderState } from './trade-automation.types';
import type { SplitTradingOrder } from './trade-split-order-materializer.service';

export type SplitOrderRpcResult = {
  data: unknown;
  error: unknown;
};

export interface SplitOrderDatabasePort {
  rpc(name: string, args: Record<string, unknown>): Promise<SplitOrderRpcResult>;
  listOrderPayloads(
    userId: string,
    planId: string,
    approvedPlanVersion?: number,
  ): Promise<SplitOrderRpcResult>;
}

export type CreateSplitOrdersInput = {
  userId: string;
  planId: string;
  expectedPlanState: TradingOrderState;
  expectedPlanVersion: number;
  legs: TradingOrderLeg[];
  orders: SplitTradingOrder[];
  events: TradingOrderEvent[];
};

export interface SplitOrderRepository {
  listOrdersByPlan(userId: string, planId: string, approvedPlanVersion?: number): Promise<SplitTradingOrder[]>;
  createSplitOrdersAtomic(input: CreateSplitOrdersInput): Promise<SplitTradingOrder[] | null>;
  activateNextChildAtomic(order: SplitTradingOrder, event: TradingOrderEvent): Promise<SplitTradingOrder | null>;
}

function storageError() {
  return new Error('TRADE_SPLIT_ORDER_STORAGE_UNAVAILABLE');
}

function assertOwner(actual: string, expected: string) {
  if (actual !== expected) throw new Error('USER_SCOPE_MISMATCH');
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseOrder(value: unknown): SplitTradingOrder {
  const candidate = record(value);
  if (!candidate
    || typeof candidate.id !== 'string'
    || typeof candidate.userId !== 'string'
    || typeof candidate.planId !== 'string'
    || typeof candidate.legId !== 'string'
    || typeof candidate.legKey !== 'string'
    || !Number.isInteger(candidate.legSequenceNo)
    || !Number.isInteger(candidate.legCount)
    || !Number.isInteger(candidate.parentPlanVersion)) {
    throw storageError();
  }
  return structuredClone(candidate) as SplitTradingOrder;
}

function parseOrderArray(value: unknown): SplitTradingOrder[] {
  if (!Array.isArray(value)) throw storageError();
  const orders = value.map(parseOrder).sort((left, right) => left.legSequenceNo - right.legSequenceNo);
  const seen = new Set<number>();
  for (const [index, order] of orders.entries()) {
    if (seen.has(order.legSequenceNo) || order.legSequenceNo !== index + 1 || order.legCount !== orders.length) {
      throw new Error('TRADE_SPLIT_CHILD_SEQUENCE_INVALID');
    }
    seen.add(order.legSequenceNo);
  }
  return orders;
}

function validateInput(input: CreateSplitOrdersInput) {
  const count = input.orders.length;
  if (!Number.isInteger(input.expectedPlanVersion) || input.expectedPlanVersion < 0
    || count < 1 || count > 20 || input.legs.length !== count || input.events.length !== count) {
    throw new Error('TRADE_SPLIT_ATOMIC_INPUT_INVALID');
  }

  for (const [index, order] of input.orders.entries()) {
    const leg = input.legs[index];
    const event = input.events[index];
    if (!leg || !event
      || order.userId !== input.userId
      || order.planId !== input.planId
      || order.parentPlanVersion !== input.expectedPlanVersion
      || order.approvedPlanVersion !== input.expectedPlanVersion
      || order.legSequenceNo !== index + 1
      || order.legCount !== count
      || order.legId !== leg.id
      || leg.planId !== input.planId
      || leg.sequenceNo !== index + 1
      || event.userId !== input.userId
      || event.orderId !== order.id
      || (index === 0 ? order.previousChildOrderId !== null : order.previousChildOrderId !== input.orders[index - 1]?.id)) {
      throw new Error('TRADE_SPLIT_CHILD_CONTRACT_INVALID');
    }
  }
}

export function createSplitOrderRepository(
  database: SplitOrderDatabasePort,
  authenticatedUserId: string,
): SplitOrderRepository {
  if (!authenticatedUserId) throw new Error('LOGIN_REQUIRED');

  return {
    async listOrdersByPlan(userId, planId, approvedPlanVersion) {
      assertOwner(userId, authenticatedUserId);
      const { data, error } = await database.listOrderPayloads(userId, planId, approvedPlanVersion);
      if (error) throw storageError();
      const rows = Array.isArray(data)
        ? data.map((item) => record(item)?.payload ?? item)
        : data;
      const orders = parseOrderArray(rows);
      for (const order of orders) {
        if (order.userId !== userId || order.planId !== planId
          || (approvedPlanVersion !== undefined && order.parentPlanVersion !== approvedPlanVersion)) {
          throw storageError();
        }
      }
      return orders;
    },

    async createSplitOrdersAtomic(input) {
      assertOwner(input.userId, authenticatedUserId);
      validateInput(input);
      const { data, error } = await database.rpc('create_trade_split_orders_atomic', {
        p_user_id: input.userId,
        p_plan_id: input.planId,
        p_expected_plan_state: input.expectedPlanState,
        p_expected_plan_version: input.expectedPlanVersion,
        p_leg_payloads: input.legs,
        p_order_payloads: input.orders,
        p_event_payloads: input.events,
      });
      if (error) throw storageError();
      if (data === null) return null;
      const orders = parseOrderArray(data);
      for (const order of orders) {
        if (order.userId !== input.userId || order.planId !== input.planId
          || order.parentPlanVersion !== input.expectedPlanVersion) throw storageError();
      }
      return orders;
    },

    async activateNextChildAtomic(order, event) {
      assertOwner(order.userId, authenticatedUserId);
      if (order.state !== 'PLANNED' || event.userId !== order.userId || event.orderId !== order.id) {
        throw new Error('TRADE_SPLIT_CHILD_CONTRACT_INVALID');
      }
      const { data, error } = await database.rpc('activate_next_trade_split_child_atomic', {
        p_user_id: order.userId,
        p_order_id: order.id,
        p_expected_version: order.version,
        p_order_payload: order,
        p_event_payload: event,
      });
      if (error) throw storageError();
      if (data === null) return null;
      const activated = parseOrder(data);
      if (activated.id !== order.id || activated.userId !== order.userId
        || activated.planId !== order.planId || activated.state !== 'SUBMITTED') throw storageError();
      return activated;
    },
  };
}
