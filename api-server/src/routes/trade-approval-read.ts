import { Router, type IRouter, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../services/trade-automation.repository';
import type {
  TradingOrder,
  TradingPlan,
  TradingSignalState,
} from '../services/trade-automation.types';

const router: IRouter = Router();
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setTradeApprovalReadRepositoryFactoryForTests(
  factory: ((userId: string) => TradingRepository) | null,
) {
  repositoryFactoryForTests = factory;
}

function context(req: AuthenticatedRequest) {
  if (!req.member?.id) throw new Error('LOGIN_REQUIRED');
  const userId = req.member.id;
  const repository = repositoryFactoryForTests
    ? repositoryFactoryForTests(userId)
    : req.accessToken
      ? createSupabaseTradingRepository(req.accessToken, userId)
      : (() => { throw new Error('LOGIN_REQUIRED'); })();
  return { userId, repository };
}

type ApprovalSignalState = 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';

function signalState(value: TradingSignalState | null | undefined): ApprovalSignalState {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'ENTRY_READY' || normalized === 'READY_FOR_APPROVAL') return 'READY_FOR_APPROVAL';
  if (normalized === 'WEAKENED') return 'WEAKENED';
  if (normalized === 'INVALIDATED' || normalized === 'CONDITION_BROKEN') return 'INVALIDATED';
  if (normalized === 'EXPIRED') return 'EXPIRED';
  return 'WATCHING';
}

function expired(plan: TradingPlan, now = Date.now()) {
  return Boolean(plan.approvalExpiresAt && Number.isFinite(Date.parse(plan.approvalExpiresAt))
    && Date.parse(plan.approvalExpiresAt) <= now);
}

function approvalStatus(plan: TradingPlan, now = Date.now()) {
  const currentSignalState = signalState(plan.marketSnapshot?.signalState);
  const approvalExpired = expired(plan, now);
  const approvalEnabled = plan.state === 'APPROVAL_PENDING'
    && plan.accountMode !== 'live'
    && currentSignalState === 'READY_FOR_APPROVAL'
    && !approvalExpired
    && plan.riskAssessment?.allowed !== false;

  let reasonCode: string | null = null;
  if (plan.accountMode === 'live') reasonCode = 'LIVE_APPROVAL_LOCKED';
  else if (approvalExpired) reasonCode = 'APPROVAL_EXPIRED';
  else if (plan.state !== 'APPROVAL_PENDING') reasonCode = 'PLAN_NOT_APPROVAL_PENDING';
  else if (currentSignalState !== 'READY_FOR_APPROVAL') reasonCode = 'SIGNAL_REVALIDATION_REQUIRED';
  else if (plan.riskAssessment?.allowed === false) reasonCode = 'RISK_CHECK_BLOCKED';

  return {
    approvalEnabled,
    signalState: currentSignalState,
    planState: plan.state,
    reasonCode,
    expiresAt: plan.approvalExpiresAt,
    lastValidatedAt: plan.updatedAt,
  };
}

function queueOrder(order: TradingOrder | null) {
  if (!order) return null;
  return {
    state: order.state,
    filledQuantity: order.filledQuantity,
    updatedAt: order.updatedAt,
    lastErrorCode: order.lastErrorCode,
  };
}

function queueItem(plan: TradingPlan, order: TradingOrder | null, now = Date.now()) {
  const approval = approvalStatus(plan, now);
  const currentSignalState = approval.signalState;
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
    signalReasons: plan.signalReasons,
    signalWarnings: plan.riskAssessment?.warnings ?? [],
    signalScore: null,
    signalConfidence: null,
    signalRiskReward: null,
    signalState: currentSignalState,
    signalInvalidationReason: currentSignalState === 'INVALIDATED' || currentSignalState === 'EXPIRED'
      ? approval.reasonCode
      : null,
    state: plan.state,
    approvalExpiresAt: plan.approvalExpiresAt,
    updatedAt: plan.updatedAt,
    approval,
    order: queueOrder(order),
  };
}

function errorResponse(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : 'TRADE_APPROVAL_READ_FAILED';
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code.includes('NOT_FOUND') ? 404
      : code.includes('STORAGE') ? 503 : 400;
  return res.status(status).json({
    ok: false,
    error: code,
    orderSubmitted: false,
    orderCanceled: false,
    privateTradingRequestSent: false,
  });
}

router.get('/approval-queue', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const plans = await repository.listPlans(userId);
    const relevant = plans.filter((plan) => plan.state === 'APPROVAL_PENDING' || plan.state === 'EXPIRED');
    const items = await Promise.all(relevant.map(async (plan) => queueItem(
      plan,
      await repository.findOrderByPlan(userId, plan.id),
    )));
    return res.json({
      ok: true,
      items,
      count: items.length,
      updatedAt: new Date().toISOString(),
      orderSubmitted: false,
      orderCanceled: false,
      privateTradingRequestSent: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/plans/:id/approval-status', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    return res.json({
      ok: true,
      plan: {
        state: plan.state,
        signalState: signalState(plan.marketSnapshot?.signalState),
        signalInvalidationReason: null,
        approvalExpiresAt: plan.approvalExpiresAt,
        updatedAt: plan.updatedAt,
      },
      approval: approvalStatus(plan),
      orderSubmitted: false,
      orderCanceled: false,
      privateTradingRequestSent: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

export default router;
