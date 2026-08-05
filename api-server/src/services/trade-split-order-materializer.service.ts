import type { TradingOrder, TradingOrderLeg, TradingOrderState, TradingPlan } from './trade-automation.types';
import { assertSplitLegTotals, buildEntrySplitLegs } from './trade-split-order-planner.service';

export type SplitTradingOrder = TradingOrder & {
  legId: string;
  legKey: string;
  legSequenceNo: number;
  legCount: number;
  requestedQuoteAmount: number | null;
  previousChildOrderId: string | null;
  parentPlanVersion: number;
};

const TERMINAL_STATES = new Set<TradingOrderState>(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
}

export function materializeSplitOrders(plan: TradingPlan, now = new Date().toISOString()): SplitTradingOrder[] {
  if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
  const legs = buildEntrySplitLegs(plan);
  assertSplitLegTotals(plan, legs);

  return legs.map((leg, index) => ({
    id: leg.id,
    userId: plan.userId,
    planId: plan.id,
    exchange: plan.exchange,
    clientOrderId: `sj-${plan.exchange}-${leg.idempotencyKey.slice(0, 20)}`,
    exchangeOrderId: null,
    state: index === 0 ? 'SUBMITTED' : 'PLANNED',
    version: 0,
    requestedQuantity: leg.plannedQuantity,
    requestedQuoteAmount: leg.plannedQuoteAmount,
    remainingQuantity: leg.plannedQuantity,
    filledQuantity: 0,
    averageFillPrice: null,
    retryCount: 0,
    lastErrorCode: null,
    approvedPlanVersion: planVersion(plan),
    parentPlanVersion: planVersion(plan),
    legId: leg.id,
    legKey: leg.legKey,
    legSequenceNo: leg.sequenceNo,
    legCount: legs.length,
    previousChildOrderId: index === 0 ? null : legs[index - 1]!.id,
    preSubmissionCheckedAt: null,
    preSubmissionDecision: null,
    preSubmissionSnapshot: null,
    createdAt: now,
    updatedAt: now,
  }));
}

export function assertNextSplitOrderReady(order: SplitTradingOrder, siblings: SplitTradingOrder[]) {
  if (order.state !== 'PLANNED' && order.state !== 'SUBMITTED') {
    throw new Error('TRADE_SPLIT_CHILD_NOT_EXECUTABLE');
  }
  if (order.legSequenceNo === 1) return;

  const previous = siblings.find((candidate) => candidate.id === order.previousChildOrderId);
  if (!previous) throw new Error('TRADE_SPLIT_PREVIOUS_CHILD_MISSING');
  if (previous.legSequenceNo !== order.legSequenceNo - 1) {
    throw new Error('TRADE_SPLIT_CHILD_SEQUENCE_INVALID');
  }
  if (previous.state !== 'FILLED') {
    throw new Error('TRADE_SPLIT_PREVIOUS_CHILD_NOT_FILLED');
  }
}

export function aggregateSplitOrderState(orders: SplitTradingOrder[]): TradingOrderState {
  if (orders.length === 0) throw new Error('TRADE_SPLIT_CHILDREN_REQUIRED');
  const sorted = [...orders].sort((left, right) => left.legSequenceNo - right.legSequenceNo);
  const seen = new Set<number>();
  for (const order of sorted) {
    if (seen.has(order.legSequenceNo)) throw new Error('TRADE_SPLIT_CHILD_SEQUENCE_DUPLICATE');
    seen.add(order.legSequenceNo);
  }

  if (sorted.every((order) => order.state === 'FILLED')) return 'FILLED';
  if (sorted.some((order) => order.state === 'RECOVERY_REQUIRED')) return 'RECOVERY_REQUIRED';
  if (sorted.some((order) => order.state === 'PARTIALLY_FILLED')) return 'PARTIALLY_FILLED';
  if (sorted.some((order) => order.filledQuantity > 0)) return 'PARTIALLY_FILLED';
  if (sorted.some((order) => order.state === 'ACCEPTED')) return 'ACCEPTED';
  if (sorted.some((order) => order.state === 'SUBMITTED')) return 'SUBMITTED';
  if (sorted.every((order) => TERMINAL_STATES.has(order.state))) {
    return sorted.some((order) => order.state === 'REJECTED') ? 'REJECTED' : 'CANCELED';
  }
  return 'PLANNED';
}

export function splitOrderLeg(order: SplitTradingOrder): TradingOrderLeg {
  return {
    id: order.legId,
    planId: order.planId,
    legKey: order.legKey,
    legType: 'ENTRY',
    sequenceNo: order.legSequenceNo,
    idempotencyKey: order.clientOrderId,
    plannedQuantity: order.requestedQuantity,
    plannedQuoteAmount: order.requestedQuoteAmount,
    plannedPrice: null,
    filledQuantity: order.filledQuantity,
    state: order.state,
    version: Number(order.version ?? 0),
  };
}
