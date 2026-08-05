import { timingSafeEqual } from 'node:crypto';
import { Router, type IRouter, type Response } from 'express';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import { TradeExecutionService } from '../services/trade-execution.service';
import { approvalStatus } from '../services/trade-signal-lifecycle.service';
import type { AuthenticatedRequest } from '../middleware/auth';
import type {
  TradingApprovalStatus,
  TradingMarketSnapshot,
  TradingPlan,
  TradingSignalState,
  TradingSignalValidationInput,
} from '../services/trade-automation.types';

const router: IRouter = Router();
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setTradeSignalApprovalRepositoryFactoryForTests(
  factory: ((userId: string) => TradingRepository) | null,
) {
  repositoryFactoryForTests = factory;
}

function context(req: AuthenticatedRequest) {
  if (!req.member?.id) throw new Error('LOGIN_REQUIRED');
  const repository = repositoryFactoryForTests
    ? repositoryFactoryForTests(req.member.id)
    : req.accessToken
      ? createSupabaseTradingRepository(req.accessToken, req.member.id)
      : (() => { throw new Error('LOGIN_REQUIRED'); })();
  return {
    userId: req.member.id,
    repository,
    automation: new TradeAutomationService(repository),
    execution: new TradeExecutionService(repository),
  };
}

function signalMonitorAuthorized(req: AuthenticatedRequest) {
  const expected = String(process.env.SIGNAL_MONITOR_TOKEN ?? '').trim();
  if (!expected) throw new Error('SIGNAL_MONITOR_NOT_CONFIGURED');
  const provided = String(req.header('x-signal-monitor-token') ?? '').trim();
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length
    || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw new Error('SIGNAL_MONITOR_UNAUTHORIZED');
  }
}

function finiteNumber(value: unknown, code: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function stringList(value: unknown, maximum = 30) {
  return Array.isArray(value)
    ? [...new Set(value.map(String).map((item) => item.trim()).filter(Boolean))].slice(0, maximum)
    : [];
}

function marketSnapshotValue(value: unknown): TradingMarketSnapshot | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MARKET_SNAPSHOT_INVALID');
  const input = value as Record<string, unknown>;
  const observedAt = String(input.observedAt ?? '');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('MARKET_SNAPSHOT_TIMESTAMP_INVALID');
  const existingPositionSide = input.existingPositionSide == null
    ? null
    : String(input.existingPositionSide);
  if (existingPositionSide != null && !['buy', 'sell', 'long', 'short'].includes(existingPositionSide)) {
    throw new Error('MARKET_SNAPSHOT_POSITION_SIDE_INVALID');
  }
  return {
    observedAt: new Date(observedAt).toISOString(),
    dataDelayMs: finiteNumber(input.dataDelayMs, 'MARKET_SNAPSHOT_DATA_DELAY_INVALID'),
    oneMinuteMovePercent: finiteNumber(input.oneMinuteMovePercent, 'MARKET_SNAPSHOT_MOVE_INVALID'),
    spreadPercent: finiteNumber(input.spreadPercent, 'MARKET_SNAPSHOT_SPREAD_INVALID'),
    orderbookGapPercent: finiteNumber(input.orderbookGapPercent, 'MARKET_SNAPSHOT_ORDERBOOK_GAP_INVALID'),
    halted: input.halted === true,
    availableBalance: finiteNumber(input.availableBalance, 'MARKET_SNAPSHOT_BALANCE_INVALID'),
    accountValueKrw: finiteNumber(input.accountValueKrw, 'MARKET_SNAPSHOT_ACCOUNT_VALUE_INVALID'),
    dailyPnlPercent: finiteNumber(input.dailyPnlPercent, 'MARKET_SNAPSHOT_DAILY_PNL_INVALID'),
    assetExposurePercent: finiteNumber(input.assetExposurePercent, 'MARKET_SNAPSHOT_EXPOSURE_INVALID'),
    openPositionCount: finiteNumber(input.openPositionCount, 'MARKET_SNAPSHOT_POSITION_COUNT_INVALID'),
    dailyOrderCount: finiteNumber(input.dailyOrderCount, 'MARKET_SNAPSHOT_DAILY_ORDER_COUNT_INVALID'),
    consecutiveLosses: finiteNumber(input.consecutiveLosses, 'MARKET_SNAPSHOT_CONSECUTIVE_LOSSES_INVALID'),
    existingPositionSide: existingPositionSide as TradingMarketSnapshot['existingPositionSide'],
    liquidationDistancePercent: input.liquidationDistancePercent == null
      ? null
      : finiteNumber(input.liquidationDistancePercent, 'MARKET_SNAPSHOT_LIQUIDATION_DISTANCE_INVALID'),
  };
}

function validationValue(value: unknown): TradingSignalValidationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SIGNAL_VALIDATION_REQUIRED');
  const input = value as Record<string, unknown>;
  if (typeof input.coreConditionsMaintained !== 'boolean') throw new Error('SIGNAL_CORE_CONDITION_STATE_REQUIRED');
  const dataTimestamp = String(input.dataTimestamp ?? '');
  if (!Number.isFinite(Date.parse(dataTimestamp))) throw new Error('SIGNAL_DATA_TIMESTAMP_INVALID');
  return {
    score: finiteNumber(input.score, 'SIGNAL_SCORE_INVALID'),
    confidence: finiteNumber(input.confidence, 'SIGNAL_CONFIDENCE_INVALID'),
    coreConditionsMaintained: input.coreConditionsMaintained,
    riskReward: input.riskReward == null ? null : finiteNumber(input.riskReward, 'SIGNAL_RISK_REWARD_INVALID'),
    reasons: stringList(input.reasons),
    warnings: stringList(input.warnings),
    dataTimestamp: new Date(dataTimestamp).toISOString(),
    invalidationReason: input.invalidationReason == null
      ? null
      : String(input.invalidationReason).trim().slice(0, 120),
    marketSnapshot: marketSnapshotValue(input.marketSnapshot),
  };
}

function unavailableApproval(plan: TradingPlan): TradingApprovalStatus {
  return {
    approvalEnabled: false,
    signalState: (plan.signalState ?? 'WATCHING') as TradingSignalState,
    planState: plan.state,
    reasonCode: 'SIGNAL_REVALIDATION_REQUIRED',
    expiresAt: plan.approvalExpiresAt,
    lastValidatedAt: plan.lastSignalValidatedAt ?? plan.updatedAt,
  };
}

function safeApprovalItem(
  plan: TradingPlan,
  order: { state: string; filledQuantity: number; updatedAt: string; lastErrorCode: string | null } | null,
) {
  const approval = plan.signalState && plan.lastSignalValidatedAt
    ? approvalStatus(plan)
    : unavailableApproval(plan);
  return {
    id: plan.id,
    exchange: plan.exchange,
    accountMode: plan.accountMode,
    strategyId: plan.strategyId,
    signalId: plan.signalId,
    symbol: plan.symbol,
    market: plan.market,
    side: plan.side,
    orderType: plan.orderType,
    estimatedKrw: plan.estimatedKrw,
    quantity: plan.quantity ?? null,
    limitPrice: plan.limitPrice ?? null,
    stopPrice: plan.stopPrice,
    targetPrices: plan.targetPrices,
    splitRatios: plan.splitRatios,
    leverage: plan.leverage ?? null,
    signalReasons: stringList(plan.signalReasons),
    signalWarnings: stringList(plan.signalWarnings),
    signalScore: plan.signalScore == null || !Number.isFinite(Number(plan.signalScore))
      ? null
      : Number(plan.signalScore),
    signalConfidence: plan.signalConfidence == null || !Number.isFinite(Number(plan.signalConfidence))
      ? null
      : Number(plan.signalConfidence),
    signalRiskReward: plan.signalRiskReward == null || !Number.isFinite(Number(plan.signalRiskReward))
      ? null
      : Number(plan.signalRiskReward),
    signalState: plan.signalState ?? 'WATCHING',
    signalInvalidationReason: plan.signalInvalidationReason ?? null,
    state: plan.state,
    approvalExpiresAt: plan.approvalExpiresAt,
    updatedAt: plan.updatedAt,
    approval,
    order,
  };
}

function errorResponse(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : 'TRADE_SIGNAL_APPROVAL_FAILED';
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code === 'SIGNAL_MONITOR_UNAUTHORIZED' ? 403
      : code === 'SIGNAL_MONITOR_NOT_CONFIGURED' ? 503
        : code.includes('NOT_FOUND') ? 404
          : code.includes('STORAGE') ? 503
            : code.includes('NOT_APPROVABLE') || code.includes('EXPIRED') ? 409
              : 400;
  return res.status(status).json({
    ok: false,
    error: code,
    orderSubmitted: false,
    approvalEnabled: false,
  });
}

router.get('/approval-queue', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const [plans, orders] = await Promise.all([
      repository.listPlans(userId),
      repository.listOrders(userId),
    ]);
    const orderByPlan = new Map(
      orders.map((order) => [order.planId, {
        state: order.state,
        filledQuantity: order.filledQuantity,
        updatedAt: order.updatedAt,
        lastErrorCode: order.lastErrorCode,
      }]),
    );
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const items = plans
      .filter((plan) => ['APPROVAL_PENDING', 'PLANNED', 'SUBMITTED'].includes(plan.state)
        || Date.parse(plan.updatedAt) >= cutoff)
      .slice(0, 50)
      .map((plan) => safeApprovalItem(plan, orderByPlan.get(plan.id) ?? null));
    return res.json({
      ok: true,
      items,
      count: items.length,
      updatedAt: new Date().toISOString(),
      credentialsExposed: false,
      accountBalancesExposed: false,
      orderSubmitted: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/plans/:id/approval-status', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, automation } = context(req);
    const result = await automation.getPlanStatus(userId, String(req.params.id));
    return res.json({ ok: true, ...result, orderSubmitted: false });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/plans/:id/revalidate', async (req: AuthenticatedRequest, res) => {
  try {
    signalMonitorAuthorized(req);
    const { userId, automation, execution } = context(req);
    const result = await automation.revalidatePlan(
      userId,
      String(req.params.id),
      validationValue(req.body),
    );
    let order = result.order;
    let filledQuantityPreserved = order?.filledQuantity ?? 0;
    if (result.shouldCancelUnfilled && order) {
      const invalidated = await automation.invalidatePlan(
        userId,
        result.plan.id,
        result.transition.reason,
      );
      order = invalidated.order;
      filledQuantityPreserved = invalidated.filledQuantityPreserved;
      if (order?.state === 'CANCEL_REQUESTED') {
        order = await execution.cancel(userId, invalidated.plan, order);
      }
    }
    return res.json({
      ok: true,
      plan: result.plan,
      approval: result.approval,
      transition: result.transition,
      order,
      filledQuantityPreserved,
      approvalButtonDisabled: !result.approval.approvalEnabled,
      followUpEntriesCancelled: result.shouldCancelUnfilled,
      immediateMarketLiquidation: false,
      orderSubmitted: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

export default router;
