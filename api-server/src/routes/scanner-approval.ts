import { Router, type IRouter, type Response } from 'express';
import { createSupabaseTradingRepository, type TradingRepository } from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import { evaluateTradingPlan, normalizeTradingPolicy } from '../services/trade-automation-risk.service';
import type { TradingPlan, TradingPolicy } from '../services/trade-automation.types';
import type { AuthenticatedRequest } from '../middleware/auth';
import type { ScannerSignalCandidate, ScannerTradingSignal } from '../services/scanner-approval.types';
import {
  approvalGuard,
  cancelPendingScannerEntries,
  continuationGuard,
  createScannerSignal,
  normalizeScannerApprovalPolicy,
  revalidateScannerSignal,
  scannerSignalToPaperPlan,
  updateScannerEntryLeg,
} from '../services/scanner-approval.service';

const router: IRouter = Router();
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setScannerApprovalRepositoryFactoryForTests(factory: ((userId: string) => TradingRepository) | null) {
  repositoryFactoryForTests = factory;
}

function context(req: AuthenticatedRequest) {
  if (!req.member?.id) throw new Error('LOGIN_REQUIRED');
  const repository = repositoryFactoryForTests
    ? repositoryFactoryForTests(req.member.id)
    : req.accessToken
      ? createSupabaseTradingRepository(req.accessToken, req.member.id)
      : (() => { throw new Error('LOGIN_REQUIRED'); })();
  return { userId: req.member.id, repository, automation: new TradeAutomationService(repository) };
}

function errorResponse(res: Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'SCANNER_APPROVAL_FAILED';
  const code = message.split(':')[0];
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code.includes('NOT_FOUND') ? 404
      : code.includes('STORAGE') ? 503 : 400;
  return res.status(status).json({
    ok: false,
    error: code,
    detailCodes: message.includes(':') ? message.slice(message.indexOf(':') + 1).split(',').filter(Boolean) : [],
    paperOnly: true,
    liveOrderEnabled: false,
    exchangeRequestSent: false,
  });
}

function scannerPolicyFromTradingPolicy(policy: Awaited<ReturnType<TradingRepository['getPolicy']>>) {
  const exposureBudget = policy.totalCapitalKrw * policy.maxAssetPercent / 100;
  return normalizeScannerApprovalPolicy({
    maximumOrderKrw: Math.min(policy.maxOrderKrw, exposureBudget),
    accountValueKrw: policy.totalCapitalKrw,
    minimumScore: 60,
    minimumConfidence: 55,
    maximumRiskScore: 65,
  });
}

function paperApprovalPolicy(policy: TradingPolicy) {
  return normalizeTradingPolicy({
    ...policy,
    mode: 'approval',
    automaticEnabled: false,
    exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
    enabledAssets: { bitget: [], upbit: [], kiwoom: [] },
    enabledStrategies: [],
  });
}

function candidate(value: unknown): ScannerSignalCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCANNER_CANDIDATE_REQUIRED');
  return value as ScannerSignalCandidate;
}

function finite(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function updateMarketSnapshot(plan: TradingPlan, input: ScannerSignalCandidate, signal: ScannerTradingSignal) {
  const snapshot = input.marketSnapshot ?? {};
  plan.marketSnapshot = {
    ...plan.marketSnapshot,
    observedAt: snapshot.observedAt && Number.isFinite(Date.parse(snapshot.observedAt))
      ? new Date(snapshot.observedAt).toISOString() : signal.dataTimestamp,
    dataDelayMs: Math.max(0, finite(snapshot.dataDelayMs, plan.marketSnapshot.dataDelayMs)),
    oneMinuteMovePercent: finite(snapshot.oneMinuteMovePercent, plan.marketSnapshot.oneMinuteMovePercent),
    spreadPercent: Math.max(0, finite(snapshot.spreadPercent, plan.marketSnapshot.spreadPercent)),
    orderbookGapPercent: Math.max(0, finite(snapshot.orderbookGapPercent, plan.marketSnapshot.orderbookGapPercent)),
    halted: snapshot.halted === true,
  };
}

function scannerSignalOf(value: unknown): ScannerTradingSignal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCANNER_SIGNAL_NOT_FOUND');
  const signal = value as ScannerTradingSignal;
  if (!signal.id || !signal.symbol || !signal.state) throw new Error('SCANNER_SIGNAL_NOT_FOUND');
  return signal;
}

function transitionSignal(signal: ScannerTradingSignal, state: ScannerTradingSignal['state'], reason: string): ScannerTradingSignal {
  if (signal.state === state) return signal;
  const changedAt = new Date().toISOString();
  return {
    ...signal,
    state,
    transitions: [...signal.transitions, {
      from: signal.state,
      to: state,
      changedAt,
      currentPrice: signal.currentPrice,
      previousScore: signal.score,
      currentScore: signal.score,
      reason,
      changedConditions: [],
      dataTimestamp: signal.dataTimestamp,
    }],
  };
}

async function applyDailyOrderCount(repository: TradingRepository, userId: string, plan: TradingPlan | ReturnType<typeof scannerSignalToPaperPlan>) {
  const today = new Date().toISOString().slice(0, 10);
  const orders = await repository.listOrders(userId);
  plan.marketSnapshot.dailyOrderCount = orders.filter((order) => order.createdAt.slice(0, 10) === today).length;
}

async function approvePaperPlan(
  repository: TradingRepository,
  userId: string,
  plan: TradingPlan,
  policy: TradingPolicy,
) {
  if (plan.accountMode !== 'paper') throw new Error('SCANNER_PAPER_PLAN_REQUIRED');
  if (plan.state !== 'APPROVAL_PENDING') throw new Error('TRADE_PLAN_NOT_APPROVAL_PENDING');
  if (!plan.approvalExpiresAt || Date.parse(plan.approvalExpiresAt) <= Date.now()) {
    plan.state = 'EXPIRED';
    plan.updatedAt = new Date().toISOString();
    await repository.savePlan(plan);
    throw new Error('TRADE_PLAN_EXPIRED');
  }
  const emergencyStopped = policy.emergencyStopped
    || process.env.TRADING_EMERGENCY_STOP === 'true'
    || await repository.getGlobalEmergencyStop();
  const decision = evaluateTradingPlan(plan, policy, { emergencyStopped, serverLiveEnabled: true });
  if (!decision.allowed) {
    plan.state = 'EXPIRED';
    plan.updatedAt = new Date().toISOString();
    await repository.savePlan(plan);
    throw new Error(`TRADE_PLAN_RISK_RECHECK_FAILED:${decision.blockCodes.join(',')}`);
  }
  plan.state = 'SUBMITTED';
  plan.approvedAt = new Date().toISOString();
  plan.updatedAt = plan.approvedAt;
  await repository.savePlan(plan);
  return plan;
}

async function fillPaperOrder(automation: TradeAutomationService, userId: string, plan: TradingPlan) {
  const created = await automation.createOrder(userId, plan);
  let order = created.order;
  if (!created.duplicate) {
    order = await automation.transition(order, 'ACCEPTED', 'SCANNER_PAPER_BROKER_ACCEPTED', {
      accountMode: 'paper',
      exchangeRequestSent: false,
      entrySequence: plan.scannerEntryLegSequence ?? 1,
    });
    order = await automation.transition(order, 'FILLED', 'SCANNER_PAPER_BROKER_FILLED', {
      exchangeOrderId: `paper-${order.clientOrderId}`,
      filledQuantity: plan.quantity ?? 0,
      averageFillPrice: plan.limitPrice,
      exchangeRequestSent: false,
      entrySequence: plan.scannerEntryLegSequence ?? 1,
    });
  }
  return { order, duplicate: created.duplicate };
}

async function activateDueEntryLegs(args: {
  userId: string;
  repository: TradingRepository;
  automation: TradeAutomationService;
  parentPlan: TradingPlan;
  signal: ScannerTradingSignal;
  input: ScannerSignalCandidate;
  scannerPolicy: ReturnType<typeof normalizeScannerApprovalPolicy>;
  approvalPolicy: TradingPolicy;
}) {
  let signal = args.signal;
  const activatedEntries: Array<{ sequence: 2 | 3; planId: string; orderId: string; orderState: string; duplicate: boolean }> = [];
  if (!continuationGuard(signal, args.scannerPolicy).enabled) return { signal, activatedEntries };
  const due = signal.entryPlan.legs.filter((leg): leg is typeof leg & { sequence: 2 | 3 } =>
    leg.sequence > 1 && leg.status === 'PLANNED' && signal.currentPrice <= leg.price);
  for (const leg of due) {
    const childInput = scannerSignalToPaperPlan(
      signal,
      args.scannerPolicy,
      args.input.marketSnapshot,
      leg.sequence,
      args.parentPlan.id,
    );
    await applyDailyOrderCount(args.repository, args.userId, childInput);
    const emergencyStopped = args.approvalPolicy.emergencyStopped
      || await args.repository.getGlobalEmergencyStop()
      || process.env.TRADING_EMERGENCY_STOP === 'true';
    const created = await args.automation.createPlan(
      args.userId,
      childInput,
      args.approvalPolicy,
      emergencyStopped,
    );
    if (!created.plan) throw new Error(`SCANNER_FOLLOW_UP_RISK_BLOCKED:${created.decision.blockCodes.join(',')}`);
    let childPlan = created.plan;
    if (childPlan.state === 'APPROVAL_PENDING') {
      childPlan = await approvePaperPlan(args.repository, args.userId, childPlan, args.approvalPolicy);
    }
    if (childPlan.state !== 'SUBMITTED') throw new Error('SCANNER_FOLLOW_UP_PLAN_NOT_SUBMITTED');
    const filled = await fillPaperOrder(args.automation, args.userId, childPlan);
    signal = updateScannerEntryLeg(signal, leg.sequence, 'FILLED', `SCANNER_ENTRY_LEG_${leg.sequence}_PAPER_FILLED`);
    childPlan.scannerSignal = signal;
    childPlan.approvalNonce = null;
    childPlan.updatedAt = new Date().toISOString();
    await args.repository.savePlan(childPlan);
    activatedEntries.push({
      sequence: leg.sequence,
      planId: childPlan.id,
      orderId: filled.order.id,
      orderState: filled.order.state,
      duplicate: created.duplicate || filled.duplicate,
    });
  }
  return { signal, activatedEntries };
}

router.post('/signals', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, automation } = context(req);
    const input = candidate(req.body?.candidate);
    const tradingPolicy = await repository.getPolicy(userId);
    const scannerPolicy = scannerPolicyFromTradingPolicy(tradingPolicy);
    const signal = createScannerSignal(input, scannerPolicy);
    const guard = approvalGuard(signal, scannerPolicy);
    if (!guard.enabled) {
      return res.status(202).json({
        ok: true,
        signal,
        guard,
        plan: null,
        orderSubmitted: false,
        paperOnly: true,
        liveOrderEnabled: false,
        exchangeRequestSent: false,
      });
    }
    const approvalPolicy = paperApprovalPolicy(tradingPolicy);
    const planInput = scannerSignalToPaperPlan(signal, scannerPolicy, input.marketSnapshot);
    await applyDailyOrderCount(repository, userId, planInput);
    const emergencyStopped = approvalPolicy.emergencyStopped
      || await repository.getGlobalEmergencyStop()
      || process.env.TRADING_EMERGENCY_STOP === 'true';
    const result = await automation.createPlan(userId, planInput, approvalPolicy, emergencyStopped);
    if (!result.plan) {
      return res.status(409).json({
        ok: false,
        error: 'SCANNER_PLAN_RISK_BLOCKED',
        signal,
        guard,
        decision: result.decision,
        orderSubmitted: false,
        paperOnly: true,
        liveOrderEnabled: false,
        exchangeRequestSent: false,
      });
    }
    const storedSignal = scannerSignalOf(result.plan.scannerSignal ?? signal);
    result.plan.scannerSignal = transitionSignal(storedSignal, 'APPROVAL_SENT', 'APPROVAL_REQUEST_CREATED');
    result.plan.updatedAt = new Date().toISOString();
    await repository.savePlan(result.plan);
    return res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      signal: result.plan.scannerSignal,
      guard: approvalGuard(result.plan.scannerSignal, scannerPolicy),
      plan: result.plan,
      approvalToken: result.plan.approvalNonce,
      duplicate: result.duplicate,
      orderSubmitted: false,
      paperOnly: true,
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.get('/signals/:id', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!plan) throw new Error('SCANNER_PLAN_NOT_FOUND');
    const signal = scannerSignalOf(plan.scannerSignal);
    const scannerPolicy = scannerPolicyFromTradingPolicy(await repository.getPolicy(userId));
    return res.json({
      ok: true,
      signal,
      guard: approvalGuard(signal, scannerPolicy),
      plan,
      approvalToken: plan.state === 'APPROVAL_PENDING' ? plan.approvalNonce : null,
      paperOnly: plan.accountMode === 'paper',
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/signals/:id/revalidate', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, automation } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!plan) throw new Error('SCANNER_PLAN_NOT_FOUND');
    if (plan.accountMode !== 'paper') throw new Error('SCANNER_PAPER_PLAN_REQUIRED');
    const previous = scannerSignalOf(plan.scannerSignal);
    const input = candidate(req.body?.candidate);
    const tradingPolicy = await repository.getPolicy(userId);
    const scannerPolicy = scannerPolicyFromTradingPolicy(tradingPolicy);
    const approvalPolicy = paperApprovalPolicy(tradingPolicy);
    const result = revalidateScannerSignal(previous, input, scannerPolicy);
    let signal = result.signal;
    updateMarketSnapshot(plan, input, signal);
    let activatedEntries: Awaited<ReturnType<typeof activateDueEntryLegs>>['activatedEntries'] = [];
    const invalid = signal.state === 'INVALIDATED' || signal.state === 'EXPIRED';
    if (invalid) {
      signal = cancelPendingScannerEntries(signal);
      plan.approvalNonce = null;
    } else if (previous.state === 'APPROVED' && signal.state === 'APPROVED') {
      const activated = await activateDueEntryLegs({
        userId, repository, automation, parentPlan: plan, signal, input, scannerPolicy, approvalPolicy,
      });
      signal = activated.signal;
      activatedEntries = activated.activatedEntries;
    }
    plan.scannerSignal = signal;
    plan.updatedAt = new Date().toISOString();
    await repository.savePlan(plan);
    if (invalid) await automation.invalidatePlan(userId, plan.id);
    const approval = approvalGuard(signal, scannerPolicy);
    const continuation = continuationGuard(signal, scannerPolicy);
    const pendingLegs = signal.entryPlan.legs.filter((leg) => leg.status === 'PLANNED');
    return res.json({
      ok: true,
      signal,
      guard: previous.state === 'APPROVED' ? continuation : approval,
      planState: plan.state,
      approvalRevoked: previous.state !== 'APPROVED' && !approval.enabled,
      followUpEntriesCancelled: invalid,
      positionManagementMode: previous.state === 'APPROVED',
      additionalEntriesEnabled: previous.state === 'APPROVED' && continuation.enabled && pendingLegs.length > 0,
      nextEntryPrice: pendingLegs[0]?.price ?? null,
      activatedEntries,
      paperOnly: true,
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/signals/:id/approve', async (req: AuthenticatedRequest, res) => {
  try {
    if (req.body?.approved !== true) return res.status(409).json({
      ok: false,
      error: 'EXPLICIT_APPROVAL_REQUIRED',
      paperOnly: true,
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
    const { userId, repository, automation } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!plan) throw new Error('SCANNER_PLAN_NOT_FOUND');
    if (plan.accountMode !== 'paper') throw new Error('SCANNER_PAPER_PLAN_REQUIRED');
    if (!plan.approvalNonce || req.body?.approvalToken !== plan.approvalNonce) {
      throw new Error('SCANNER_APPROVAL_TOKEN_INVALID');
    }
    const previous = scannerSignalOf(plan.scannerSignal);
    const input = candidate(req.body?.candidate);
    const tradingPolicy = await repository.getPolicy(userId);
    const scannerPolicy = scannerPolicyFromTradingPolicy(tradingPolicy);
    const approvalPolicy = paperApprovalPolicy(tradingPolicy);
    const validated = revalidateScannerSignal(previous, input, scannerPolicy);
    plan.scannerSignal = validated.signal;
    updateMarketSnapshot(plan, input, validated.signal);
    plan.updatedAt = new Date().toISOString();
    await applyDailyOrderCount(repository, userId, plan);
    await repository.savePlan(plan);
    if (!approvalGuard(validated.signal, scannerPolicy).enabled) {
      plan.scannerSignal = cancelPendingScannerEntries(validated.signal);
      plan.approvalNonce = null;
      await repository.savePlan(plan);
      await automation.invalidatePlan(userId, plan.id);
      return res.status(409).json({
        ok: false,
        error: 'SCANNER_APPROVAL_REVALIDATION_FAILED',
        signal: plan.scannerSignal,
        guard: approvalGuard(plan.scannerSignal, scannerPolicy),
        orderSubmitted: false,
        followUpEntriesCancelled: true,
        paperOnly: true,
        liveOrderEnabled: false,
        exchangeRequestSent: false,
      });
    }
    const approved = await approvePaperPlan(repository, userId, plan, approvalPolicy);
    let approvedSignal = transitionSignal(validated.signal, 'APPROVED', 'USER_APPROVED_PAPER_ORDER');
    approvedSignal = updateScannerEntryLeg(approvedSignal, 1, 'FILLED', 'SCANNER_ENTRY_LEG_1_PAPER_FILLED');
    approved.scannerSignal = approvedSignal;
    approved.approvalNonce = null;
    await repository.savePlan(approved);
    const filled = await fillPaperOrder(automation, userId, approved);
    return res.json({
      ok: true,
      signal: approvedSignal,
      guard: { enabled: false, reasons: ['ALREADY_APPROVED'], checkedAt: new Date().toISOString() },
      plan: approved,
      order: filled.order,
      duplicate: filled.duplicate,
      filledEntrySequence: 1,
      remainingEntrySequences: approvedSignal.entryPlan.legs.filter((leg) => leg.status === 'PLANNED').map((leg) => leg.sequence),
      paperOrderCreated: true,
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

router.post('/signals/:id/reject', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository, automation } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!plan) throw new Error('SCANNER_PLAN_NOT_FOUND');
    const previous = scannerSignalOf(plan.scannerSignal);
    plan.scannerSignal = cancelPendingScannerEntries(transitionSignal(previous, 'REJECTED', 'USER_REJECTED'));
    plan.approvalNonce = null;
    plan.updatedAt = new Date().toISOString();
    await repository.savePlan(plan);
    await automation.invalidatePlan(userId, plan.id);
    return res.json({
      ok: true,
      signal: plan.scannerSignal,
      guard: { enabled: false, reasons: ['SIGNAL_STATE_REJECTED'], checkedAt: new Date().toISOString() },
      approvalRevoked: true,
      followUpEntriesCancelled: true,
      orderSubmitted: false,
      paperOnly: true,
      liveOrderEnabled: false,
      exchangeRequestSent: false,
    });
  } catch (error) { return errorResponse(res, error); }
});

export default router;
