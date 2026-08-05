import { randomUUID } from 'node:crypto';
import type { Candle } from '../sample/types';
import { MarketDataService } from './market-data.service';
import {
  createBoundedScannerService,
  type ScanExecutionOptions,
} from './bounded-scanner.service';
import { buildContext, type ScanFilters } from './signal.service';
import { applyStockSignalPolicy } from './scanner-signal-policy.service';
import { applyScannerSignalLifecycle } from './scanner-signal-lifecycle.service';
import type { ScannerResponse, ScannerSignalCard } from './scanner-signal.types';
import { ScannerUniverseService } from './scanner-universe.service';

export interface StockSignalScanRequest {
  memberId: string;
  market: 'KR' | 'US';
  indicators: string[];
  filters: ScanFilters;
  cursor: number;
  batchSize: number;
  signal?: AbortSignal;
}

function applyUniverseStaleness(card: ScannerSignalCard, stale: boolean): ScannerSignalCard {
  if (!stale) return card;
  return {
    ...card,
    score: Math.min(card.score, 59),
    confidence: Math.min(card.confidence, 59),
    dataState: 'stale',
    strongSignalEligible: false,
    signalState: card.signalState === 'INVALIDATED' ? 'INVALIDATED' : 'WEAKENED',
    warnings: [...new Set([...card.warnings, '종목 마스터가 마지막 정상 캐시 또는 fallback입니다.'])],
  };
}

function selectedConditions(requested: string[], normalized: string[]): string[] {
  const source = requested.length ? requested : normalized;
  return [...new Set(source.map((item) => item.trim()).filter(Boolean))];
}

export const StockSignalScannerService = {
  async scan(request: StockSignalScanRequest): Promise<ScannerResponse> {
    const startedAt = Date.now();
    const universe = await ScannerUniverseService.batch(
      request.market,
      request.cursor,
      request.batchSize,
      request.signal,
    );
    const candlesByTicker = new Map<string, Candle[]>();
    const entryByTicker = new Map(universe.entries.map((entry) => [entry.ticker, entry]));
    const scanner = createBoundedScannerService({
      catalog: universe.entries,
      getCandles: async (ticker, timeframe) => {
        const candles = await MarketDataService.getCandles(ticker, timeframe);
        candlesByTicker.set(ticker, candles);
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
        return applyUniverseStaleness(applyStockSignalPolicy({
          memberId: request.memberId,
          card,
          universeEntry: entry,
          candles: candlesByTicker.get(card.ticker) ?? [],
          selected,
          timeframe: raw.timeframe,
        }), universe.stale);
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
    const dataState = universe.stale
      ? 'stale' as const
      : partial
        ? 'partial' as const
        : 'complete' as const;
    const completedCount = raw.completedCount;
    const message = universe.stale
      ? `종목 마스터 제공기관이 지연되어 ${universe.source} 목록으로 ${completedCount}/${universe.entries.length}종목을 분석했습니다.`
      : partial
        ? `일부 공급자 지연으로 ${completedCount}/${universe.entries.length}종목의 확인된 결과만 표시합니다.`
        : lifecycle.cards.length === 0
          ? `현재 묶음 ${completedCount}종목에서 선택 조건을 모두 확인한 결과가 없습니다.`
          : `현재 묶음 ${completedCount}종목 분석을 완료했습니다.`;

    return {
      ok: true,
      requestId: randomUUID(),
      assetClass: 'stock',
      market: request.market,
      timeframe: raw.timeframe,
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
