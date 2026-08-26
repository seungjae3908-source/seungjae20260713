import { Router, type IRouter, type Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import {
  FuturesMarketDataError,
  getFuturesCandles,
  getFuturesMarketSnapshot,
  getFuturesMarketStatus,
} from '../services/futures-market-data.service';
import { getFuturesContractRules } from '../services/futures-contract-rules.service';
import {
  CryptoFuturesDirectionalScannerService,
  type FuturesDirectionalView,
} from '../services/crypto-futures-directional-scanner.service';
import {
  ScannerRequestGuardError,
  scannerRequestGuard,
} from '../services/scanner-request-guard.service';
import type { ScannerStrategyMode } from '../services/scanner-signal.types';

const router: IRouter = Router();

function sendError(res: Response, error: unknown) {
  if (error instanceof FuturesMarketDataError) {
    return res.status(error.statusCode).json({
      ok: false,
      code: error.code,
      message: error.message,
    });
  }
  return res.status(500).json({
    ok: false,
    code: 'FUTURES_MARKET_DATA_ERROR',
    message: '선물 시장 데이터를 처리하지 못했습니다.',
  });
}

function number(value: unknown, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : undefined;
}

function directionalTimeframe(value: unknown): string | null {
  const normalized = String(value ?? '15m') === '1H' ? '60m' : String(value ?? '15m');
  return ['1m', '3m', '5m', '15m', '60m', '4H', '1D'].includes(normalized) ? normalized : null;
}

function defaultStrategy(timeframe: string): ScannerStrategyMode {
  if (timeframe === '1D') return 'position';
  if (timeframe === '60m' || timeframe === '4H') return 'swing';
  return 'scalping';
}

function directionalStrategy(value: unknown, timeframe: string): ScannerStrategyMode | null {
  const requested = String(value ?? '').trim().toLowerCase();
  const selected = requested === ''
    ? defaultStrategy(timeframe)
    : requested === 'scalping' || requested === 'swing' || requested === 'position'
      ? requested
      : null;
  if (!selected) return null;
  if (selected === 'scalping' && !['1m', '3m', '5m', '15m'].includes(timeframe)) return null;
  if (selected === 'swing' && !['15m', '60m', '4H'].includes(timeframe)) return null;
  if (selected === 'position' && !['4H', '1D'].includes(timeframe)) return null;
  return selected;
}

function directionalView(value: unknown): FuturesDirectionalView | null {
  const normalized = String(value ?? 'both').trim().toLowerCase();
  if (normalized === 'long') return 'LONG';
  if (normalized === 'short') return 'SHORT';
  if (normalized === 'both') return 'BOTH';
  return null;
}

function directionalCondition(value: unknown): 'trend' | 'volume' | 'breakout' | 'pullback' | null {
  const normalized = String(value ?? 'trend').trim().toLowerCase();
  return ['trend', 'volume', 'breakout', 'pullback'].includes(normalized)
    ? normalized as 'trend' | 'volume' | 'breakout' | 'pullback'
    : null;
}

router.use('/crypto/futures', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

router.get('/crypto/futures/status', async (_req, res) => {
  try {
    const [registry, probe] = await Promise.all([
      getFuturesMarketStatus(),
      getFuturesMarketSnapshot('BTCUSDT'),
    ]);
    return res.json({
      ...registry,
      status: probe.status,
      connection: probe.status,
      updatedAt: probe.updatedAt,
      warnings: [...new Set([...registry.warnings, ...probe.warnings])],
      publicDataOnly: true,
      orderCapability: false,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/scanner/directional', async (req: AuthenticatedRequest, res) => {
  const timeframe = directionalTimeframe(req.query.timeframe);
  if (!timeframe) return res.status(400).json({ ok: false, error: 'FUTURES_DIRECTIONAL_TIMEFRAME_UNSUPPORTED' });
  const strategy = directionalStrategy(req.query.strategy, timeframe);
  if (!strategy) return res.status(400).json({ ok: false, error: 'FUTURES_DIRECTIONAL_STRATEGY_TIMEFRAME_MISMATCH' });
  const view = directionalView(req.query.direction ?? req.query.view);
  if (!view) return res.status(400).json({ ok: false, error: 'FUTURES_DIRECTIONAL_VIEW_UNSUPPORTED' });
  const condition = directionalCondition(req.query.condition);
  if (!condition) return res.status(400).json({ ok: false, error: 'FUTURES_DIRECTIONAL_CONDITION_UNSUPPORTED' });
  if (!req.member?.id) return res.status(401).json({ ok: false, error: 'LOGIN_REQUIRED' });

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(new Error('FUTURES_DIRECTIONAL_SCAN_ABORTED'));
  };
  req.once('aborted', abort);
  res.once('close', abort);
  const requestKey = [view, strategy, timeframe, condition, String(req.query.cursor ?? 0), String(req.query.batchSize ?? 24)].join(':');
  let lease: ReturnType<typeof scannerRequestGuard.acquire> | null = null;
  try {
    lease = scannerRequestGuard.acquire(req.member.id, `futures-directional:${requestKey}`);
    const result = await CryptoFuturesDirectionalScannerService.scan({
      memberId: req.member.id,
      view,
      strategyMode: strategy,
      timeframe,
      condition,
      cursor: Math.trunc(number(req.query.cursor, 0, 1_000_000) ?? 0),
      batchSize: Math.trunc(number(req.query.batchSize, 1, 40) ?? 24),
      minimumScore: number(req.query.minimumScore, 0, 100),
      maximumRiskScore: number(req.query.maximumRiskScore, 0, 100),
      limit: Math.trunc(number(req.query.limit, 1, 20) ?? 10),
      signal: controller.signal,
    });
    if (controller.signal.aborted || res.writableEnded) return;
    return res.json(result);
  } catch (error) {
    if (controller.signal.aborted || res.writableEnded) return;
    if (error instanceof ScannerRequestGuardError) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(error.status).json({
        ok: false,
        error: error.code,
        retryAfterSeconds: error.retryAfterSeconds,
        orderSubmitted: false,
        exchangeRequestSent: false,
      });
    }
    return res.status(500).json({ ok: false, error: 'FUTURES_DIRECTIONAL_SCAN_FAILED', message: error instanceof Error ? error.message : 'unknown' });
  } finally {
    lease?.release();
    req.removeListener('aborted', abort);
    res.removeListener('close', abort);
  }
});

router.get('/crypto/futures/:symbol/snapshot', async (req, res) => {
  try {
    const data = await getFuturesMarketSnapshot(req.params.symbol);
    return res.json({ ok: true, data });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/:symbol/contract-rules', async (req, res) => {
  try {
    const data = await getFuturesContractRules(req.params.symbol);
    return res.json({
      ok: true,
      publicDataOnly: true,
      orderCapability: false,
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

router.get('/crypto/futures/:symbol/candles', async (req, res) => {
  try {
    const result = await getFuturesCandles({
      symbol: req.params.symbol,
      timeframe: req.query.timeframe ?? req.query.granularity ?? '15m',
      limit: req.query.limit ?? 200,
    });
    return res.json({
      ok: true,
      symbol: result.symbol,
      timeframe: result.timeframe,
      status: result.status,
      data: result.data,
      warnings: result.warnings,
      updatedAt: result.updatedAt,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export default router;