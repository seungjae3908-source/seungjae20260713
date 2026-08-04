import { Router, type IRouter } from 'express';
import {
  BoundedScannerService,
  ScanProviderUnavailableError,
  ScanRequestAbortedError,
} from '../services/bounded-scanner.service';

const router: IRouter = Router();
type MarketScope = 'ALL' | 'KR' | 'US';

function normalizeMarket(value: unknown): MarketScope {
  const raw = String(value ?? 'ALL').toUpperCase();
  if (raw === 'KR') return 'KR';
  if (raw === 'US') return 'US';
  return 'ALL';
}

function positiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

router.get('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const scope = normalizeMarket(req.query.market);
  const indicators = String(req.query.indicators ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const filters = {
    volumeThreshold: positiveNumber(req.query.volumeThreshold),
    tradingValueThreshold: positiveNumber(req.query.tradingValueThreshold),
    marketCapThreshold: positiveNumber(req.query.marketCapThreshold),
    minimumScore: positiveNumber(req.query.minimumScore),
    maximumRiskScore: positiveNumber(req.query.maximumRiskScore),
    volumeLookbackDays: positiveNumber(req.query.volumeLookbackDays),
    tradingValueLookbackDays: positiveNumber(req.query.tradingValueLookbackDays),
    timeframe: String(req.query.timeframe ?? '1D'),
  };
  if (scope === 'US' && filters.timeframe === '4H') {
    return res.status(400).json({
      ok: false,
      error: 'SCAN_TIMEFRAME_UNSUPPORTED',
      market: scope,
      timeframe: filters.timeframe,
    });
  }

  const controller = new AbortController();
  const abortRequest = () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new ScanRequestAbortedError());
    }
  };
  req.once('aborted', abortRequest);
  res.once('close', abortRequest);

  try {
    const result = await BoundedScannerService.scan(scope, indicators, filters, {
      signal: controller.signal,
    });
    if (controller.signal.aborted || res.writableEnded) return;
    return res.json({
      ok: true,
      provider: 'rule-scan',
      fetchedAt: new Date().toISOString(),
      searchRunId: `scan:${scope}:${result.timeframe}:${Date.now()}`,
      timeframe: result.timeframe,
      market: scope,
      rows: result.cards,
      cards: result.cards,
      results: result.cards,
      count: result.cards.length,
      selected: result.selected,
      supportedIndicators: result.supportedIndicators,
      appliedConditions: {
        market: scope,
        indicators: result.selected,
        defaultApplied: indicators.length === 0,
        volumeThreshold: result.appliedFilters.volumeThreshold,
        tradingValueThreshold: result.appliedFilters.tradingValueThreshold,
        marketCapThreshold: result.appliedFilters.marketCapThreshold,
        minimumScore: result.appliedFilters.minimumScore,
        maximumRiskScore: result.appliedFilters.maximumRiskScore,
        volumeLookbackDays: filters.volumeLookbackDays ?? 20,
        tradingValueLookbackDays: filters.tradingValueLookbackDays ?? 20,
      },
      scanned: result.scanned,
      requestedCount: result.requestedCount,
      completedCount: result.completedCount,
      providerErrorCount: result.providerErrorCount,
      timeoutCount: result.timeoutCount,
      excludedCount: result.excludedCount,
      partial: result.partial,
      timedOut: result.timedOut,
      elapsedMs: result.elapsedMs,
      dataState: result.dataState,
      message: result.message,
      maxConcurrency: result.maxConcurrency,
      deadlineMs: result.deadlineMs,
      itemTimeoutMs: result.itemTimeoutMs,
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (controller.signal.aborted || error instanceof ScanRequestAbortedError || res.writableEnded) return;
    const providerError = error instanceof ScanProviderUnavailableError;
    console.error('bounded market scan error:', providerError ? error.message : error);
    return res.status(502).json({
      ok: false,
      provider: 'rule-scan',
      market: scope,
      rows: [],
      results: [],
      cards: [],
      error: 'SCAN_PROVIDER_ERROR',
      dataState: 'unavailable',
      message: '조건검색 데이터 공급자 오류 — 결과 0건이 아니라 조회 실패입니다.',
    });
  } finally {
    req.removeListener('aborted', abortRequest);
    res.removeListener('close', abortRequest);
  }
});

export default router;
