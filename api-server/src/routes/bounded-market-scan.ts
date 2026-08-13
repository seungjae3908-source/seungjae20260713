import { randomUUID } from 'node:crypto';
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
import {
  SCAN_EXECUTION_LIMITS,
  ScanProviderUnavailableError,
  ScanRequestAbortedError,
} from '../services/bounded-scanner.service';
import {
  scannerStrategyForTimeframe,
  scannerStrategyTimeframeAllowed,
  type ScannerStrategyMode,
} from '../services/scanner-quant-strategy.service';
import {
  canReadScannerGrade,
  filterScannerResponseForTier,
  parseScannerGradeQuery,
} from '../services/scanner-access-control.service';
import { withScannerCanonicalActions } from '../services/scanner-market-action.service';
import { deliverScannerTelegramAlerts } from '../services/scanner-telegram-delivery.service';
import { withScannerOutcome } from '../services/scanner-signal.types';

export const STOCK_SCANNER_ROUTE_DEADLINE_MS = 10_000;

export type StockScannerRunner = {
  scan(request: StockSignalScanRequest): ReturnType<typeof StockSignalScannerService.scan>;
};

export interface BoundedMarketScanRouteDependencies {
  scanner?: StockScannerRunner;
  guard?: ScannerRequestGuard;
  deadlineMs?: number;
}

class ScanRouteDeadlineError extends Error {
  constructor() {
    super('SCAN_ROUTE_DEADLINE');
    this.name = 'ScanRouteDeadlineError';
  }
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
    : raw === 'scalping' || raw === 'swing' || raw === 'position'
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
      outcome: 'PROVIDER_FAILURE',
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

function routeDeadlineResponse(input: {
  market: 'KR' | 'US';
  timeframe: string;
  cursor: number;
  deadlineMs: number;
}) {
  return {
    ok: true as const,
    requestId: randomUUID(),
    assetClass: 'stock' as const,
    market: input.market,
    timeframe: input.timeframe,
    cards: [],
    alerts: [],
    failures: [{
      symbol: '*',
      reason: 'timeout' as const,
      message: 'Scanner response deadline reached before a verified result was available.',
    }],
    execution: {
      requestedCount: 0,
      startedCount: 0,
      completedCount: 0,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 1,
      partial: true,
      timedOut: true,
      cancelled: false,
      duplicate: false,
      elapsedMs: input.deadlineMs,
      deadlineMs: input.deadlineMs,
      itemTimeoutMs: SCAN_EXECUTION_LIMITS.itemTimeoutMs,
      maxConcurrency: SCAN_EXECUTION_LIMITS.concurrency,
    },
    universe: {
      totalCount: 0,
      cursor: input.cursor,
      nextCursor: null,
      source: 'unavailable',
      partial: true,
      stale: true,
      listingStatusCoverage: 'listed-or-unknown' as const,
    },
    dataState: 'unavailable' as const,
    message: '스캐너 응답 한도에 도달해 검증되지 않은 결과는 표시하지 않습니다. 다시 시도해 주세요.',
    generatedAt: new Date().toISOString(),
    orderSubmitted: false as const,
    exchangeRequestSent: false as const,
  };
}

export function createBoundedMarketScanRouter(
  dependencies: BoundedMarketScanRouteDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const scanner = dependencies.scanner ?? StockSignalScannerService;
  const guard = dependencies.guard ?? scannerRequestGuard;
  const routeDeadlineMs = dependencies.deadlineMs ?? STOCK_SCANNER_ROUTE_DEADLINE_MS;
  if (!Number.isFinite(routeDeadlineMs) || routeDeadlineMs <= 0) {
    throw new Error(`invalid stock scanner route deadline: ${routeDeadlineMs}`);
  }

  router.use(requireScannerSession);
  router.use(requireCapability('canAccessBasicInfo'));

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
    const requestedGrade = parseScannerGradeQuery(req.query.grade);
    if (requestedGrade === null) {
      return res.status(400).json({ ok: false, error: 'SCANNER_GRADE_UNSUPPORTED' });
    }
    const membershipLevel = req.membershipLevel ?? 'pending';
    if (requestedGrade && !canReadScannerGrade(membershipLevel, requestedGrade)) {
      return res.status(403).json({ ok: false, error: 'SCANNER_GRADE_FORBIDDEN' });
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
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let routeDeadlineExceeded = false;
    const cursor = finite(req.query.cursor, 0, 1_000_000) ?? 0;

    try {
      lease = guard.acquire(req.member!.id, requestKey(req));
      const scanPromise = scanner.scan({
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
        cursor,
        batchSize: finite(req.query.batchSize, 10, 200) ?? 120,
        signal: controller.signal,
      });
      const routeDeadline = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          routeDeadlineExceeded = true;
          abort();
          reject(new ScanRouteDeadlineError());
        }, routeDeadlineMs);
      });
      const result = await Promise.race([scanPromise, routeDeadline]);
      if (controller.signal.aborted || res.writableEnded) return;
      const canonicalResult = withScannerCanonicalActions(result);
      const visibleResult = withScannerOutcome(filterScannerResponseForTier(canonicalResult, membershipLevel, requestedGrade ?? undefined));
      void deliverScannerTelegramAlerts(visibleResult.alerts);
      res.setHeader('X-Scanner-Request-Id', result.requestId);
      return res.json({
        ...visibleResult,
        strategy: strategyMode,
        partial: result.execution.partial,
        elapsedMs: result.execution.elapsedMs,
      });
    } catch (error) {
      if (routeDeadlineExceeded && error instanceof ScanRouteDeadlineError && !res.writableEnded) {
        const fallback = withScannerOutcome(routeDeadlineResponse({ market, timeframe, cursor, deadlineMs: routeDeadlineMs }));
        res.setHeader('X-Scanner-Request-Id', fallback.requestId);
        return res.json({ ...fallback, strategy: strategyMode, partial: true, elapsedMs: routeDeadlineMs });
      }
      if (controller.signal.aborted || error instanceof ScanRequestAbortedError || res.writableEnded) return;
      return responseError(res, error);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      lease?.release();
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });

  return router;
}

export default createBoundedMarketScanRouter();

