import { AsyncLocalStorage } from 'node:async_hooks';
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
const operationLocks = new Map<string, Promise<void>>();
const operationLockContext = new AsyncLocalStorage<ReadonlySet<string>>();

async function withOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const heldLocks = operationLockContext.getStore();
  if (heldLocks?.has(key)) return operation();

  const previous = operationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => current);
  operationLocks.set(key, queued);
  await previous.catch(() => undefined);

  const nextLocks = new Set(heldLocks ?? []);
  nextLocks.add(key);
  try {
    return await operationLockContext.run(nextLocks, operation);
  } finally {
    release();
    if (operationLocks.get(key) === queued) operationLocks.delete(key);
  }
}

export function withTradePlanLock<T>(userId: string, planId: string, operation: () => Promise<T>) {
  return withOperationLock(`plan:${userId}:${planId}`, operation);
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

  async executionBlockedByEmergencyStop(userId: string) {
    const policy = await this.repository.getPolicy(userId);
    return this.emergencyStopActive(userId, policy);
  }

  async createPlan(userId: string, input: TradingPlanInput, policy: TradingPolicy, emergencyStopped: boolean) {
    const idempotencyKey = tradingIdempotencyKey(userId, input);
    return withOperationLock(`create-plan:${userId}:${idempotencyKey}`, async () => {
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
    });
  }

  async approvePlan(userId: string, planId: string, revalidation?: TradingPlanRevalidationInput | null) {
    return withTradePlanLock(userId, planId, async () => {
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
    });
  }

  async beginAutomaticPlan(userId: string, planId: string) {
    return withTradePlanLock(userId, planId, async () => {
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
    });
  }

  async createOrder(userId: string, plan: TradingPlan) {
    return withTradePlanLock(userId, plan.id, async () => {
      const existing = await this.repository.findOrderByPlan(userId, plan.id);
      if (existing) return { order: existing, duplicate: true };
      const currentPlan = await this.repository.getPlan(userId, plan.id) ?? plan;
      if (currentPlan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
      const decision = await this.recheck(userId, currentPlan);
      if (!decision.allowed) throw new Error(`TRADE_ORDER_FINAL_RISK_CHECK_FAILED:${decision.blockCodes.join(',')}`);
      const now = new Date().toISOString();
      const order: TradingOrder = {
        id: randomUUID(), userId, planId: currentPlan.id, exchange: currentPlan.exchange,
        clientOrderId: `sj-${currentPlan.exchange}-${currentPlan.idempotencyKey.slice(0, 20)}`,
        exchangeOrderId: null, state: 'SUBMITTED', requestedQuantity: currentPlan.quantity ?? null,
        filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
        createdAt: now, updatedAt: now,
      };
      await this.repository.saveOrder(order);
      await this.event(order, null, 'SUBMITTED', 'ORDER_CREATED', {
        accountMode: currentPlan.accountMode,
        expectedValueR: currentPlan.riskAssessment?.expectedValueR ?? null,
        riskBudgetKrw: currentPlan.riskAssessment?.riskBudgetKrw ?? null,
        maximumOrderKrw: currentPlan.riskAssessment?.maximumOrderKrw ?? null,
        pilotStage: currentPlan.riskAssessment?.pilotStage ?? null,
      });
      return { order, duplicate: false };
    });
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    return withTradePlanLock(order.userId, order.planId, async () => {
      const current = await this.repository.getOrder(order.userId, order.id) ?? order;
      const from = current.state;
      if (from === toState && from !== 'PARTIALLY_FILLED') {
        Object.assign(order, current);
        return order;
      }
      assertOrderTransition(from, toState);
      current.state = toState; current.updatedAt = new Date().toISOString();
      if (typeof metadata.exchangeOrderId === 'string') current.exchangeOrderId = metadata.exchangeOrderId;
      if (typeof metadata.filledQuantity === 'number') current.filledQuantity = metadata.filledQuantity;
      if (typeof metadata.averageFillPrice === 'number') current.averageFillPrice = metadata.averageFillPrice;
      if (typeof metadata.errorCode === 'string') current.lastErrorCode = metadata.errorCode;
      await this.repository.saveOrder(current);
      await this.event(current, from, toState, reason, metadata);
      Object.assign(order, current);
      return order;
    });
  }

  async recoverOpenOrders(userId: string) {
    const orders = await this.repository.listOrders(userId);
    const recovered: TradingOrder[] = [];
    for (const candidate of orders) {
      const order = await withTradePlanLock(userId, candidate.planId, async () => {
        const current = await this.repository.getOrder(userId, candidate.id);
        if (!current || !['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED'].includes(current.state)) return null;
        return this.transition(current, 'RECOVERY_REQUIRED', 'SERVER_RESTART_RECONCILIATION_REQUIRED');
      });
      if (order) recovered.push(order);
    }
    return recovered;
  }

  async invalidatePlan(userId: string, planId: string) {
    return withTradePlanLock(userId, planId, async () => {
      const plan = await this.repository.getPlan(userId, planId);
      if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
      const order = await this.repository.findOrderByPlan(userId, planId);
      if (!order) {
        if (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED' || plan.state === 'SUBMITTED') {
          plan.state = 'EXPIRED'; plan.updatedAt = new Date().toISOString();
          await this.repository.savePlan(plan);
        }
        return { plan, order: null, filledQuantityPreserved: 0 };
      }
      const currentOrder = await this.repository.getOrder(userId, order.id) ?? order;
      if (currentOrder.state === 'SUBMITTED' || currentOrder.state === 'ACCEPTED' || currentOrder.state === 'PARTIALLY_FILLED') {
        await this.transition(currentOrder, 'CANCEL_REQUESTED', 'SIGNAL_INVALIDATED_CANCEL_UNFILLED_REMAINDER', {
          filledQuantity: currentOrder.filledQuantity,
          invalidateAction: plan.invalidateAction ?? 'hold',
        });
      }
      return { plan, order: currentOrder, filledQuantityPreserved: currentOrder.filledQuantity };
    });
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
