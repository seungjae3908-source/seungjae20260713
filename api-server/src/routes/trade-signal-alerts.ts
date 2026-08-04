import { Router, type IRouter, type Response } from 'express';
import {
  createSupabaseTradingRepository,
  type TradingRepository,
} from '../services/trade-automation.repository';
import { listTradeSignalAlerts } from '../services/trade-signal-alert.service';
import type { AuthenticatedRequest } from '../middleware/auth';

const router: IRouter = Router();
let repositoryFactoryForTests: ((userId: string) => TradingRepository) | null = null;

export function setTradeSignalAlertRepositoryFactoryForTests(
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
  return { userId: req.member.id, repository };
}

function errorResponse(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message.split(':')[0] : 'TRADE_SIGNAL_ALERTS_FAILED';
  const status = code === 'LOGIN_REQUIRED' ? 401 : code.includes('STORAGE') ? 503 : 400;
  return res.status(status).json({ ok: false, error: code, alerts: [] });
}

router.get('/approval-alerts', async (req: AuthenticatedRequest, res) => {
  try {
    const { userId, repository } = context(req);
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const plans = await repository.listPlans(userId);
    const alerts = listTradeSignalAlerts(plans, new Date(), limit);
    return res.json({
      ok: true,
      alerts,
      count: alerts.length,
      updatedAt: new Date().toISOString(),
      orderSubmitted: false,
      credentialsExposed: false,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

export default router;
