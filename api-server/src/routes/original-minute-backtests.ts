import { Router, type IRouter, type Response } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import { createOriginalMinuteBacktestServiceV1, OriginalMinuteBacktestServiceErrorV1,
  type OriginalMinuteBacktestServiceV1 } from '../services/original-minute-backtest.service';
import { ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 } from '../../../packages/strategy-hypothesis/src/original-minute-backtest.js';

const PREFIX = '/backtests/original-minute';
const RUNS = PREFIX + '/runs';
const safeError = (res: Response, status: number, code: string) => res.status(status).json({ code, ...ORIGINAL_MINUTE_BACKTEST_SAFETY_V1 });
const noExtras = (req: AuthenticatedRequest) => Object.keys(req.query).length === 0;
const noBody = (req: AuthenticatedRequest) => req.body === undefined || (req.body !== null
  && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length === 0);

export function createOriginalMinuteBacktestsRouterV1(
  service: OriginalMinuteBacktestServiceV1 = createOriginalMinuteBacktestServiceV1(),
): IRouter {
  const router: IRouter = Router();
  // This prefix-specific guard cannot intercept the existing Backtest/Paper
  // endpoints. Parent router still verifies the current session and capability.
  router.use(PREFIX, (req: AuthenticatedRequest, res, next) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Vary', 'Authorization, Cookie');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!req.member) return safeError(res, 401, 'LOGIN_REQUIRED');
    return next();
  }, requireAdmin);
  router.post(RUNS, async (req: AuthenticatedRequest, res) => {
    if (!noExtras(req)) return safeError(res, 400, 'ORIGINAL_MINUTE_REQUEST_QUERY_FORBIDDEN');
    try {
      const job = await service.start(req.member!.id, req.body);
      res.setHeader('Location', '/api' + RUNS + '/' + job.runId);
      return res.status(202).json(job);
    } catch (error) {
      if (error instanceof OriginalMinuteBacktestServiceErrorV1) return safeError(res, error.status, error.code);
      if (error instanceof TypeError && /^ORIGINAL_MINUTE_[A-Z0-9_]{1,130}$/u.test(error.message))
        return safeError(res, 400, error.message);
      return safeError(res, 500, 'ORIGINAL_MINUTE_SERVICE_FAILED');
    }
  });
  router.get(RUNS + '/:runId', (req: AuthenticatedRequest, res) => {
    if (!noExtras(req) || !noBody(req)) return safeError(res, 400, 'ORIGINAL_MINUTE_REQUEST_EXTRAS_FORBIDDEN');
    try {
      const job = service.get(req.member!.id, String(req.params.runId));
      return job ? res.status(200).json(job) : safeError(res, 404, 'ORIGINAL_MINUTE_RUN_NOT_FOUND');
    } catch { return safeError(res, 500, 'ORIGINAL_MINUTE_SERVICE_FAILED'); }
  });
  router.delete(RUNS + '/:runId', (req: AuthenticatedRequest, res) => {
    if (!noExtras(req) || !noBody(req)) return safeError(res, 400, 'ORIGINAL_MINUTE_REQUEST_EXTRAS_FORBIDDEN');
    try {
      const job = service.cancel(req.member!.id, String(req.params.runId));
      return job ? res.status(200).json(job) : safeError(res, 404, 'ORIGINAL_MINUTE_RUN_NOT_FOUND');
    } catch { return safeError(res, 500, 'ORIGINAL_MINUTE_SERVICE_FAILED'); }
  });
  router.all([RUNS, RUNS + '/:runId'], (_req, res) => {
    res.setHeader('Allow', _req.params.runId ? 'GET, DELETE' : 'POST');
    return safeError(res, 405, 'ORIGINAL_MINUTE_METHOD_NOT_ALLOWED');
  });
  return router;
}

export default createOriginalMinuteBacktestsRouterV1();
