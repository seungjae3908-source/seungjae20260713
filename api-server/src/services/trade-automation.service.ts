import { AsyncLocalStorage } from 'node:async_hooks';
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
  TradingPlanRevalidationInput,
  TradingPolicy,
  TradingSignalValidationInput,
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
  const global = process.env.ORDER_EXECUTION_ENABLED === 'true'
    && process.env.LIVE_TRADING_ACTIVATION_APPROVED === 'true';
  const perExchange = {
    bitget: process.env.BITGET_LIVE_ORDER_ENABLED === 'true',
    upbit: process.env.UPBIT_LIVE_ORDER_ENABLED === 'true',
    kiwoom: process.env.KIWOOM_LIVE_ORDER_ENABLED === 'true',
  };
  return global && perExchange[exchange];
}

function copyPlan(plan: TradingPlan) {
  return structuredClone(plan);
}

function hydrateSignalLifecycle(plan: TradingPlan) {
  if (!plan.signalState || !plan.lastSignalValidatedAt || !Array.isArray(plan.signalStateHistory)) {
    const fallbackDate = new Date(plan.updatedAt || plan.createdAt || Date.now());
    Object.assign(plan, initializeSignalLifecycle(plan, plan.approvalExpiresAt, fallbackDate));
  }
  return plan;
}

function applyPlanRevalidation(plan: TradingPlan, revalidation: TradingPlanRevalidationInput) {
  if (revalidation.marketSnapshot) plan.marketSnapshot = revalidation.marketSnapshot;
  if (revalidation.signalExpiresAt !== undefined) plan.signalExpiresAt = revalidation.signalExpiresAt ?? plan.signalExpiresAt;
  if (revalidation.entryPrice !== undefined) plan.entryPrice = revalidation.entryPrice;
  if (revalidation.entryZoneLow !== undefined) plan.entryZoneLow = revalidation.entryZoneLow;
  if (revalidation.entryZoneHigh !== undefined) plan.entryZoneHigh = revalidation.entryZoneHigh;
  if (revalidation.estimatedSlippagePercent !== undefined) plan.estimatedSlippagePercent = revalidation.estimatedSlippagePercent;
  if (revalidation.averageSpreadPercent !== undefined) plan.averageSpreadPercent = revalidation.averageSpreadPercent;
  if (revalidation.economics !== undefined) plan.economics = revalidation.economics;
  if (revalidation.signalValidation) {
    const validation: TradingSignalValidationInput = {
      ...revalidation.signalValidation,
      marketSnapshot: revalidation.signalValidation.marketSnapshot ?? revalidation.marketSnapshot,
    };
    applySignalValidation(plan, validation);
  }
  plan.updatedAt = new Date().toISOString();
}

function buildOrder(plan: TradingPlan): TradingOrder {
  const now = new Date().toISOString();
  return {
    id: randomUUID(), userId: plan.userId, planId: plan.id, exchange: plan.exchange,
    clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
    exchangeOrderId: null, state: 'SUBMITTED', requestedQuantity: plan.quantity ?? null,
    filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
    createdAt: now, updatedAt: now,
  };
}

function buildOrderCreatedEvent(plan: TradingPlan, order: TradingOrder): TradingOrderEvent {
  return {
    id: randomUUID(), userId: order.userId, orderId: order.id, fromState: null,
    toState: 'SUBMITTED', reason: 'ORDER_CREATED',
    metadata: {
      accountMode: plan.accountMode,
      signalState: plan.signalState,
      signalScore: plan.signalScore,
      signalConfidence: plan.signalConfidence,
      expectedValueR: plan.riskAssessment?.expectedValueR ?? null,
      riskBudgetKrw: plan.riskAssessment?.riskBudgetKrw ?? null,
      maximumOrderKrw: plan.riskAssessment?.maximumOrderKrw ?? null,
      pilotStage: plan.riskAssessment?.pilotStage ?? null,
    },
    createdAt: new Date().toISOString(),
  };
}

type AtomicSubmissionResult = {
  plan: TradingPlan;
  order: TradingOrder;
  duplicate: boolean;
  executionClaimed: boolean;
};

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

  private async expirePendingPlan(plan: TradingPlan, reason: string) {
    plan.state = 'EXPIRED';
    plan.signalState = reason.includes('SIGNAL') ? 'EXPIRED' : plan.signalState;
    plan.signalInvalidationReason = reason;
    plan.updatedAt = new Date().toISOString();
    const expired = await this.repository.compareAndSetPlan(plan, 'APPROVAL_PENDING');
    if (!expired) throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
  }

  private async atomicSubmit(plan: TradingPlan, expectedState: TradingOrderState): Promise<AtomicSubmissionResult> {
    const order = buildOrder(plan);
    const event = buildOrderCreatedEvent(plan, order);
    const result = await this.repository.submitPlanAndCreateOrder(
      plan, expectedState, order, event, randomUUID(),
    );
    if (!result) {
      throw new Error(expectedState === 'APPROVAL_PENDING'
        ? 'TRADE_PLAN_NOT_APPROVAL_PENDING'
        : 'TRADE_PLAN_NOT_READY');
    }
    return {
      plan: hydrateSignalLifecycle(result.plan),
      order: result.order,
      duplicate: !result.transitioned || !result.orderInserted,
      executionClaimed: result.executionClaimed,
    };
  }

  async executionBlockedByEmergencyStop(userId: string) {
    const policy = await this.repository.getPolicy(userId);
    return this.emergencyStopActive(userId, policy);
  }

  async createPlan(userId: string, input: TradingPlanInput, policy: TradingPolicy, emergencyStopped: boolean) {
    const idempotencyKey = tradingIdempotencyKey(userId, input);
    return withOperationLock(`create-plan:${userId}:${idempotencyKey}`, async () => {
      const duplicate = await this.repository.findPlanByIdempotency(userId, idempotencyKey);
      if (duplicate) {
        hydrateSignalLifecycle(duplicate);
        return {
          plan: duplicate, duplicate: true,
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
        ...input, ...lifecycle,
        id: randomUUID(), userId, idempotencyKey,
        state: signalTerminal ? 'EXPIRED' : approvalRequired ? 'APPROVAL_PENDING' : 'PLANNED',
        approvalExpiresAt, approvedAt: null,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
        riskAssessment: decision.optimization ?? null,
      };
      const persisted = await this.repository.insertPlan(plan);
      hydrateSignalLifecycle(persisted.plan);
      return {
        plan: persisted.plan,
        duplicate: !persisted.inserted,
        decision: persisted.inserted ? decision : { allowed: true, blockCodes: [], warnings: [] },
        approval: approvalStatus(persisted.plan),
      };
    });
  }

  async getPlanStatus(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    hydrateSignalLifecycle(plan);
    return { plan, approval: approvalStatus(plan) };
  }

  async revalidatePlan(userId: string, planId: string, validation: TradingSignalValidationInput) {
    return withTradePlanLock(userId, planId, async () => {
      const plan = await this.repository.getPlan(userId, planId);
      if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
      hydrateSignalLifecycle(plan);
      if (validation.marketSnapshot) plan.marketSnapshot = validation.marketSnapshot;
      const previousSignalState = plan.signalState;
      const { evaluation } = applySignalValidation(plan, validation);
      const signalTerminal = evaluation.state === 'INVALIDATED' || evaluation.state === 'EXPIRED';
      if (signalTerminal && (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED')) {
        plan.state = 'EXPIRED';
      }
      await this.repository.savePlan(plan);
      const order = await this.repository.findOrderByPlan(userId, plan.id);
      return {
        plan, order, approval: approvalStatus(plan),
        transition: { fromState: previousSignalState, toState: plan.signalState, reason: evaluation.reasonCode },
        shouldCancelUnfilled: signalTerminal
          && Boolean(order && ['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'].includes(order.state)),
      };
    });
  }

  async approvePlan(userId: string, planId: string, revalidation?: TradingPlanRevalidationInput | null) {
    return withTradePlanLock(userId, planId, async () => {
      const stored = await this.repository.getPlan(userId, planId);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      if (stored.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
      const plan = hydrateSignalLifecycle(copyPlan(stored));
      if (revalidation) applyPlanRevalidation(plan, revalidation);
      const currentApproval = approvalStatus(plan);
      if (!currentApproval.approvalEnabled) {
        if (currentApproval.reasonCode === 'APPROVAL_EXPIRED' || currentApproval.reasonCode === 'SIGNAL_EXPIRED') {
          await this.expirePendingPlan(plan, currentApproval.reasonCode);
        }
        throw new Error(`TRADE_PLAN_SIGNAL_NOT_APPROVABLE:${currentApproval.reasonCode ?? 'UNKNOWN'}`);
      }
      const decision = await this.recheck(userId, plan);
      if (!decision.allowed) {
        applySignalValidation(plan, {
          score: plan.signalScore, confidence: plan.signalConfidence,
          coreConditionsMaintained: false, riskReward: plan.signalRiskReward,
          reasons: plan.signalReasons, warnings: [...plan.signalWarnings, ...decision.warnings],
          dataTimestamp: new Date().toISOString(),
          invalidationReason: `RISK_RECHECK_FAILED_${decision.blockCodes.join('_')}`,
        });
        await this.expirePendingPlan(plan, `TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
        throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
      }
      plan.state = 'SUBMITTED';
      plan.approvedAt = new Date().toISOString();
      plan.updatedAt = plan.approvedAt;
      const submitted = await this.repository.compareAndSetPlan(plan, 'APPROVAL_PENDING');
      if (!submitted) throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
      return hydrateSignalLifecycle(submitted);
    });
  }

  async approvePlanAndCreateOrder(
    userId: string,
    planId: string,
    revalidation?: TradingPlanRevalidationInput | null,
  ): Promise<AtomicSubmissionResult> {
    return withTradePlanLock(userId, planId, async () => {
      const stored = await this.repository.getPlan(userId, planId);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      if (stored.state === 'SUBMITTED') return this.atomicSubmit(hydrateSignalLifecycle(copyPlan(stored)), 'APPROVAL_PENDING');
      if (stored.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');

      const plan = hydrateSignalLifecycle(copyPlan(stored));
      if (revalidation) applyPlanRevalidation(plan, revalidation);
      const currentApproval = approvalStatus(plan);
      if (!currentApproval.approvalEnabled) {
        if (currentApproval.reasonCode === 'APPROVAL_EXPIRED' || currentApproval.reasonCode === 'SIGNAL_EXPIRED') {
          await this.expirePendingPlan(plan, currentApproval.reasonCode);
        }
        throw new Error(`TRADE_PLAN_SIGNAL_NOT_APPROVABLE:${currentApproval.reasonCode ?? 'UNKNOWN'}`);
      }
      const decision = await this.recheck(userId, plan);
      if (!decision.allowed) {
        applySignalValidation(plan, {
          score: plan.signalScore, confidence: plan.signalConfidence,
          coreConditionsMaintained: false, riskReward: plan.signalRiskReward,
          reasons: plan.signalReasons, warnings: [...plan.signalWarnings, ...decision.warnings],
          dataTimestamp: new Date().toISOString(),
          invalidationReason: `RISK_RECHECK_FAILED_${decision.blockCodes.join('_')}`,
        });
        await this.expirePendingPlan(plan, `TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
        throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
      }
      plan.state = 'SUBMITTED';
      plan.approvedAt = new Date().toISOString();
      plan.updatedAt = plan.approvedAt;
      return this.atomicSubmit(plan, 'APPROVAL_PENDING');
    });
  }

  async beginAutomaticPlan(userId: string, planId: string) {
    return withTradePlanLock(userId, planId, async () => {
      const stored = await this.repository.getPlan(userId, planId);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      if (stored.state !== 'PLANNED') throw new Error('TRADE_PLAN_NOT_READY');
      const plan = hydrateSignalLifecycle(copyPlan(stored));
      const lastValidation = Date.parse(plan.lastSignalValidatedAt);
      if (plan.signalState !== 'READY_FOR_APPROVAL'
        || !Number.isFinite(lastValidation)
        || Date.now() - lastValidation > SIGNAL_VALIDATION_MAX_AGE_MS) {
        throw new Error('TRADE_PLAN_SIGNAL_NOT_READY');
      }
      const decision = await this.recheck(userId, plan);
      if (!decision.allowed) throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
      plan.state = 'SUBMITTED';
      plan.updatedAt = new Date().toISOString();
      const submitted = await this.repository.compareAndSetPlan(plan, 'PLANNED');
      if (!submitted) throw new Error('TRADE_PLAN_NOT_READY');
      return hydrateSignalLifecycle(submitted);
    });
  }

  async beginAutomaticPlanAndCreateOrder(userId: string, planId: string): Promise<AtomicSubmissionResult> {
    return withTradePlanLock(userId, planId, async () => {
      const stored = await this.repository.getPlan(userId, planId);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      if (stored.state === 'SUBMITTED') return this.atomicSubmit(hydrateSignalLifecycle(copyPlan(stored)), 'PLANNED');
      if (stored.state !== 'PLANNED') throw new Error('TRADE_PLAN_NOT_READY');
      const plan = hydrateSignalLifecycle(copyPlan(stored));
      const lastValidation = Date.parse(plan.lastSignalValidatedAt);
      if (plan.signalState !== 'READY_FOR_APPROVAL'
        || !Number.isFinite(lastValidation)
        || Date.now() - lastValidation > SIGNAL_VALIDATION_MAX_AGE_MS) {
        throw new Error('TRADE_PLAN_SIGNAL_NOT_READY');
      }
      const decision = await this.recheck(userId, plan);
      if (!decision.allowed) throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
      plan.state = 'SUBMITTED';
      plan.updatedAt = new Date().toISOString();
      return this.atomicSubmit(plan, 'PLANNED');
    });
  }

  async createOrder(userId: string, inputPlan: TradingPlan) {
    return withTradePlanLock(userId, inputPlan.id, async () => {
      const existing = await this.repository.findOrderByPlan(userId, inputPlan.id);
      if (existing) return { order: existing, duplicate: true };
      const stored = await this.repository.getPlan(userId, inputPlan.id);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      const plan = hydrateSignalLifecycle(copyPlan(stored));
      if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
      const decision = await this.recheck(userId, plan);
      if (!decision.allowed) throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
      const order = buildOrder(plan);
      const inserted = await this.repository.insertOrder(order);
      if (inserted.inserted) await this.repository.appendEvent(buildOrderCreatedEvent(plan, inserted.order));
      return { order: inserted.order, duplicate: !inserted.inserted };
    });
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    return withTradePlanLock(order.userId, order.planId, async () => {
      const stored = await this.repository.getOrder(order.userId, order.id);
      if (!stored) throw new Error('TRADE_ORDER_NOT_FOUND');
      if (stored.state === toState) return stored;
      const from = stored.state;
      assertOrderTransition(from, toState);
      stored.state = toState;
      stored.updatedAt = new Date().toISOString();
      if (typeof metadata.exchangeOrderId === 'string') stored.exchangeOrderId = metadata.exchangeOrderId;
      if (typeof metadata.filledQuantity === 'number') stored.filledQuantity = metadata.filledQuantity;
      if (typeof metadata.averageFillPrice === 'number') stored.averageFillPrice = metadata.averageFillPrice;
      if (typeof metadata.errorCode === 'string') stored.lastErrorCode = metadata.errorCode;
      await this.repository.saveOrder(stored);
      await this.event(stored, from, toState, reason, metadata);
      return stored;
    });
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
    return withTradePlanLock(userId, planId, async () => {
      const stored = await this.repository.getPlan(userId, planId);
      if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
      const plan = hydrateSignalLifecycle(copyPlan(stored));
      applySignalValidation(plan, {
        score: plan.signalScore, confidence: plan.signalConfidence,
        coreConditionsMaintained: false, riskReward: plan.signalRiskReward,
        reasons: plan.signalReasons, warnings: plan.signalWarnings,
        dataTimestamp: new Date().toISOString(), invalidationReason: reason,
      });
      const order = await this.repository.findOrderByPlan(userId, planId);
      if (!order) {
        if (plan.state === 'APPROVAL_PENDING' || plan.state === 'PLANNED') plan.state = 'EXPIRED';
        await this.repository.savePlan(plan);
        return { plan, order: null, filledQuantityPreserved: 0 };
      }
      await this.repository.savePlan(plan);
      if (['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED'].includes(order.state)) {
        const canceled = await this.transition(order, 'CANCEL_REQUESTED', 'SIGNAL_INVALIDATED_CANCEL_UNFILLED_REMAINDER', {
          filledQuantity: order.filledQuantity,
          invalidateAction: plan.invalidateAction ?? 'hold',
          signalReason: reason,
        });
        return { plan, order: canceled, filledQuantityPreserved: canceled.filledQuantity };
      }
      return { plan, order, filledQuantityPreserved: order.filledQuantity };
    });
  }

  private async event(
    order: TradingOrder,
    fromState: TradingOrderState | null,
    toState: TradingOrderState,
    reason: string,
    metadata: Record<string, unknown>,
  ) {
    const event: TradingOrderEvent = {
      id: randomUUID(), userId: order.userId, orderId: order.id,
      fromState, toState, reason, metadata, createdAt: new Date().toISOString(),
    };
    await this.repository.appendEvent(event);
  }
}
