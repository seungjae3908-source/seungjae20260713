import { randomUUID } from 'node:crypto';
import type { Candle, Timeframe } from '../sample/types';
import { MarketDataService } from './market-data.service';
import {
  createBoundedScannerService,
  type ScanExecutionOptions,
} from './bounded-scanner.service';
import { buildContext, type ScanFilters } from './signal.service';
import { applyStockSignalPolicy } from './scanner-signal-policy.service';
import { applyScannerSignalLifecycle } from './scanner-signal-lifecycle.service';
import { applyScannerQuantHardening } from './scanner-quant-hardening.service';
import {
  scannerContextTimeframe,
  scannerStrategyForTimeframe,
  type ScannerStrategyMode,
} from './scanner-quant-strategy.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { ScannerUniverseService } from './scanner-universe.service';

export interface StockSignalScanRequest {
  memberId: string;
  market: 'KR' | 'US';
  indicators: string[];
  filters: ScanFilters;
  cursor: number;
  batchSize: number;
  strategyMode?: ScannerStrategyMode;
  signal?: AbortSignal;
}

function applyUniverseStaleness(card: ScannerSignalCard, stale: boolean): ScannerSignalCard {
  if (!stale) return card;
  return {
    ...card,
    score: Math.min(card.score, 49),
    confidence: Math.min(card.confidence, 49),
    dataState: 'stale',
    strongSignalEligible: false,
    signalState: 'INVALIDATED',
    dataQuality: card.dataQuality
      ? {
        ...card.dataQuality,
        state: 'DATA_UNTRUSTED',
        score: Math.min(card.dataQuality.score, 49),
        strongSignalAllowed: false,
        issues: [
          ...card.dataQuality.issues,
          {
            code: 'PROVIDER_DISAGREEMENT',
            severity: 'blocking',
            message: '종목 마스터가 마지막 정상 캐시 또는 fallback입니다.',
          },
        ],
      }
      : undefined,
    warnings: [...new Set([...card.warnings, '종목 마스터가 마지막 정상 캐시 또는 fallback입니다.'])],
  };
}

function selectedConditions(requested: string[], normalized: string[]): string[] {
  const source = requested.length ? requested : normalized;
  return [...new Set(source.map((item) => item.trim()).filter(Boolean))];
}

function candleTimestamp(value: Candle['time']): number | null {
  if (typeof value === 'number') {
    const normalized = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(normalized) ? normalized : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function marketSessionDate(value: Candle['time'], market: 'KR' | 'US'): string {
  const at = candleTimestamp(value);
  if (at == null) return String(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: market === 'US' ? 'America/New_York' : 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

function aggregateSessionCandles(
  rows: Candle[],
  size: number,
  market: 'KR' | 'US',
): Candle[] {
  if (size <= 1) return rows;
  const sessions = new Map<string, Candle[]>();
  for (const row of rows) {
    const key = marketSessionDate(row.time, market);
    const current = sessions.get(key) ?? [];
    current.push(row);
    sessions.set(key, current);
  }
  const result: Candle[] = [];
  for (const sessionRows of sessions.values()) {
    const ordered = [...sessionRows].sort((left, right) => (
      (candleTimestamp(left.time) ?? 0) - (candleTimestamp(right.time) ?? 0)
    ));
    for (let index = 0; index < ordered.length; index += size) {
      const chunk = ordered.slice(index, index + size);
      if (!chunk.length) continue;
      result.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((row) => row.high)),
        low: Math.min(...chunk.map((row) => row.low)),
        close: chunk.at(-1)!.close,
        volume: chunk.reduce((sum, row) => sum + row.volume, 0),
      });
    }
  }
  return result.sort((left, right) => (
    (candleTimestamp(left.time) ?? 0) - (candleTimestamp(right.time) ?? 0)
  ));
}

async function loadStockCandles(
  market: 'KR' | 'US',
  ticker: string,
  timeframe: string,
): Promise<Candle[]> {
  if (market === 'US' && timeframe === '3m') {
    const oneMinute = await MarketDataService.getCandles(ticker, '1m');
    return aggregateSessionCandles(oneMinute, 3, market);
  }
  if (market === 'US' && timeframe === '4H') {
    const hourly = await MarketDataService.getCandles(ticker, '60m');
    return aggregateSessionCandles(hourly, 4, market);
  }
  return MarketDataService.getCandles(ticker, timeframe as Timeframe);
}

function boundedCompatibilityTimeframe(timeframe: string): Timeframe {
  // PR #82 bounded scanner validates its historical timeframe list. For 1m/3m
  // we preserve that engine but feed it the requested real candles, then the
  // final policy/quant layers use the requested timeframe contract.
  return (timeframe === '1m' || timeframe === '3m' ? '5m' : timeframe) as Timeframe;
}

export const StockSignalScannerService = {
  async scan(request: StockSignalScanRequest): Promise<ScannerResponse> {
    const startedAt = Date.now();
    const primaryTimeframe = String(request.filters.timeframe ?? '1D') === '1H'
      ? '60m'
      : String(request.filters.timeframe ?? '1D');
    const strategyMode = request.strategyMode ?? scannerStrategyForTimeframe(primaryTimeframe);
    const contextTimeframe = scannerContextTimeframe(strategyMode);
    const universe = await ScannerUniverseService.batch(
      request.market,
      request.cursor,
      request.batchSize,
      request.signal,
    );
    const candlesByTicker = new Map<string, Candle[]>();
    const contextByTicker = new Map<string, Candle[]>();
    const entryByTicker = new Map(universe.entries.map((entry) => [entry.ticker, entry]));
    const scanner = createBoundedScannerService({
      catalog: universe.entries,
      getCandles: async (ticker) => {
        const [candles, context] = await Promise.all([
          loadStockCandles(request.market, ticker, primaryTimeframe),
          primaryTimeframe === contextTimeframe
            ? Promise.resolve<Candle[] | null>(null)
            : loadStockCandles(request.market, ticker, contextTimeframe).catch(() => []),
        ]);
        candlesByTicker.set(ticker, candles);
        contextByTicker.set(ticker, context ?? candles);
        return candles;
      },
      getQuote: (ticker) => MarketDataService.getQuote(ticker),
      getContext: (entry) => buildContext(entry),
      now: Date.now,
    });
    const execution: ScanExecutionOptions = {
      signal: request.signal,
      deadlineMs: 12_000,
      itemTimeoutMs: 4_000,
      concurrency: 6,
      limit: universe.entries.length || 1,
    };
    const raw = await scanner.scan(
      request.market,
      request.indicators,
      {
        ...request.filters,
        timeframe: boundedCompatibilityTimeframe(primaryTimeframe),
        minimumScore: undefined,
        maximumRiskScore: undefined,
      },
      execution,
    );
    const selected = selectedConditions(request.indicators, raw.selected);
    const enriched = raw.cards
      .map((card) => {
        const entry = entryByTicker.get(card.ticker);
        if (!entry) return null;
        const candles = candlesByTicker.get(card.ticker) ?? [];
        const legacyCandidate = applyStockSignalPolicy({
          memberId: request.memberId,
          card,
          universeEntry: entry,
          candles,
          selected,
          timeframe: primaryTimeframe,
        });
        const quantCandidate = applyScannerQuantHardening({
          card: legacyCandidate,
          timeframe: primaryTimeframe,
          candles,
          contextCandles: contextByTicker.get(card.ticker) ?? [],
          strategyMode,
          allowShort: false,
          sessionAware: true,
        });
        return applyUniverseStaleness(quantCandidate, universe.stale);
      })
      .filter((card): card is ScannerSignalCard => card != null)
      .filter((card) => selected.length === 0 || selected.every((label) => card.matched.includes(label)))
      .filter((card) => request.filters.minimumScore == null || card.score >= request.filters.minimumScore)
      .filter((card) => request.filters.maximumRiskScore == null
        || (card.riskScore != null && card.riskScore <= request.filters.maximumRiskScore))
      .sort((left, right) => right.score - left.score
        || right.confidence - left.confidence
        || right.dataCompleteness - left.dataCompleteness
        || (right.liquidity ?? -1) - (left.liquidity ?? -1)
        || (left.riskScore ?? 101) - (right.riskScore ?? 101)
        || left.symbol.localeCompare(right.symbol))
      .slice(0, 100);
    const lifecycle = applyScannerSignalLifecycle(request.memberId, enriched);
    const partial = raw.partial || universe.partial;
    const timedOut = raw.timedOut;
    const hasUntrusted = lifecycle.cards.some((card) => card.dataQuality?.state === 'DATA_UNTRUSTED');
    const dataState = universe.stale
      ? 'stale' as const
      : hasUntrusted
        ? 'untrusted' as const
        : partial
          ? 'partial' as const
          : 'complete' as const;
    const completedCount = raw.completedCount;
    const message = universe.stale
      ? `종목 마스터 제공기관이 지연되어 ${universe.source} 목록으로 ${completedCount}/${universe.entries.length}종목을 분석했습니다.`
      : hasUntrusted
        ? 'Data Quality Gate가 신뢰할 수 없는 종목을 강한 신호에서 제외했습니다.'
        : partial
          ? `일부 공급자 지연으로 ${completedCount}/${universe.entries.length}종목의 확인된 결과만 표시합니다.`
          : lifecycle.cards.length === 0
            ? `현재 묶음 ${completedCount}종목에서 선택 조건을 모두 확인한 결과가 없습니다.`
            : `현재 묶음 ${completedCount}종목 ${strategyMode === 'scalping' ? '단타' : '스윙'} 분석을 완료했습니다.`;

    return {
      ok: true,
      requestId: randomUUID(),
      assetClass: 'stock',
      market: request.market,
      timeframe: primaryTimeframe,
      cards: lifecycle.cards,
      alerts: lifecycle.alerts,
      failures: [],
      execution: {
        requestedCount: universe.entries.length,
        startedCount: raw.scanned,
        completedCount,
        excludedCount: Math.max(0, completedCount - lifecycle.cards.length),
        providerErrorCount: raw.providerErrorCount + universe.providerErrorCount,
        timeoutCount: raw.timeoutCount,
        partial,
        timedOut,
        cancelled: request.signal?.aborted === true,
        duplicate: false,
        elapsedMs: Math.max(raw.elapsedMs, Date.now() - startedAt),
        deadlineMs: raw.deadlineMs,
        itemTimeoutMs: raw.itemTimeoutMs,
        maxConcurrency: raw.maxConcurrency,
      },
      universe: {
        totalCount: universe.totalCount,
        cursor: universe.cursor,
        nextCursor: universe.nextCursor,
        source: universe.source,
        partial: universe.partial,
        stale: universe.stale,
        listingStatusCoverage: 'listed-or-unknown',
      },
      dataState,
      message,
      generatedAt: new Date().toISOString(),
      orderSubmitted: false,
      exchangeRequestSent: false,
    };
  },
};
