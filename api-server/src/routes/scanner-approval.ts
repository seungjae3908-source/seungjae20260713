import { Router, type IRouter, type NextFunction, type Response } from 'express';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../services/trade-automation.repository';
import { TradeAutomationService } from '../services/trade-automation.service';
import {
  ScannerApprovalPlanService,
  type ScannerApprovalPlanRequest,
} from '../services/scanner-approval-plan.service';
import type { AuthenticatedRequest } from '../middleware/auth';
import type {
  TradingApprovalStatus,
  TradingPlan,
  TradingSignalValidationInput,
} from '../services/trade-automation.types';

const router: IRouter = Router();
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export type ScannerApprovalService = {
  createPaperPlan: (
    userId: string,
    request: ScannerApprovalPlanRequest,
  ) => Promise<{
    plan: Pick<TradingPlan, 'id' | 'accountMode' | 'state'>;
    approval: Pick<TradingApprovalStatus, 'approvalEnabled'>;
    duplicate: boolean;
    serverVerified: boolean;
    liveOrderEnabled: boolean;
  }>;
  revalidatePaperPlan: (
    userId: string,
    plan: TradingPlan,
  ) => Promise<TradingSignalValidationInput>;
};

let scannerServiceFactoryForTests:
  | ((repository: TradingRepository) => ScannerApprovalService)
  | null = null;

export function setScannerApprovalFactoriesForTests(
  repositoryFactory: ((userId: string) => TradingRepository) | null,
  serviceFactory: ((repository: TradingRepository) => ScannerApprovalService) | null = null,
) {
  repositoryFactoryForTests = repositoryFactory;
  scannerServiceFactoryForTests = serviceFactory;
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
    scanner: scannerServiceFactoryForTests
      ? scannerServiceFactoryForTests(repository)
      : new ScannerApprovalPlanService(repository),
  };
}

function requestValue(body: unknown): ScannerApprovalPlanRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('SCANNER_PLAN_REQUEST_REQUIRED');
  const input = body as Record<string, unknown>;
  return {
    market: String(input.market ?? '').toUpperCase() as ScannerApprovalPlanRequest['market'],
    symbol: String(input.symbol ?? input.ticker ?? ''),
    timeframe: String(input.timeframe ?? '1D'),
    selectedConditions: Array.isArray(input.selectedConditions)
      ? input.selectedConditions.map(String)
      : Array.isArray(input.conditions)
        ? input.conditions.map(String)
        : [],
    requestedInvestmentKrw: input.requestedInvestmentKrw == null
      ? undefined
      : Number(input.requestedInvestmentKrw),
    splitRatios: Array.isArray(input.splitRatios) ? input.splitRatios.map(Number) : undefined,
    volumeThreshold: input.volumeThreshold == null ? undefined : Number(input.volumeThreshold),
    tradingValueThreshold: input.tradingValueThreshold == null ? undefined : Number(input.tradingValueThreshold),
    marketCapThreshold: input.marketCapThreshold == null ? undefined : Number(input.marketCapThreshold),
    volumeLookbackDays: input.volumeLookbackDays == null ? undefined : Number(input.volumeLookbackDays),
    tradingValueLookbackDays: input.tradingValueLookbackDays == null ? undefined : Number(input.tradingValueLookbackDays),
    minimumScore: input.minimumScore == null ? undefined : Number(input.minimumScore),
    minimumConfidence: input.minimumConfidence == null ? undefined : Number(input.minimumConfidence),
    maximumRiskScore: input.maximumRiskScore == null ? undefined : Number(input.maximumRiskScore),
  };
}

function isScannerPaperPlan(plan: TradingPlan | null): plan is TradingPlan {
  return Boolean(plan
    && plan.accountMode === 'paper'
    && plan.exchange === 'kiwoom'
    && plan.market === 'KR'
    && plan.strategyId.startsWith('scanner-'));
}

function errorResponse(res: Response, error: unknown) {
  const raw = error instanceof Error ? error.message : 'SCANNER_APPROVAL_FAILED';
  const code = raw.split(':')[0];
  const status = code === 'LOGIN_REQUIRED' ? 401
    : code.includes('NOT_FOUND') ? 404
      : code.includes('NOT_AVAILABLE') || code.includes('NOT_MAINTAINED') || code.includes('BLOCKED')
        || code.includes('INVALIDATED') || code.includes('EXPIRED') || code.includes('NOT_APPROVABLE')
        || code.includes('DRIFTED') ? 409
        : code.includes('UNAVAILABLE') || code.includes('PROVIDER') ? 503
          : 400;
  return res.status(status).json({
    ok: false,
    error: code,
    orderSubmitted: false,
    liveOrderSubmitted: false,
    exchangeRequestSent: false,
  });
}

async function approveScannerPaperPlan(req: AuthenticatedRequest, res: Response) {
  if (req.body?.approved !== true) {
    return res.status(409).json({
      ok: false,
      error: 'EXPLICIT_APPROVAL_REQUIRED',
      orderSubmitted: false,
      liveOrderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  const { userId, repository, automation, scanner } = context(req);
  const stored = await repository.getPlan(userId, String(req.params.id));
  if (!stored) throw new Error('TRADE_PLAN_NOT_FOUND');
  if (!isScannerPaperPlan(stored)) throw new Error('SCANNER_PAPER_APPROVAL_ONLY');
  if (!Number.isSafeInteger(stored.quantity) || Number(stored.quantity) <= 0) {
    throw new Error('SCANNER_PAPER_QUANTITY_INVALID');
  }
  const existingOrder = await repository.findOrderByPlan(userId, stored.id);
  if (existingOrder) {
    return res.json({
      ok: true,
      plan: stored,
      order: existingOrder,
      duplicate: true,
      paperOrderCreated: true,
      liveOrderSubmitted: false,
      exchangeRequestSent: false,
    });
  }

  const validation = await scanner.revalidatePaperPlan(userId, stored);
  const revalidated = await automation.revalidatePlan(userId, stored.id, validation);
  if (!revalidated.approval.approvalEnabled) {
    throw new Error(`TRADE_PLAN_SIGNAL_NOT_APPROVABLE:${revalidated.approval.reasonCode ?? 'UNKNOWN'}`);
  }

  const plan = await automation.approvePlan(userId, stored.id);
  const created = await automation.createOrder(userId, plan);
  if (created.duplicate) {
    return res.json({
      ok: true,
      plan,
      order: created.order,
      duplicate: true,
      paperOrderCreated: true,
      liveOrderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  const quantity = Number(plan.quantity);
  const averageFillPrice = quantity > 0 ? plan.estimatedKrw / quantity : null;
  await automation.transition(created.order, 'ACCEPTED', 'SCANNER_PAPER_BROKER_ACCEPTED', {
    exchangeOrderId: `paper-scanner-${created.order.clientOrderId}`,
  });
  const order = await automation.transition(created.order, 'FILLED', 'SCANNER_PAPER_BROKER_FILLED', {
    filledQuantity: quantity,
    averageFillPrice,
  });
  return res.json({
    ok: true,
    plan,
    order,
    duplicate: false,
    paperOrderCreated: true,
    serverRevalidatedAt: plan.lastSignalValidatedAt,
    liveOrderSubmitted: false,
    exchangeRequestSent: false,
  });
}

router.post('/scanner/plans', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, scanner } = context(req);
    const result = await scanner.createPaperPlan(userId, requestValue(req.body));
    return res.status(result.duplicate ? 200 : 201).json({
      ok: true,
      ...result,
      orderSubmitted: false,
      liveOrderSubmitted: false,
      exchangeRequestSent: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/plans/:id/approve', async (req: AuthenticatedRequest, res, next: NextFunction) => {
  try {
    const { userId, repository } = context(req);
    const plan = await repository.getPlan(userId, String(req.params.id));
    if (!isScannerPaperPlan(plan)) return next();
    return await approveScannerPaperPlan(req, res);
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/plans/:id/approve-paper', async (req: AuthenticatedRequest, res) => {
  try {
    return await approveScannerPaperPlan(req, res);
  } catch (error) {
    return errorResponse(res, error);
  }
});

export default router;
