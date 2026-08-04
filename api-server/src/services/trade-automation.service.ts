import { createHash, randomUUID } from 'node:crypto';
import { assertOrderTransition } from './trade-order-state-machine.service';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import {
  applySignalValidation,
  approvalStatus,
  initializeSignalLifecycle,
  SIGNAL_VALIDATION_MAX_AGE_MS,
} from './trade-signal-lifecycle.service';
import type { TradingRepository } from './trade-automation.repository';
import type {
  TradingOrder,
  TradingOrderEvent,
  TradingOrderState,
  TradingPlan,
  TradingPlanInput,
  TradingPolicy,
  TradingSignalValidationInput,
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

export class TradeAutomationService {
  constructor(private repository: TradingRepository) {}

  private async emergencyStopActive(userId: string, policy: TradingPolicy) {
    return policy.emergencyStopped
      || process.env.TRADING_EMERGENCY_STOP === 'true'
      || await this.repository.getGlobalEmergencyStop();
  }

  private hydrateSignalLifecycle(plan: TradingPlan) {
    if (!plan.signalState || !plan.lastSignalValidatedAt || !Array.isArray(plan.signalStateHistory)) {
      const fallbackDate = new Date(plan.updatedAt || plan.createdAt || Date.now());
      Object.assign(plan, initializeSignalLifecycle(plan, plan.approvalExpiresAt, fallbackDate));
    }
    return plan;
  }

  async createPlan(userId: string, input: TradingPlanInput, policy: TradingPolicy, emergencyStopped: boolean) {
    const idempotencyKey = tradingIdempotencyKey(userId, input);
    const duplicate = await this.repository.findPlanByIdempotency(userId, idempotencyKey);
    if (duplicate) {
      this.hydrateSignalLifecycle(duplicate);
      return {
        plan: duplicate,
        duplicate: true,
        decision: { allowed: true, blockCodes: [], warnings: [] },
        approval: approvalStatus(duplicate),
      };
    }

    const decision = evaluateTradingPlan(input, policy, {
      emergencyStopped: emergencyStopped || await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: input.accountMode !== 'live' || liveExecutionEnabled(input.exchange),
    });
    if (!decision.allowed) return { plan: null, duplicate: false, decision, approval: null };

    const now = new Date();
    const approvalRequired = policy.mode === 'approval';
    const approvalExpiresAt = approvalRequired
      ? new Date(now.getTime() + APPROVAL_TTL_MS).toISOString()
      : null;
    const lifecycle = initializeSignalLifecycle(input, approvalExpiresAt, now);
    const signalTerminal = lifecycle.signalState === 'INVALIDATED' || lifecycle.signalState === 'EXPIRED';
    const plan: TradingPlan = {
      ...input,
      ...lifecycle,
      id: randomUUID(),
      userId,
      idempotencyKey,
      state: signalTerminal ? 'EXPIRED' : approvalRequired ? 'APPROVAL_PENDING' : 'PLANNED',
      approvalExpiresAt,
      approvedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.repository.savePlan(plan);
    return { plan, duplicate: false, decision, approval: approvalStatus(plan) };
  }

  async getPlanStatus(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    this.hydrateSignalLifecycle(plan);
    return { plan, approval: approvalStatus(plan) };
  }

  async revalidatePlan(userId: string, planId: string, validation: TradingSignalValidationInput) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    this.hydrateSignalLifecycle(plan);
    const previousSignalState = plan.signalState;
    const { evaluation } = applySignalValidation(plan, validation);
    const signalTerminal = evaluation.state === 'INVALIDATED' || evaluation.state === 'EXPIRED';
    if (signalTerminal && (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED')) {
      plan.state = 'EXPIRED';
    }
    await this.repository.savePlan(plan);
    const order = await this.repository.findOrderByPlan(userId, plan.id);
    return {
      plan,
      order,
      approval: approvalStatus(plan),
      transition: {
        fromState: previousSignalState,
        toState: plan.signalState,
        reason: evaluation.reasonCode,
      },
      shouldCancelUnfilled: signalTerminal
        && Boolean(order && ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'].includes(order.state)),
    };
  }

  async approvePlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    this.hydrateSignalLifecycle(plan);
    const currentApproval = approvalStatus(plan);
    if (!currentApproval.approvalEnabled) {
      if (currentApproval.reasonCode === 'APPROVAL_EXPIRED' || currentApproval.reasonCode === 'SIGNAL_EXPIRED') {
        plan.state = 'EXPIRED';
        plan.signalState = 'EXPIRED';
        plan.signalInvalidationReason = currentApproval.reasonCode;
        plan.updatedAt = new Date().toISOString();
        await this.repository.savePlan(plan);
      }
      throw new Error(`TRADE_PLAN_SIGNAL_NOT_APPROVABLE:${currentApproval.reasonCode ?? 'UNKNOWN'}`);
    }

    const policy = await this.repository.getPolicy(userId);
    const decision = evaluateTradingPlan(plan, policy, {
      emergencyStopped: await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: plan.accountMode !== 'live' || liveExecutionEnabled(plan.exchange),
    });
    if (!decision.allowed) {
      applySignalValidation(plan, {
        score: plan.signalScore,
        confidence: plan.signalConfidence,
        coreConditionsMaintained: false,
        riskReward: plan.signalRiskReward,
        reasons: plan.signalReasons,
        warnings: [...plan.signalWarnings, ...decision.warnings],
        dataTimestamp: new Date().toISOString(),
        invalidationReason: `RISK_RECHECK_FAILED_${decision.blockCodes.join('_')}`,
      });
      plan.state = 'EXPIRED';
      await this.repository.savePlan(plan);
      throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
    }
    plan.state = 'SUBMITTED';
    plan.approvedAt = new Date().toISOString();
    plan.updatedAt = plan.approvedAt;
    await this.repository.savePlan(plan);
    return plan;
  }

  async beginAutomaticPlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    this.hydrateSignalLifecycle(plan);
    if (plan.state !== 'PLANNED') throw new Error('TRADE_PLAN_NOT_READY');
    const lastValidation = Date.parse(plan.lastSignalValidatedAt);
    if (plan.signalState !== 'READY_FOR_APPROVAL'
      || !Number.isFinite(lastValidation)
      || Date.now() - lastValidation > SIGNAL_VALIDATION_MAX_AGE_MS) {
      throw new Error('TRADE_PLAN_SIGNAL_NOT_READY');
    }
    const policy = await this.repository.getPolicy(userId);
    if (await this.emergencyStopActive(userId, policy)) throw new Error('EMERGENCY_STOP_ACTIVE');
    plan.state = 'SUBMITTED';
    plan.updatedAt = new Date().toISOString();
    await this.repository.savePlan(plan);
    return plan;
  }

  async createOrder(userId: string, plan: TradingPlan) {
    const existing = await this.repository.findOrderByPlan(userId, plan.id);
    if (existing) return { order: existing, duplicate: true };
    if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
    const now = new Date().toISOString();
    const order: TradingOrder = {
      id: randomUUID(),
      userId,
      planId: plan.id,
      exchange: plan.exchange,
      clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
      exchangeOrderId: null,
      state: 'SUBMITTED',
      requestedQuantity: plan.quantity ?? null,
      filledQuantity: 0,
      averageFillPrice: null,
      retryCount: 0,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.saveOrder(order);
    await this.event(order, null, 'SUBMITTED', 'ORDER_CREATED', {
      accountMode: plan.accountMode,
      signalState: plan.signalState,
      signalScore: plan.signalScore,
      signalConfidence: plan.signalConfidence,
    });
    return { order, duplicate: false };
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    const from = order.state;
    assertOrderTransition(from, toState);
    order.state = toState;
    order.updatedAt = new Date().toISOString();
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

  async invalidatePlan(userId: string, planId: string, reason = 'SIGNAL_INVALIDATED') {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    this.hydrateSignalLifecycle(plan);
    applySignalValidation(plan, {
      score: plan.signalScore,
      confidence: plan.signalConfidence,
      coreConditionsMaintained: false,
      riskReward: plan.signalRiskReward,
      reasons: plan.signalReasons,
      warnings: plan.signalWarnings,
      dataTimestamp: new Date().toISOString(),
      invalidationReason: reason,
    });
    const order = await this.repository.findOrderByPlan(userId, planId);
    if (!order) {
      if (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED') plan.state = 'EXPIRED';
      await this.repository.savePlan(plan);
      return { plan, order: null, filledQuantityPreserved: 0 };
    }
    await this.repository.savePlan(plan);
    if (['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'].includes(order.state)) {
      await this.transition(order, 'CANCEL_REQUESTED', 'SIGNAL_INVALIDATED_CANCEL_UNFILLED_REMAINDER', {
        filledQuantity: order.filledQuantity,
        invalidateAction: plan.invalidateAction ?? 'hold',
        signalReason: reason,
      });
    }
    return { plan, order, filledQuantityPreserved: order.filledQuantity };
  }

  private async event(
    order: TradingOrder,
    fromState: TradingOrderState | null,
    toState: TradingOrderState,
    reason: string,
    metadata: Record<string, unknown>,
  ) {
    const event: TradingOrderEvent = {
      id: randomUUID(),
      userId: order.userId,
      orderId: order.id,
      fromState,
      toState,
      reason,
      metadata,
      createdAt: new Date().toISOString(),
    };
    await this.repository.appendEvent(event);
  }
}
