import { Router, type IRouter, type Response } from 'express';
import { createSupabaseTradingRepository, safeConnections, type TradingRepository } from '../services/trade-automation.repository';
import { liveExecutionEnabled, TradeAutomationService } from '../services/trade-automation.service';
import { TradeCancelReconciliationService } from '../services/trade-cancel-reconciliation.service';
import { TradeExecutionService } from '../services/trade-execution.service';
import {
  buildSplitLegRevalidationEvidence,
  TradeSplitOrderExecutionService,
} from '../services/trade-split-order-execution.service';
import type { SplitTradingOrder } from '../services/trade-split-order-materializer.service';
import type { SplitOrderRepository } from '../services/trade-split-order.repository';
import { createSupabaseSplitOrderRepository } from '../services/trade-split-order-supabase.repository';
import { credentialConfigurationStatus, encryptTradingCredentials } from '../services/trade-credential-vault.service';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import type {
  TradingExchange,
  TradingOrder,
  TradingPlan,
  TradingPlanInput,
  TradingSignalState,
} from '../services/trade-automation.types';

const router: IRouter = Router();
const EXCHANGES = new Set<TradingExchange>(['bitget', 'upbit', 'kiwoom']);
const CANCEL_RECONCILIATION_STATES = new Set([
  'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED',
]);
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;
let splitRepositoryFactoryForTests: ((userId: string) => SplitOrderRepository) | null = null;

export function setTradeAutomationRepositoryFactoryForTests(
  factory: ((userId: string) => TradingRepository) | null,
) {
  repositoryFactoryForTests = factory;
}

export function setTradeSplitOrderRepositoryFactoryForTests(
  factory: ((userId: string) => SplitOrderRepository) | null,
) {
  splitRepositoryFactoryForTests = factory;
}

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
}

function context(req: AuthenticatedRequest) {
  if (!req.member?.id) throw new Error('LOGIN_REQUIRED');
  const userId = req.member.id;
  const repository = repositoryFactoryForTests
    ? repositoryFactoryForTests(userId)
    : req.accessToken
      ? createSupabaseTradingRepository(req.accessToken, userId)
      : (() => { throw new Error('LOGIN_REQUIRED'); })();
  const splitRepository = splitRepositoryFactoryForTests
    ? splitRepositoryFactoryForTests(userId)
    : req.accessToken
      ? createSupabaseSplitOrderRepository(req.accessToken, userId)
      : null;
  const automation = new TradeAutomationService(repository);
  const splitExecution = splitRepository ? new TradeSplitOrderExecutionService(splitRepository, {
    async invalidateSignal(input) {
      const current = await repository.getPlan(input.userId, input.planId);
      if (!current) throw new Error('TRADE_PLAN_NOT_FOUND');
      if (planVersion(current) !== input.approvedPlanVersion) throw new Error('APPROVAL_VERSION_CHANGED');
      if (current.state !== 'SUBMITTED') return;
      const halted = { ...current, state: 'EXPIRED' as const, updatedAt: new Date().toISOString() };
      const applied = await repository.compareAndSetPlan(
        halted,
        'SUBMITTED',
        input.approvedPlanVersion,
      );
      if (!applied) throw new Error('TRADE_PLAN_CONCURRENTLY_CHANGED');
    },
    async handleRisk(input) {
      if (input.reason !== 'FAST_MOVE_DETECTED') throw new Error('TRADE_SPLIT_RISK_REASON_UNSUPPORTED');
      await repository.setGlobalEmergencyStop(true, input.userId);
    },
  }) : null;
  return {
    userId,
    repository,
    automation,
    execution: new TradeExecutionService(repository),
    splitExecution,
    cancellation: new TradeCancelReconciliationService(repository),
  };
}

function exchangeValue(value: unknown): TradingExchange {
  const exchange = String(value ?? '').toLowerCase() as TradingExchange;
  if (!EXCHANGES.has(exchange)) throw new Error('UNSUPPORTED_EXCHANGE');
  return exchange;
}

function isSplitPlan(plan: TradingPlan) {
  return Array.isArray(plan.splitRatios) && plan.splitRatios.length > 1;
}

function childPlan(plan: TradingPlan, child: SplitTradingOrder): TradingPlan {
  return {
    ...plan,
    quantity: child.requestedQuantity,
    quoteAmount: child.requestedQuoteAmount,
    estimatedKrw: child.requestedQuoteAmount ?? plan.estimatedKrw,
  };
}

async function executeSubmittedPlan(
  userId: string,
  plan: TradingPlan,
  automation: TradeAutomationService,
  execution: TradeExecutionService,
  splitExecution: TradeSplitOrderExecutionService | null,
) {
  if (!isSplitPlan(plan)) {
    const { order, duplicate } = await automation.createOrder(userId, plan);
    return {
      order: duplicate ? order : await execution.execute(userId, plan, order),
      duplicate,
      splitOrders: null,
      aggregateState: null,
      nextChild: null,
    };
  }
  if (!splitExecution) throw new Error('TRADE_SPLIT_ORDER_STORAGE_UNAVAILABLE');
  const prepared = await splitExecution.ensureChildren(plan);
  if (!prepared.executable) throw new Error('TRADE_SPLIT_CHILD_NOT_EXECUTABLE');
  const executionPlan = childPlan(plan, prepared.executable);
  const executed = await execution.execute(userId, executionPlan, prepared.executable);
  let snapshot = prepared;
  if (executed.state === 'FILLED') {
    const evidence = buildSplitLegRevalidationEvidence(executionPlan, executed);
    snapshot = await splitExecution.activateAfterFill(executed as SplitTradingOrder, evidence);
  }
  return {
    order: executed,
    duplicate: executed.submissionStartedAt !== null,
    splitOrders: snapshot.orders,
    aggregateState: snapshot.aggregateState,
    nextChild: snapshot.executable?.id === executed.id ? null : snapshot.executable,
  };
}

function errorResponse(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : 'TRADE_AUTOMATION_FAILED';
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code.includes('NOT_FOUND') ? 404
      : code.includes('STORAGE') || code.includes('MASTER_KEY') ? 503 : 400;
  return res.status(status).json({ ok: false, error: code, secretExposed: false, orderSubmitted: false });
}

type ApprovalSignalState = 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED' | 'INVALIDATED' | 'EXPIRED';

function approvalSignalState(value: TradingSignalState | null | undefined): ApprovalSignalState {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (normalized === 'ENTRY_READY' || normalized === 'READY_FOR_APPROVAL') return 'READY_FOR_APPROVAL';
  if (normalized === 'WEAKENED') return 'WEAKENED';
  if (normalized === 'INVALIDATED' || normalized === 'CONDITION_BROKEN') return 'INVALIDATED';
  if (normalized === 'EXPIRED') return 'EXPIRED';
  return 'WATCHING';
}

function approvalExpired(plan: TradingPlan, now = Date.now()) {
  return Boolean(plan.approvalExpiresAt
    && Number.isFinite(Date.parse(plan.approvalExpiresAt))
    && Date.parse(plan.approvalExpiresAt) <= now);
}

function approvalReadStatus(plan: TradingPlan, now = Date.now()) {
  const signalState = approvalSignalState(plan.marketSnapshot?.signalState);
  const expired = approvalExpired(plan, now);
  const approvalEnabled = plan.state === 'APPROVAL_PENDING'
    && plan.accountMode !== 'live'
    && signalState === 'READY_FOR_APPROVAL'
    && !expired
    && plan.riskAssessment?.allowed !== false;

  let reasonCode: string | null = null;
  if (plan.accountMode === 'live') reasonCode = 'LIVE_APPROVAL_LOCKED';
  else if (expired) reasonCode = 'APPROVAL_EXPIRED';
  else if (plan.state !== 'APPROVAL_PENDING') reasonCode = 'PLAN_NOT_APPROVAL_PENDING';
  else if (signalState !== 'READY_FOR_APPROVAL') reasonCode = 'SIGNAL_REVALIDATION_REQUIRED';
  else if (plan.riskAssessment?.allowed === false) reasonCode = 'RISK_CHECK_BLOCKED';

  return {
    approvalEnabled,
    signalState,
    planState: plan.state,
    reasonCode,
    expiresAt: plan.approvalExpiresAt,
    lastValidatedAt: plan.updatedAt,
  };
}

function approvalQueueOrder(order: TradingOrder | null) {
  if (!order) return null;
  return {
    state: order.state,
    filledQuantity: order.filledQuantity,
    updatedAt: order.updatedAt,
    lastErrorCode: order.lastErrorCode,
  };
}

function approvalQueueItem(plan: TradingPlan, order: TradingOrder | null, now = Date.now()) {
  const approval = approvalReadStatus(plan, now);
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
    signalState: approval.signalState,
    signalInvalidationReason: approval.signalState === 'INVALIDATED' || approval.signalState === 'EXPIRED'
      ? approval.reasonCode
      : null,
    state: plan.state,
    approvalExpiresAt: plan.approvalExpiresAt,
    updatedAt: plan.updatedAt,
    approval,
    order: approvalQueueOrder(order),
  };
}

router.get('/status', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const [policy, connections, orders, persistentGlobalStop] = await Promise.all([
      repository.getPolicy(userId), repository.getConnections(userId), repository.listOrders(userId),
      repository.getGlobalEmergencyStop(),
    ]);
    const environmentGlobalStop = process.env.TRADING_EMERGENCY_STOP === 'true';
    return res.json({
      ok: true,
      policy,
      connections: safeConnections(connections),
      emergencyStopped: policy.emergencyStopped || persistentGlobalStop || environmentGlobalStop,
      emergencyStopSources: {
        member: policy.emergencyStopped,
        persistentGlobal: persistentGlobalStop,
        environmentGlobal: environmentGlobalStop,
      },
      liveExecutionServerEnabled: {
        bitget: liveExecutionEnabled('bitget'),
        upbit: liveExecutionEnabled('upbit'),
        kiwoom: liveExecutionEnabled('kiwoom'),
      },
      credentialVault: credentialConfigurationStatus(),
      lastOrder: orders[0] ?? null,
      actualOrderSubmittedByStatusRequest: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.get('/approval-queue', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const plans = await repository.listPlans(userId);
    const relevant = plans.filter((plan) => plan.state === 'APPROVAL_PENDING' || plan.state === 'EXPIRED');
    const items = await Promise.all(relevant.map(async (plan) => approvalQueueItem(
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
  } catch (error) { return errorResponse(res, error); }
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
        signalState: approvalSignalState(plan.marketSnapshot?.signalState),
        signalInvalidationReason: null,
        approvalExpiresAt: plan.approvalExpiresAt,
        updatedAt: plan.updatedAt,
      },
      approval: approvalReadStatus(plan),
      orderSubmitted: false,
      orderCanceled: false,
      privateTradingRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.put('/policy', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const policy = normalizeTradingPolicy(req.body);
    const enablingAutomatic = policy.mode === 'automatic' || policy.automaticEnabled
      || Object.values(policy.exchangeEnabled).some(Boolean);
    if (enablingAutomatic && req.body?.confirmation?.acknowledged !== true) {
      return res.status(409).json({ ok: false, error: 'AUTOMATIC_TRADING_CONFIRMATION_REQUIRED' });
    }
    if (policy.mode !== 'automatic') {
      policy.automaticEnabled = false;
      policy.exchangeEnabled = { bitget: false, upbit: false, kiwoom: false };
      policy.enabledAssets = { bitget: [], upbit: [], kiwoom: [] };
    }
    await repository.savePolicy(userId, policy);
    return res.json({ ok: true, policy, defaultOff: !policy.automaticEnabled });
  } catch (error) { return errorResponse(res, error); }
});

router.put('/connections/:exchange', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const exchange = exchangeValue(req.params.exchange);
    const credentials = req.body?.credentials;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('CREDENTIALS_REQUIRED');
    const permissions = Array.isArray(req.body?.permissions) ? req.body.permissions.map(String).map((item: string) => item.toLowerCase()) : [];
    if (permissions.some((item: string) => item.includes('withdraw') || item.includes('출금'))) {
      throw new Error('WITHDRAWAL_PERMISSION_NOT_ALLOWED');
    }
    const allowedKeys: Record<TradingExchange, string[]> = {
      bitget: ['apiKey', 'secretKey', 'passphrase'],
      upbit: ['accessKey', 'secretKey'],
      kiwoom: ['appKey', 'secretKey'],
    };
    const safeCredentials = Object.fromEntries(allowedKeys[exchange].map((key) => [key, String(credentials[key] ?? '').trim()]));
    if (Object.values(safeCredentials).some((value) => !value)) throw new Error('CREDENTIALS_INCOMPLETE');
    const accountMode = req.body?.accountMode === 'live' ? 'live' : req.body?.accountMode === 'mock' ? 'mock' : 'paper';
    await repository.saveConnection({
      userId, exchange, accountMode, configured: true,
      encryptedCredentials: encryptTradingCredentials(safeCredentials),
      lastVerifiedAt: null, lastErrorCode: null, updatedAt: new Date().toISOString(),
    });
    return res.json({ ok: true, exchange, accountMode, configured: true, credentialsReturned: false });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/plans', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, automation } = context(req);
    const input = req.body as TradingPlanInput;
    exchangeValue(input.exchange);
    const [policy, existingOrders, persistentGlobalStop] = await Promise.all([
      repository.getPolicy(userId), repository.listOrders(userId), repository.getGlobalEmergencyStop(),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const persistedDailyOrders = existingOrders.filter((order) => order.createdAt.slice(0, 10) === today).length;
    input.marketSnapshot = {
      ...input.marketSnapshot,
      dailyOrderCount: Math.max(Number(input.marketSnapshot?.dailyOrderCount ?? 0), persistedDailyOrders),
    };
    const result = await automation.createPlan(userId, input, policy,
      policy.emergencyStopped || persistentGlobalStop || process.env.TRADING_EMERGENCY_STOP === 'true');
    if (!result.plan) return res.status(409).json({ ok: false, error: 'RISK_CHECK_BLOCKED', decision: result.decision, orderSubmitted: false });
    return res.json({ ok: true, plan: result.plan, duplicate: result.duplicate, orderSubmitted: false });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/plans/:id/approve', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, automation, execution, splitExecution } = context(req);
    if (req.body?.approved !== true) return res.status(409).json({ ok: false, error: 'EXPLICIT_APPROVAL_REQUIRED' });
    const plan = await automation.approvePlan(userId, String(req.params.id));
    const result = await executeSubmittedPlan(userId, plan, automation, execution, splitExecution);
    return res.json({ ok: true, plan, ...result });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/plans/:id/invalidate', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, automation, cancellation } = context(req);
    const result = await automation.invalidatePlan(userId, String(req.params.id));
    const order = result.order && CANCEL_RECONCILIATION_STATES.has(result.order.state)
      ? await cancellation.cancel(userId, result.plan, result.order) : result.order;
    return res.json({ ok: true, ...result, order, immediateMarketLiquidation: false, additionalApprovalRequired: true });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/emergency-stop', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const current = await repository.getPolicy(userId);
    const policy = normalizeTradingPolicy({
      ...current, automaticEnabled: false, emergencyStopped: true, mode: 'approval',
      exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    });
    await repository.savePolicy(userId, policy);
    return res.json({ ok: true, emergencyStopped: true, newOrdersBlocked: true, existingOrdersCanceled: false });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/admin/emergency-stop', requireAdmin, async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    if (typeof req.body?.stopped !== 'boolean') throw new Error('EMERGENCY_STOP_VALUE_REQUIRED');
    const expectedConfirmation = req.body.stopped ? 'STOP_ALL_TRADING' : 'RESUME_NEW_ORDER_EVALUATION';
    if (req.body?.confirmation !== expectedConfirmation) {
      return res.status(409).json({ ok: false, error: 'GLOBAL_EMERGENCY_STOP_CONFIRMATION_REQUIRED' });
    }
    await repository.setGlobalEmergencyStop(req.body.stopped, userId);
    const environmentGlobalStop = process.env.TRADING_EMERGENCY_STOP === 'true';
    return res.json({
      ok: true,
      persistentGlobalEmergencyStopped: req.body.stopped,
      effectiveGlobalEmergencyStopped: req.body.stopped || environmentGlobalStop,
      automaticTradingEnabledByThisRequest: false,
      existingOrdersCanceled: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.get('/orders', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const [orders, events] = await Promise.all([repository.listOrders(userId), repository.listEvents(userId)]);
    return res.json({ ok: true, orders, events });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/orders/:id/cancel', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, cancellation } = context(req);
    const order = await repository.getOrder(userId, String(req.params.id));
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');
    const plan = await repository.getPlan(userId, order.planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    const canceled = await cancellation.cancel(userId, plan, order);
    return res.json({
      ok: true,
      order: canceled,
      filledQuantityPreserved: canceled.filledQuantity,
      cancelRequestClaimId: canceled.cancelRequestClaimId ?? null,
      exchangeCancelSubmittedAtMostOnce: true,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/recovery/scan', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, automation, execution } = context(req);
    const candidates = await automation.recoverOpenOrders(userId);
    const orders = [];
    for (const candidate of candidates) {
      const plan = await repository.getPlan(userId, candidate.planId);
      if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
      orders.push(await execution.reconcile(userId, plan, candidate));
    }
    return res.json({
      ok: true,
      recoveryRequired: candidates.length,
      reconciled: orders.filter((order) => order.state !== 'RECOVERY_REQUIRED').length,
      pending: orders.filter((order) => order.state === 'RECOVERY_REQUIRED' && !order.manualReviewRequired).length,
      manualReviewRequired: orders.filter((order) => order.manualReviewRequired).length,
      orders,
      exchangeOrdersSubmitted: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

export default router;