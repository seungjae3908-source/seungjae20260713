import { createHash, randomUUID } from 'node:crypto';
import { assertOrderTransition } from './trade-order-state-machine.service';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingRepository } from './trade-automation.repository';
import type {
  TradingOrder, TradingOrderEvent, TradingOrderState, TradingPlan, TradingPlanInput, TradingPolicy,
} from './trade-automation.types';

const APPROVAL_TTL_MS = 10 * 60_000;

function orderVersion(order: TradingOrder) {
  return Number.isInteger(order.version) && Number(order.version) >= 0 ? Number(order.version) : 0;
}

function providerTimestamp(order: TradingOrder) {
  const parsed = Date.parse(order.exchangeUpdatedAt ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function authoritativeFillCorrection(
  current: TradingOrder,
  next: TradingOrder,
  toState: TradingOrderState,
  reason: string,
) {
  if (reason !== 'EXCHANGE_ORDER_RECONCILED' || toState !== 'FILLED' || current.state !== 'CANCELED') return false;
  if (next.filledQuantity <= current.filledQuantity) return false;
  if (current.exchangeOrderId && next.exchangeOrderId && current.exchangeOrderId !== next.exchangeOrderId) return false;
  const currentTimestamp = providerTimestamp(current);
  const nextTimestamp = providerTimestamp(next);
  return currentTimestamp === null || nextTimestamp === null || nextTimestamp >= currentTimestamp;
}

export function tradingIdempotencyKey(userId: string, input: TradingPlanInput) {
  return createHash('sha256').update([
    userId, input.exchange, input.signalId, input.strategyId, input.market, input.symbol.toUpperCase(), input.side,
  ].join(':')).digest('hex');
}

export function liveExecutionEnabled(exchange: TradingPlanInput['exchange']) {
  const global = process.env.ORDER_EXECUTION_ENABLED === 'true' && process.env.LIVE_TRADING_ACTIVATION_APPROVED === 'true';
  const perExchange = {
    bitget: process.env.BITGET_LIVE_ORDER_ENABLED === 'true',
    upbit: process.env.UPBIT_LIVE_ORDER_ENABLED === 'true',
    kiwoom: process.env.KIWOOM_LIVE_ORDER_ENABLED === 'true',
  };
  return global && perExchange[exchange];
}

export class TradeAutomationService {
  constructor(private repository: TradingRepository) {}

  private async emergencyStopActive(userId: string, policy: TradingPolicy) {
    return policy.emergencyStopped
      || process.env.TRADING_EMERGENCY_STOP === 'true'
      || await this.repository.getGlobalEmergencyStop();
  }

  async createPlan(userId: string, input: TradingPlanInput, policy: TradingPolicy, emergencyStopped: boolean) {
    const idempotencyKey = tradingIdempotencyKey(userId, input);
    const duplicate = await this.repository.findPlanByIdempotency(userId, idempotencyKey);
    if (duplicate) return { plan: duplicate, duplicate: true, decision: { allowed: true, blockCodes: [], warnings: [] } };

    const decision = evaluateTradingPlan(input, policy, {
      emergencyStopped: emergencyStopped || await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: input.accountMode !== 'live' || liveExecutionEnabled(input.exchange),
    });
    if (!decision.allowed) return { plan: null, duplicate: false, decision };

    const now = new Date();
    const approvalRequired = policy.mode === 'approval';
    const plan: TradingPlan = {
      ...input,
      id: randomUUID(), userId, idempotencyKey,
      state: approvalRequired ? 'APPROVAL_PENDING' : 'PLANNED',
      approvalExpiresAt: approvalRequired ? new Date(now.getTime() + APPROVAL_TTL_MS).toISOString() : null,
      approvedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await this.repository.savePlan(plan);
    return { plan, duplicate: false, decision };
  }

  async approvePlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    if (plan.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
    if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) {
      plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
      await this.repository.savePlan(plan);
      throw new Error('TRADE_PLAN_EXPIRED');
    }
    const policy = await this.repository.getPolicy(userId);
    const decision = evaluateTradingPlan(plan, policy, {
      emergencyStopped: await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: plan.accountMode !== 'live' || liveExecutionEnabled(plan.exchange),
    });
    if (!decision.allowed) {
      plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
      await this.repository.savePlan(plan);
      throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
    }
    plan.state = 'SUBMITTED'; plan.approvedAt = new Date().toISOString(); plan.updatedAt = plan.approvedAt;
    await this.repository.savePlan(plan);
    return plan;
  }

  async beginAutomaticPlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    if (plan.state !== 'PLANNED') throw new Error('TRADE_PLAN_NOT_READY');
    const policy = await this.repository.getPolicy(userId);
    if (await this.emergencyStopActive(userId, policy)) throw new Error('EMERGENCY_STOP_ACTIVE');
    plan.state = 'SUBMITTED'; plan.updatedAt = new Date().toISOString();
    await this.repository.savePlan(plan);
    return plan;
  }

  async createOrder(userId: string, plan: TradingPlan) {
    const existing = await this.repository.findOrderByPlan(userId, plan.id);
    if (existing) return { order: existing, duplicate: true };
    if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
    const now = new Date().toISOString();
    const order: TradingOrder = {
      id: randomUUID(), userId, planId: plan.id, exchange: plan.exchange,
      clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
      exchangeOrderId: null, state: 'SUBMITTED', requestedQuantity: plan.quantity ?? null,
      filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
      createdAt: now, updatedAt: now,
    };
    await this.repository.saveOrder(order);
    await this.event(order, null, 'SUBMITTED', 'ORDER_CREATED', { accountMode: plan.accountMode });
    return { order, duplicate: false };
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    const from = order.state;
    assertOrderTransition(from, toState);
    const next: TradingOrder = { ...order, state: toState, updatedAt: new Date().toISOString() };
    if (typeof metadata.exchangeOrderId === 'string') next.exchangeOrderId = metadata.exchangeOrderId;
    if (typeof metadata.filledQuantity === 'number') next.filledQuantity = metadata.filledQuantity;
    if (typeof metadata.averageFillPrice === 'number') next.averageFillPrice = metadata.averageFillPrice;
    if (typeof metadata.errorCode === 'string') next.lastErrorCode = metadata.errorCode;

    let result = await this.repository.transitionOrderAtomic(
      next,
      from,
      orderVersion(order),
      this.orderEvent(next, from, toState, reason, metadata),
    );

    if (!result.applied && authoritativeFillCorrection(result.order, next, toState, reason)) {
      const corrected: TradingOrder = {
        ...result.order,
        ...next,
        state: 'FILLED',
        version: orderVersion(result.order),
        updatedAt: new Date().toISOString(),
      };
      result = await this.repository.transitionOrderAtomic(
        corrected,
        'CANCELED',
        orderVersion(result.order),
        this.orderEvent(corrected, 'CANCELED', 'FILLED', 'EXCHANGE_FILL_CORRECTED_AFTER_CANCEL_RACE', {
          ...metadata,
          previousTerminalState: 'CANCELED',
          correctedFilledQuantity: corrected.filledQuantity,
          orderSubmissionAttempted: false,
        }),
      );
    }

    Object.assign(order, result.order);
    return order;
  }

  async recoverOpenOrders(userId: string) {
    const orders = await this.repository.listOrders(userId);
    const recoverable = orders.filter((order) => [
      'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED',
    ].includes(order.state));
    for (const order of recoverable) {
      if (order.state !== 'RECOVERY_REQUIRED') {
        await this.transition(order, 'RECOVERY_REQUIRED', 'SERVER_RESTART_RECONCILIATION_REQUIRED');
      }
    }
    return recoverable;
  }

  async invalidatePlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    const order = await this.repository.findOrderByPlan(userId, planId);
    if (!order) {
      if (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED') {
        plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
        await this.repository.savePlan(plan);
      }
      return { plan, order: null, filledQuantityPreserved: 0 };
    }
    if (order.state === 'ACCEPTED' || order.state === 'PARTIALLY_FILLED') {
      await this.transition(order, 'CANCEL_REQUESTED', 'SIGNAL_INVALIDATED_CANCEL_UNFILLED_REMAINDER', {
        filledQuantity: order.filledQuantity,
        invalidateAction: plan.invalidateAction ?? 'hold',
      });
    }
    return { plan, order, filledQuantityPreserved: order.filledQuantity };
  }

  private orderEvent(
    order: TradingOrder,
    fromState: TradingOrderState | null,
    toState: TradingOrderState,
    reason: string,
    metadata: Record<string, unknown>,
  ): TradingOrderEvent {
    return {
      id: randomUUID(), userId: order.userId, orderId: order.id, fromState, toState,
      reason, metadata, createdAt: new Date().toISOString(),
    };
  }

  private async event(
    order: TradingOrder, fromState: TradingOrderState | null, toState: TradingOrderState,
    reason: string, metadata: Record<string, unknown>,
  ) {
    await this.repository.appendEvent(this.orderEvent(order, fromState, toState, reason, metadata));
  }
}
