import { Router, type IRouter, type NextFunction, type Response } from 'express';
import {
  requireAuthenticated,
  requireCapability,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  CryptoScannerProviderError,
  CryptoSignalScannerService,
  type CryptoSignalScanRequest,
} from '../services/crypto-signal-scanner.service';
import {
  ScannerRequestGuardError,
  scannerRequestGuard,
  type ScannerRequestGuard,
} from '../services/scanner-request-guard.service';

export type CryptoScannerRunner = {
  scan(request: CryptoSignalScanRequest): ReturnType<typeof CryptoSignalScannerService.scan>;
};

export interface CryptoSignalScanRouteDependencies {
  scanner?: CryptoScannerRunner;
  guard?: ScannerRequestGuard;
}

function requireScannerSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.member && !req.header('authorization')) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  return requireAuthenticated(req, res, next);
}

function number(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : undefined;
}

function requestKey(req: AuthenticatedRequest, market: 'spot' | 'futures'): string {
  const query = Object.entries(req.query)
    .filter(([key]) => key !== '_ts')
    .map(([key, value]) => `${key}=${String(value ?? '')}`)
    .sort()
    .join('&');
  return `${market}:${query}`;
}

function timeframe(value: unknown): CryptoSignalScanRequest['timeframe'] | null {
  const normalized = String(value ?? '15m') === '1H' ? '60m' : String(value ?? '15m');
  return ['5m', '15m', '60m', '4H', '1D'].includes(normalized)
    ? normalized as CryptoSignalScanRequest['timeframe']
    : null;
}

function condition(value: unknown): CryptoSignalScanRequest['condition'] {
  const normalized = String(value ?? 'trend');
  return ['trend', 'volume', 'breakout', 'pullback'].includes(normalized)
    ? normalized as CryptoSignalScanRequest['condition']
    : 'trend';
}

function routeError(res: Response, error: unknown) {
  if (error instanceof ScannerRequestGuardError) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({
      ok: false,
      error: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      cards: [],
      alerts: [],
      failures: [],
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  if (error instanceof CryptoScannerProviderError) {
    return res.status(502).json({
      ok: false,
      error: error.code,
      cards: [],
      alerts: [],
      failures: [{ symbol: '*', reason: 'provider_error', message: error.message }],
      dataState: 'unavailable',
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  return res.status(500).json({
    ok: false,
    error: error instanceof Error ? error.message.split(':')[0] : 'CRYPTO_SCAN_FAILED',
    cards: [],
    alerts: [],
    failures: [],
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export function createCryptoSignalScanRouter(
  dependencies: CryptoSignalScanRouteDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const scanner = dependencies.scanner ?? CryptoSignalScannerService;
  const guard = dependencies.guard ?? scannerRequestGuard;
  router.use(requireScannerSession);

  const handler = (market: 'spot' | 'futures') => async (req: AuthenticatedRequest, res: Response) => {
    const selectedTimeframe = timeframe(req.query.timeframe);
    if (!selectedTimeframe) return res.status(400).json({ error: 'CRYPTO_SCAN_TIMEFRAME_UNSUPPORTED' });
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(new Error('CRYPTO_SCAN_ABORTED'));
    };
    req.once('aborted', abort);
    res.once('close', abort);
    let lease: ReturnType<ScannerRequestGuard['acquire']> | null = null;
    try {
      lease = guard.acquire(req.member!.id, requestKey(req, market));
      const result = await scanner.scan({
        memberId: req.member!.id,
        market,
        timeframe: selectedTimeframe,
        condition: condition(req.query.condition),
        cursor: number(req.query.cursor, 0, 1_000_000) ?? 0,
        batchSize: number(req.query.batchSize, 5, 40) ?? 24,
        minimumScore: number(req.query.minimumScore, 0, 100),
        maximumRiskScore: number(req.query.maximumRiskScore, 0, 100),
        signal: controller.signal,
      });
      if (controller.signal.aborted || res.writableEnded) return;
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      res.setHeader('X-Scanner-Request-Id', result.requestId);
      return res.json(result);
    } catch (error) {
      if (controller.signal.aborted || res.writableEnded) return;
      return routeError(res, error);
    } finally {
      lease?.release();
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  };

  router.get('/spot', requireCapability('canAccessSpot'), handler('spot'));
  router.get('/futures', requireCapability('canAccessFutures'), handler('futures'));
  return router;
}

export default createCryptoSignalScanRouter();
