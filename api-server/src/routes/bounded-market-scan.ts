import { Router, type IRouter, type NextFunction, type Response } from 'express';
import {
  requireAuthenticated,
  requireCapability,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  ScannerRequestGuardError,
  scannerRequestGuard,
  type ScannerRequestGuard,
} from '../services/scanner-request-guard.service';
import {
  StockSignalScannerService,
  type StockSignalScanRequest,
} from '../services/stock-signal-scanner.service';
import { ScanProviderUnavailableError, ScanRequestAbortedError } from '../services/bounded-scanner.service';
import {
  scannerStrategyForTimeframe,
  scannerStrategyTimeframeAllowed,
  type ScannerStrategyMode,
} from '../services/scanner-quant-strategy.service';

export type StockScannerRunner = {
  scan(request: StockSignalScanRequest): ReturnType<typeof StockSignalScannerService.scan>;
};

export interface BoundedMarketScanRouteDependencies {
  scanner?: StockScannerRunner;
  guard?: ScannerRequestGuard;
}

function requireScannerSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.member && !req.header('authorization')) {
    return res.status(401).json({ error: 'LOGIN_REQUIRED' });
  }
  return requireAuthenticated(req, res, next);
}

function finite(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : undefined;
}

function marketValue(value: unknown): 'KR' | 'US' | null {
  const normalized = String(value ?? 'KR').toUpperCase();
  return normalized === 'KR' || normalized === 'US' ? normalized : null;
}

function strategyValue(value: unknown, timeframe: string): ScannerStrategyMode | null {
  const raw = String(value ?? '').trim().toLowerCase();
  const strategy = raw === ''
    ? scannerStrategyForTimeframe(timeframe)
    : raw === 'scalping' || raw === 'swing'
      ? raw
      : null;
  if (!strategy || !scannerStrategyTimeframeAllowed(strategy, timeframe)) return null;
  return strategy;
}

function requestKey(req: AuthenticatedRequest): string {
  const entries = Object.entries(req.query)
    .filter(([key]) => key !== '_ts')
    .map(([key, value]) => [key, Array.isArray(value) ? value.map(String).sort().join(',') : String(value ?? '')] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.map(([key, value]) => `${key}=${value}`).join('&');
}

function responseError(res: Response, error: unknown) {
  if (error instanceof ScannerRequestGuardError) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
    return res.status(error.status).json({
      ok: false,
      error: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      cards: [],
      alerts: [],
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  if (error instanceof ScanProviderUnavailableError) {
    return res.status(502).json({
      ok: false,
      error: 'SCAN_PROVIDER_ERROR',
      dataState: 'unavailable',
      cards: [],
      alerts: [],
      message: '조건검색 데이터 공급자 오류이며 정상적인 결과 0건이 아닙니다.',
      orderSubmitted: false,
      exchangeRequestSent: false,
    });
  }
  const code = error instanceof Error ? error.message.split(':')[0] : 'SCAN_FAILED';
  const status = code === 'SCAN_TIMEFRAME_UNSUPPORTED' ? 400 : 500;
  return res.status(status).json({
    ok: false,
    error: code,
    cards: [],
    alerts: [],
    orderSubmitted: false,
    exchangeRequestSent: false,
  });
}

export function createBoundedMarketScanRouter(
  dependencies: BoundedMarketScanRouteDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const scanner = dependencies.scanner ?? StockSignalScannerService;
  const guard = dependencies.guard ?? scannerRequestGuard;

  router.use(requireScannerSession);
  router.use(requireCapability('canAccessRiskPreview'));

  router.get('/', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const market = marketValue(req.query.market);
    if (!market) return res.status(400).json({ error: 'SCAN_MARKET_UNSUPPORTED' });
    const timeframe = String(req.query.timeframe ?? '1D') === '1H' ? '60m' : String(req.query.timeframe ?? '1D');
    const strategyMode = strategyValue(req.query.strategy, timeframe);
    if (!strategyMode) {
      return res.status(400).json({
        ok: false,
        error: 'SCAN_STRATEGY_TIMEFRAME_MISMATCH',
        timeframe,
        strategy: String(req.query.strategy ?? ''),
      });
    }
    const indicators = String(req.query.indicators ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .slice(0, 40);
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) controller.abort(new ScanRequestAbortedError());
    };
    req.once('aborted', abort);
    res.once('close', abort);
    let lease: ReturnType<ScannerRequestGuard['acquire']> | null = null;

    try {
      lease = guard.acquire(req.member!.id, requestKey(req));
      const result = await scanner.scan({
        memberId: req.member!.id,
        market,
        indicators,
        strategyMode,
        filters: {
          volumeThreshold: finite(req.query.volumeThreshold, 1, 1_000),
          tradingValueThreshold: finite(req.query.tradingValueThreshold, 1, 1_000),
          marketCapThreshold: finite(req.query.marketCapThreshold, 1, Number.MAX_SAFE_INTEGER),
          minimumScore: finite(req.query.minimumScore, 0, 100),
          maximumRiskScore: finite(req.query.maximumRiskScore, 0, 100),
          volumeLookbackDays: finite(req.query.volumeLookbackDays, 1, 60),
          tradingValueLookbackDays: finite(req.query.tradingValueLookbackDays, 1, 60),
          timeframe,
        },
        cursor: finite(req.query.cursor, 0, 1_000_000) ?? 0,
        batchSize: finite(req.query.batchSize, 10, 200) ?? 120,
        signal: controller.signal,
      });
      if (controller.signal.aborted || res.writableEnded) return;
      res.setHeader('X-Scanner-Request-Id', result.requestId);
      return res.json({
        ...result,
        strategy: strategyMode,
        partial: result.execution.partial,
        elapsedMs: result.execution.elapsedMs,
      });
    } catch (error) {
      if (controller.signal.aborted || error instanceof ScanRequestAbortedError || res.writableEnded) return;
      return responseError(res, error);
    } finally {
      lease?.release();
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });

  return router;
}

export default createBoundedMarketScanRouter();
