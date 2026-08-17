import { createHash, randomUUID } from 'node:crypto';
import { assertOrderTransition } from './trade-order-state-machine.service';
import { evaluateTradingPlan } from './trade-automation-risk.service';
import type { TradingRepository } from './trade-automation.repository';
import { tripKillSwitchForRiskFailure } from './trade-kill-switch.service';
import {
  assertCancellationAllowed,
  buildRiskEnvelope,
  riskEnvelopeForPlan,
  withRiskEnvelope,
} from './trade-risk-envelope.service';
import {
  fetchTradingPlanMarketIntelligence,
  marketIntelligenceTradeDecision,
} from './trade-market-intelligence.service';
import type {
  TradingMarketSnapshot,
  TradingOrder, TradingOrderEvent, TradingOrderState, TradingPlan, TradingPlanInput, TradingPolicy,
  TradingRiskDecision,
} from './trade-automation.types';

const APPROVAL_TTL_MS = 10 * 60_000;

function orderVersion(order: TradingOrder) {
  return Number.isInteger(order.version) && Number(order.version) >= 0 ? Number(order.version) : 0;
}

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
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

function marketIntelligenceBlockedDecision(blockCode: string, warnings: string[]): TradingRiskDecision {
  return {
    allowed: false,
    blockCodes: [blockCode],
    warnings: [...new Set(warnings)],
  };
}

function withMarketIntelligenceWarnings(decision: TradingRiskDecision, warnings: string[]): TradingRiskDecision {
  return {
    ...decision,
    warnings: [...new Set([...decision.warnings, ...warnings])],
  };
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

  private async marketIntelligenceDecision(input: TradingPlanInput) {
    const intelligence = await fetchTradingPlanMarketIntelligence(input);
    return marketIntelligenceTradeDecision(intelligence, input.accountMode);
  }

  async createPlan(userId: string, input: TradingPlanInput, policy: TradingPolicy, emergencyStopped: boolean) {
    const idempotencyKey = tradingIdempotencyKey(userId, input);
    const duplicate = await this.repository.findPlanByIdempotency(userId, idempotencyKey);
    if (duplicate) return { plan: duplicate, duplicate: true, decision: { allowed: true, blockCodes: [], warnings: [] } };

    const intelligence = await this.marketIntelligenceDecision(input);
    if (!intelligence.allowed) {
      return {
        plan: null,
        duplicate: false,
        decision: marketIntelligenceBlockedDecision(
          intelligence.blockCode ?? 'MARKET_INTELLIGENCE_BLOCKED_RISK',
          intelligence.warnings,
        ),
      };
    }

    const riskDecision = evaluateTradingPlan(input, policy, {
      emergencyStopped: emergencyStopped || await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: input.accountMode !== 'live' || liveExecutionEnabled(input.exchange),
    });
    const decision = withMarketIntelligenceWarnings(riskDecision, intelligence.warnings);
    if (!decision.allowed) {
      await tripKillSwitchForRiskFailure({ repository: this.repository, userId, blockCodes: decision.blockCodes });
      return { plan: null, duplicate: false, decision };
    }

    const now = new Date();
    const plan: TradingPlan = {
      ...input,
      id: randomUUID(), userId, idempotencyKey,
      state: 'APPROVAL_PENDING',
      version: 0,
      approvalExpiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
      approvedAt: null, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    const inserted = await this.repository.insertPlan(plan);
    return { plan: inserted.plan, duplicate: !inserted.inserted, decision };
  }

  async approvePlan(userId: string, planId: string) {
    const plan = await this.repository.getPlan(userId, planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    if (plan.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
    const expectedVersion = planVersion(plan);
    if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) {
      const expired = { ...plan, state: 'EXPIRED' as const, updatedAt: new Date().toISOString() };
      await this.repository.compareAndSetPlan(expired, 'APPROVAL_PENDING', expectedVersion);
      throw new Error('TRADE_PLAN_EXPIRED');
    }

    const intelligence = await this.marketIntelligenceDecision(plan);
    if (!intelligence.allowed) {
      const expired = { ...plan, state: 'EXPIRED' as const, updatedAt: new Date().toISOString() };
      await this.repository.compareAndSetPlan(expired, 'APPROVAL_PENDING', expectedVersion);
      throw new Error(`TRADE_PLAN_MARKET_INTELLIGENCE_FAILED:${intelligence.blockCode ?? 'MARKET_INTELLIGENCE_BLOCKED_RISK'}`);
    }

    const policy = await this.repository.getPolicy(userId);
    const decision = evaluateTradingPlan(plan, policy, {
      emergencyStopped: await this.emergencyStopActive(userId, policy),
      serverLiveEnabled: plan.accountMode !== 'live' || liveExecutionEnabled(plan.exchange),
    });
    if (!decision.allowed) {
      await tripKillSwitchForRiskFailure({ repository: this.repository, userId, blockCodes: decision.blockCodes });
      const expired = { ...plan, state: 'EXPIRED' as const, updatedAt: new Date().toISOString() };
      await this.repository.compareAndSetPlan(expired, 'APPROVAL_PENDING', expectedVersion);
      throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
    }
    const approvedAt = new Date().toISOString();
    let envelope;
    try {
      envelope = buildRiskEnvelope(plan, policy, approvedAt);
    } catch (error) {
      const expired = { ...plan, state: 'EXPIRED' as const, updatedAt: approvedAt };
      await this.repository.compareAndSetPlan(expired, 'APPROVAL_PENDING', expectedVersion);
      throw error;
    }
    const approvedCandidate = withRiskEnvelope({
      ...plan, state: 'SUBMITTED', approvedAt, updatedAt: approvedAt,
    }, envelope);
    const approved = await this.repository.compareAndSetPlan(
      approvedCandidate,
      'APPROVAL_PENDING',
      expectedVersion,
    );
    if (!approved) throw new Error('TRADE_PLAN_CONCURRENTLY_CHANGED');
    return approved;
  }

  async beginAutomaticPlan(_userId: string, _planId: string) {
    throw new Error('USER_APPROVAL_REQUIRED');
  }

  async createOrder(userId: string, plan: TradingPlan) {
    const existing = await this.repository.findOrderByPlan(userId, plan.id);
    if (existing) return { order: existing, duplicate: true };
    if (plan.state !== 'SUBMITTED') throw new Error('TRADE_PLAN_NOT_SUBMITTED');
    if (!plan.approvedAt || !riskEnvelopeForPlan(plan)) throw new Error('TRADE_PLAN_APPROVAL_ENVELOPE_REQUIRED');
    const now = new Date().toISOString();
    const order: TradingOrder = {
      id: randomUUID(), userId, planId: plan.id, exchange: plan.exchange,
      clientOrderId: `sj-${plan.exchange}-${plan.idempotencyKey.slice(0, 20)}`,
      exchangeOrderId: null, state: 'SUBMITTED', version: 0,
      requestedQuantity: plan.quantity ?? null,
      filledQuantity: 0, averageFillPrice: null, retryCount: 0, lastErrorCode: null,
      approvedPlanVersion: planVersion(plan),
      preSubmissionCheckedAt: null,
      preSubmissionDecision: null,
      preSubmissionSnapshot: null,
      createdAt: now, updatedAt: now,
    };
    const created = await this.repository.createOrderAtomic(
      order,
      this.orderEvent(order, null, 'SUBMITTED', 'ORDER_CREATED', {
        accountMode: plan.accountMode,
        approvedPlanVersion: order.approvedPlanVersion,
        riskEnvelopeVersion: riskEnvelopeForPlan(plan)?.version ?? null,
      }),
      'SUBMITTED',
    );
    if (!created) throw new Error('TRADE_ORDER_ATOMIC_CREATE_FAILED');
    return { order: created.order, duplicate: !created.inserted };
  }

  async transition(order: TradingOrder, toState: TradingOrderState, reason: string, metadata: Record<string, unknown> = {}) {
    const from = order.state;
    assertOrderTransition(from, toState);
    const next: TradingOrder = { ...order, state: toState, updatedAt: new Date().toISOString() };
    if (typeof metadata.exchangeOrderId === 'string') next.exchangeOrderId = metadata.exchangeOrderId;
    if (typeof metadata.filledQuantity === 'number') next.filledQuantity = metadata.filledQuantity;
    if (typeof metadata.averageFillPrice === 'number') next.averageFillPrice = metadata.averageFillPrice;
    if (typeof metadata.errorCode === 'string') next.lastErrorCode = metadata.errorCode;
    if (typeof metadata.preSubmissionCheckedAt === 'string') next.preSubmissionCheckedAt = metadata.preSubmissionCheckedAt;
    if (metadata.preSubmissionDecision && typeof metadata.preSubmissionDecision === 'object') {
      next.preSubmissionDecision = metadata.preSubmissionDecision as TradingRiskDecision;
    }
    if (metadata.preSubmissionSnapshot && typeof metadata.preSubmissionSnapshot === 'object') {
      next.preSubmissionSnapshot = metadata.preSubmissionSnapshot as TradingMarketSnapshot;
    }

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
    const escalationCodes: string[] = [];
    if (typeof metadata.errorCode === 'string') escalationCodes.push(metadata.errorCode);
    if (order.state === 'RECOVERY_REQUIRED') {
      escalationCodes.push('ORDER_STATE_UNKNOWN', 'EXECUTION_RECONCILIATION_FAILED');
    }
    await tripKillSwitchForRiskFailure({
      repository: this.repository,
      userId: order.userId,
      blockCodes: escalationCodes,
    });
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
      } else {
        await tripKillSwitchForRiskFailure({
          repository: this.repository,
          userId,
          blockCodes: ['ORDER_STATE_UNKNOWN', 'EXECUTION_RECONCILIATION_FAILED'],
        });
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
        const expired = { ...plan, state: 'EXPIRED' as const, updatedAt: new Date().toISOString() };
        await this.repository.compareAndSetPlan(expired, plan.state, planVersion(plan));
      }
      return { plan, order: null, filledQuantityPreserved: 0 };
    }
    if (order.state === 'ACCEPTED' || order.state === 'PARTIALLY_FILLED') {
      assertCancellationAllowed(plan);
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
}
