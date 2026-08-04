import { createHash, randomUUID } from 'node:crypto';
import { assertOrderTransition } from './trade-order-state-machine.service';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingRepository } from './trade-automation.repository';
import type {
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
  TradingPlanInput,
  TradingPlanRevalidationInput,
  TradingPolicy,
} from './trade-automation.types';

const APPROVAL_TTL_MS = 10 * 60_000;

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

function applyRevalidation(plan: TradingPlan, revalidation: TradingPlanRevalidationInput) {
  plan.marketSnapshot = revalidation.marketSnapshot;
  plan.signalState = revalidation.signalState ?? plan.signalState;
  plan.signalExpiresAt = revalidation.signalExpiresAt ?? plan.signalExpiresAt;
  plan.entryPrice = revalidation.entryPrice ?? plan.entryPrice;
  plan.entryZoneLow = revalidation.entryZoneLow ?? plan.entryZoneLow;
  plan.entryZoneHigh = revalidation.entryZoneHigh ?? plan.entryZoneHigh;
  plan.estimatedSlippagePercent = revalidation.estimatedSlippagePercent ?? plan.estimatedSlippagePercent;
  plan.averageSpreadPercent = revalidation.averageSpreadPercent ?? plan.averageSpreadPercent;
  plan.economics = revalidation.economics ?? plan.economics;
  plan.updatedAt = new Date().toISOString();
}

export class TradeAutomationService {
  constructor(private repository: TradingRepository) {}

  private async emergencyStopActive(userId: string, policy: TradingPolicy) {
    return policy.emergencyStopped
      || process.env.TRADING_EMERGENCY_STOP === 'true'
      || await this.repository.getGlobalEmergencyStop();
  }

  private async recheck(userId: string, plan: TradingPlan, policy?: TradingPolicy) {
    const currentPolicy = policy ?? await this.repository.getPolicy(userId);
    const decision = evaluateTradingPlan(plan, currentPolicy, {
      emergencyStopped: await this.emergencyStopActive(userId, currentPolicy),
      serverLiveEnabled: plan.accountMode !== 'live' || liveExecutionEnabled(plan.exchange),
    });
    plan.riskAssessment = decision.optimization ?? null;
    return decision;
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
      riskAssessment: decision.optimization ?? null,
    };
    await this.repository.savePlan(plan);
    return { plan, duplicate: false, decision };
  }

  async approvePlan(userId: string, planId: string, revalidation?: TradingPlanRevalidationInput | null) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    if (plan.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
    if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) {
      plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
      await this.repository.savePlan(plan);
      throw new Error('TRADE_PLAN_EXPIRED');
    }
    if (plan.accountMode === 'live' && !revalidation) throw new Error('TRADE_PLAN_REVALIDATION_REQUIRED');
    if (revalidation) applyRevalidation(plan, revalidation);
    const policy = await this.repository.getPolicy(userId);
    const decision = await this.recheck(userId, plan, policy);
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
    const decision = await this.recheck(userId, plan, policy);
    if (!decision.allowed) {
      plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
      await this.repository.savePlan(plan);
      throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
    }
    plan.state = 'SUBMITTED'; plan.updatedAt = new Date().toISOString();
    await this.repository.savePlan(plan);
    return plan;
  }

  async createOrder(userId: string, plan: TradingPlan) {
    const existing = await this.repository.findOrderByPlan(userId, plan.id);
    if (existing) return { order: existing, duplicate: true };
    if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
    const decision = await this.recheck(userId, plan);
    if (!decision.allowed) throw new Error(`TRADE_ORDER_FINAL_RISK_CHECK_FAILED:${decision.blockCodes.join(',')}`);
    const now = new Date().toISOString();
    const order: TradingOrder = {
      id: randomUUID(), userId, planId: plan.id, exchange: plan.exchange,
      clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
      exchangeOrderId: null, state: 'SUBMITTED', requestedQuantity: plan.quantity ?? null,
      filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
      createdAt: now, updatedAt: now,
    };
    await this.repository.saveOrder(order);
    await this.event(order, null, 'SUBMITTED', 'ORDER_CREATED', {
      accountMode: plan.accountMode,
      expectedValueR: plan.riskAssessment?.expectedValueR ?? null,
      riskBudgetKrw: plan.riskAssessment?.riskBudgetKrw ?? null,
      maximumOrderKrw: plan.riskAssessment?.maximumOrderKrw ?? null,
      pilotStage: plan.riskAssessment?.pilotStage ?? null,
    });
    return { order, duplicate: false };
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    const from = order.state;
    assertOrderTransition(from, toState);
    order.state = toState; order.updatedAt = new Date().toISOString();
    if (typeof metadata.exchangeOrderId === 'string') order.exchangeOrderId = metadata.exchangeOrderId;
    if (typeof metadata.filledQuantity === 'number') order.filledQuantity = metadata.filledQuantity;
    if (typeof metadata.averageFillPrice === 'number') order.averageFillPrice = metadata.averageFillPrice;
    if (typeof metadata.errorCode === 'string') order.lastErrorCode = metadata.errorCode;
    await this.repository.saveOrder(order);
    await this.event(order, from, toState, reason, metadata);
    return order;
  }

  async recoverOpenOrders(userId: string) {
    const orders = await this.repository.listOrders(userId);
    const recoverable = orders.filter((order) => ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED'].includes(order.state));
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

  private async event(
    order: TradingOrder, fromState: TradingOrderState | null, toState: TradingOrderState,
    reason: string, metadata: Record<string, unknown>,
  ) {
    const event: TradingOrderEvent = {
      id: randomUUID(), userId: order.userId, orderId: order.id, fromState, toState,
      reason, metadata, createdAt: new Date().toISOString(),
    };
    await this.repository.appendEvent(event);
  }
}
