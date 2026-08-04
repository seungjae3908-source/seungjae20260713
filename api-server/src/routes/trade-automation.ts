import { Router, type IRouter, type Response } from 'express';
import { createSupabaseTradingRepository, safeConnections, type TradingRepository } from '../services/trade-automation.repository';
import { liveExecutionEnabled, TradeAutomationService } from '../services/trade-automation.service';
import { TradeExecutionCoordinator } from '../services/trade-execution-coordinator.service';
import { credentialConfigurationStatus, encryptTradingCredentials } from '../services/trade-credential-vault.service';
import { normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import { enforceMemberTradingPolicy, resumeMemberTradingPolicy } from '../services/trade-automation-policy-guard.service';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import type {
  TradingExchange,
  TradingOrder,
  TradingPlan,
  TradingPlanInput,
  TradingPlanRevalidationInput,
} from '../services/trade-automation.types';

const router: IRouter = Router();
const EXCHANGES = new Set<TradingExchange>(['bitget', 'upbit', 'kiwoom']);
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setTradeAutomationRepositoryFactoryForTests(
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
    execution: new TradeExecutionCoordinator(repository),
  };
}

function exchangeValue(value: unknown): TradingExchange {
  const exchange = String(value ?? '').toLowerCase() as TradingExchange;
  if (!EXCHANGES.has(exchange)) throw new Error('UNSUPPORTED_EXCHANGE');
  return exchange;
}

function errorResponse(res: Response, error: unknown, executionClaimed = false) {
  const code = error instanceof Error ? error.message.split(':')[0] : 'TRADE_AUTOMATION_FAILED';
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code.includes('NOT_FOUND') ? 404
      : code.includes('STORAGE') || code.includes('MASTER_KEY') ? 503 : 400;
  if (executionClaimed) {
    return res.status(status).json({
      ok: false,
      error: code,
      secretExposed: false,
      submissionOutcome: 'unknown',
      recoveryRequired: true,
      orderResubmitted: false,
    });
  }
  return res.status(status).json({
    ok: false,
    error: code,
    secretExposed: false,
    orderSubmitted: false,
    exchangeRequestSent: false,
    submissionOutcome: 'not_started',
    recoveryRequired: false,
    orderResubmitted: false,
  });
}

function executionOutcome(order: TradingOrder, executionClaimed: boolean) {
  if (!executionClaimed) {
    return {
      submissionOutcome: 'not_started' as const,
      recoveryRequired: order.state === 'RECOVERY_REQUIRED',
      orderResubmitted: false,
    };
  }
  if (order.state === 'RECOVERY_REQUIRED' || order.state === 'SUBMITTED') {
    return {
      submissionOutcome: 'unknown' as const,
      recoveryRequired: true,
      orderResubmitted: false,
    };
  }
  if (order.state === 'REJECTED') {
    return {
      submissionOutcome: 'rejected' as const,
      recoveryRequired: false,
      orderResubmitted: false,
    };
  }
  return {
    submissionOutcome: 'accepted' as const,
    recoveryRequired: false,
    orderResubmitted: false,
  };
}

function safePlanView(plan: TradingPlan) {
  const { userId: _userId, idempotencyKey: _idempotencyKey, ...safe } = plan;
  return { ...safe, internalIdentityExposed: false };
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

router.put('/policy', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const current = await repository.getPolicy(userId);
    const candidate = normalizeTradingPolicy({ ...req.body, pilotStage: current.pilotStage });
    const policy = enforceMemberTradingPolicy(candidate, current);
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
    return res.json({
      ok: true,
      policy,
      defaultOff: !policy.automaticEnabled,
      safetyDowngradeAllowed: false,
      pilotStageManagedSeparately: true,
      emergencyStopRequiresConfirmedResume: true,
    });
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

router.get('/plans', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const requestedState = typeof req.query.state === 'string' ? req.query.state.trim() : '';
    const plans = await repository.listPlans(userId);
    const filtered = requestedState ? plans.filter((plan) => plan.state === requestedState) : plans;
    return res.json({
      ok: true,
      plans: filtered.slice(0, 100).map(safePlanView),
      internalIdentityExposed: false,
      actualOrderSubmittedByListRequest: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/plans', async (req: AuthenticatedRequest, res) => {
  let executionClaimed = false;
  try {
    const { userId, repository, automation, execution } = context(req);
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
    if (policy.mode === 'automatic' && policy.automaticEnabled && result.plan.state === 'PLANNED') {
      const submission = await automation.beginAutomaticPlanAndCreateOrder(userId, result.plan.id);
      executionClaimed = submission.executionClaimed;
      const executed = executionClaimed
        ? await execution.execute(userId, submission.plan, submission.order)
        : submission.order;
      return res.json({
        ok: true,
        plan: safePlanView(submission.plan),
        order: executed,
        duplicate: result.duplicate || submission.duplicate,
        executionClaimed,
        ...executionOutcome(executed, executionClaimed),
      });
    }
    return res.json({ ok: true, plan: safePlanView(result.plan), duplicate: result.duplicate, orderSubmitted: false });
  } catch (error) { return errorResponse(res, error, executionClaimed); }
});

router.post('/plans/:id/approve', async (req: AuthenticatedRequest, res) => {
  let executionClaimed = false;
  try {
    const { userId, automation, execution } = context(req);
    if (req.body?.approved !== true) return res.status(409).json({ ok: false, error: 'EXPLICIT_APPROVAL_REQUIRED' });
    const revalidation = req.body?.revalidation as TradingPlanRevalidationInput | undefined;
    const submission = await automation.approvePlanAndCreateOrder(userId, String(req.params.id), revalidation);
    executionClaimed = submission.executionClaimed;
    const result = executionClaimed
      ? await execution.execute(userId, submission.plan, submission.order)
      : submission.order;
    return res.json({
      ok: true,
      plan: safePlanView(submission.plan),
      order: result,
      duplicate: submission.duplicate,
      executionClaimed,
      ...executionOutcome(result, executionClaimed),
    });
  } catch (error) { return errorResponse(res, error, executionClaimed); }
});

router.post('/plans/:id/invalidate', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, automation, execution } = context(req);
    const result = await automation.invalidatePlan(userId, String(req.params.id));
    const order = result.order?.state === 'CANCEL_REQUESTED'
      ? await execution.cancel(userId, result.plan, result.order) : result.order;
    return res.json({ ok: true, plan: safePlanView(result.plan), order, filledQuantityPreserved: result.filledQuantityPreserved, immediateMarketLiquidation: false, additionalApprovalRequired: true });
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

router.post('/resume', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    if (req.body?.confirmation !== 'RESUME_NEW_ORDER_EVALUATION') {
      return res.status(409).json({ ok: false, error: 'TRADING_RESUME_CONFIRMATION_REQUIRED' });
    }
    if (process.env.TRADING_EMERGENCY_STOP === 'true' || await repository.getGlobalEmergencyStop()) {
      return res.status(409).json({ ok: false, error: 'GLOBAL_EMERGENCY_STOP_ACTIVE' });
    }
    const current = await repository.getPolicy(userId);
    const policy = resumeMemberTradingPolicy(current);
    await repository.savePolicy(userId, policy);
    return res.json({
      ok: true,
      policy,
      emergencyStopped: false,
      automaticTradingEnabledByThisRequest: false,
      exchangesEnabledByThisRequest: false,
      requiresFreshSignalEvaluation: true,
    });
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
    const { userId, repository, execution } = context(req);
    const order = await repository.getOrder(userId, String(req.params.id));
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');
    const plan = await repository.getPlan(userId, order.planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    const canceled = await execution.cancel(userId, plan, order);
    return res.json({ ok: true, order: canceled, filledQuantityPreserved: canceled.filledQuantity });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/orders/:id/reconcile', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, execution } = context(req);
    const order = await repository.getOrder(userId, String(req.params.id));
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');
    const plan = await repository.getPlan(userId, order.planId);
    if (!plan) throw new Error('TRADE_PLAN_NOT_FOUND');
    const result = await execution.reconcileOrder(userId, plan, order);
    return res.json({
      ok: true,
      order: result.order,
      resolved: result.resolved,
      querySent: result.querySent,
      authenticationRequests: result.authenticationRequests,
      statusQueries: result.statusQueries,
      orderResubmitted: false,
      exchangeOrdersSubmitted: false,
      exchangeCancelsSubmitted: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/recovery/scan', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, execution } = context(req);
    const result = await execution.reconcileRecoverableOrders(userId);
    return res.json({
      ok: true,
      recoveryRequired: result.unresolved,
      resolved: result.resolved,
      unresolved: result.unresolved,
      queriesSent: result.queriesSent,
      authenticationRequests: result.authenticationRequests,
      statusQueries: result.statusQueries,
      orders: result.orders,
      orderResubmitted: false,
      exchangeOrdersSubmitted: false,
      exchangeCancelsSubmitted: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

export default router;
