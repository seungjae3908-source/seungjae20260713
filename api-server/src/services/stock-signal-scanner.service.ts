import { randomUUID } from 'node:crypto';
import type { Candle, Timeframe } from '../sample/types';
import { MarketDataService } from './market-data.service';
import {
  createBoundedScannerService,
  type ScanExecutionOptions,
} from './bounded-scanner.service';
import { buildContext, type ScanFilters } from './signal.service';
import { rankScannerCandidates } from './scanner-candidate-ranking.service';
import { applyStockSignalPolicy } from './scanner-signal-policy.service';
import { applyScannerSignalLifecycle } from './scanner-signal-lifecycle.service';
import { applyScannerQuantHardening } from './scanner-quant-hardening.service';
import { applyScannerMarketProfile } from './scanner-market-profile-overlay.service';
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

type UsTradingSession = {
  name: 'premarket' | 'regular' | 'after-hours';
  startMinute: number;
  endMinute: number;
};

const US_TRADING_SESSIONS: readonly UsTradingSession[] = [
  { name: 'premarket', startMinute: 4 * 60, endMinute: 9 * 60 + 30 },
  { name: 'regular', startMinute: 9 * 60 + 30, endMinute: 16 * 60 },
  { name: 'after-hours', startMinute: 16 * 60, endMinute: 20 * 60 },
];

function applyUniverseStaleness(card: ScannerSignalCard, stale: boolean): ScannerSignalCard {
  if (!stale) return card;
  return {
    ...card,
    score: Math.min(card.score, 49),
    confidence: Math.min(card.confidence, 49),
    dataState: 'stale',
    strongSignalEligible: false,
    signalState: 'INVALIDATED',
    pricePlan: { entryZone: null, invalidation: null, stopLoss: null, targets: [], riskReward: null },
    dataQuality: card.dataQuality ? {
      ...card.dataQuality,
      state: 'DATA_UNTRUSTED',
      score: Math.min(card.dataQuality.score, 49),
      strongSignalAllowed: false,
      issues: [...card.dataQuality.issues, {
        code: 'PROVIDER_DISAGREEMENT', severity: 'blocking', message: '종목 마스터가 마지막 정상 캐시 또는 fallback입니다.',
      }],
    } : undefined,
    warnings: [...new Set([...card.warnings, '종목 마스터가 마지막 정상 캐시 또는 fallback입니다.', 'DATA_UNTRUSTED: 승인·실행 호환 가격정보를 폐기했습니다.'])],
  };
}

function selectedConditions(requested: string[]): string[] {
  return [...new Set(requested.map((item) => item.trim()).filter(Boolean))];
}

function candleTimestamp(value: Candle['time']): number | null {
  if (typeof value === 'number') {
    const normalized = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(normalized) ? normalized : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function usWallClock(value: Candle['time']): { date: string; minuteOfDay: number } | null {
  const at = candleTimestamp(value);
  if (at == null) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = values.get('year');
  const month = values.get('month');
  const day = values.get('day');
  const hour = Number(values.get('hour'));
  const minute = Number(values.get('minute'));
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { date: `${year}-${month}-${day}`, minuteOfDay: hour * 60 + minute };
}

function usSession(minuteOfDay: number): UsTradingSession | null {
  return US_TRADING_SESSIONS.find((session) => minuteOfDay >= session.startMinute && minuteOfDay < session.endMinute) ?? null;
}

export function aggregateUsSessionCandles(rows: Candle[], lowerIntervalMinutes: number, targetMinutes: number): Candle[] {
  if (lowerIntervalMinutes <= 0 || targetMinutes <= lowerIntervalMinutes || targetMinutes % lowerIntervalMinutes !== 0) return [];
  const expectedBars = targetMinutes / lowerIntervalMinutes;
  const buckets = new Map<string, Array<{ candle: Candle; minuteOfDay: number; at: number }>>();
  for (const candle of rows) {
    const at = candleTimestamp(candle.time);
    const wall = usWallClock(candle.time);
    if (at == null || !wall) continue;
    const session = usSession(wall.minuteOfDay);
    if (!session) continue;
    const offset = wall.minuteOfDay - session.startMinute;
    const bucketStartMinute = session.startMinute + Math.floor(offset / targetMinutes) * targetMinutes;
    if (bucketStartMinute + targetMinutes > session.endMinute) continue;
    const key = `${wall.date}:${session.name}:${bucketStartMinute}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push({ candle, minuteOfDay: wall.minuteOfDay, at });
    buckets.set(key, bucket);
  }
  const result: Candle[] = [];
  for (const [key, bucket] of buckets) {
    if (bucket.length !== expectedBars) continue;
    const bucketStartMinute = Number(key.slice(key.lastIndexOf(':') + 1));
    const ordered = [...bucket].sort((left, right) => left.at - right.at);
    const complete = ordered.every((row, index) => row.minuteOfDay === bucketStartMinute + index * lowerIntervalMinutes
      && (index === 0 || row.at - ordered[index - 1].at === lowerIntervalMinutes * 60_000));
    if (!complete) continue;
    result.push({
      time: ordered[0].candle.time,
      open: ordered[0].candle.open,
      high: Math.max(...ordered.map((row) => row.candle.high)),
      low: Math.min(...ordered.map((row) => row.candle.low)),
      close: ordered.at(-1)!.candle.close,
      volume: ordered.reduce((sum, row) => sum + row.candle.volume, 0),
    });
  }
  return result.sort((left, right) => (candleTimestamp(left.time) ?? 0) - (candleTimestamp(right.time) ?? 0));
}

function abortError(): Error {
  const error = new Error('Scanner candle request aborted');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function loadStockCandles(market: 'KR' | 'US', ticker: string, timeframe: string, signal?: AbortSignal): Promise<Candle[]> {
  throwIfAborted(signal);
  if (market === 'US' && timeframe === '3m') {
    const oneMinute = await MarketDataService.getCandles(ticker, '1m');
    throwIfAborted(signal);
    return aggregateUsSessionCandles(oneMinute, 1, 3);
  }
  if (market === 'US' && timeframe === '4H') {
    const hourly = await MarketDataService.getCandles(ticker, '60m');
    throwIfAborted(signal);
    return aggregateUsSessionCandles(hourly, 60, 240);
  }
  const candles = await MarketDataService.getCandles(ticker, timeframe as Timeframe);
  throwIfAborted(signal);
  return candles;
}

function boundedCompatibilityTimeframe(timeframe: string): Timeframe {
  return (timeframe === '1m' || timeframe === '3m' ? '5m' : timeframe) as Timeframe;
}

export const StockSignalScannerService = {
  async scan(request: StockSignalScanRequest): Promise<ScannerResponse> {
    const startedAt = Date.now();
    const primaryTimeframe = String(request.filters.timeframe ?? '1D') === '1H' ? '60m' : String(request.filters.timeframe ?? '1D');
    const strategyMode = request.strategyMode ?? scannerStrategyForTimeframe(primaryTimeframe);
    const contextTimeframe = scannerContextTimeframe(strategyMode);
    const universe = await ScannerUniverseService.batch(request.market, request.cursor, request.batchSize, request.signal);
    const candlesByTicker = new Map<string, Candle[]>();
    const contextByTicker = new Map<string, Candle[]>();
    const entryByTicker = new Map(universe.entries.map((entry) => [entry.ticker, entry]));
    const scanner = createBoundedScannerService({
      catalog: universe.entries,
      getCandles: async (ticker) => {
        throwIfAborted(request.signal);
        const [candles, context] = await Promise.all([
          loadStockCandles(request.market, ticker, primaryTimeframe, request.signal),
          primaryTimeframe === contextTimeframe ? Promise.resolve<Candle[] | null>(null) : loadStockCandles(request.market, ticker, contextTimeframe, request.signal).catch((error: unknown) => {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            return [];
          }),
        ]);
        throwIfAborted(request.signal);
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
      deadlineMs: 8_500,
      itemTimeoutMs: 4_000,
      concurrency: 6,
      limit: universe.entries.length || 1,
    };
    const raw = await scanner.scan(request.market, request.indicators, {
      ...request.filters,
      timeframe: boundedCompatibilityTimeframe(primaryTimeframe),
      minimumScore: undefined,
      maximumRiskScore: undefined,
    }, execution);
    const selected = selectedConditions(request.indicators);
    const broadCandidates = raw.cards.map((card) => {
      const entry = entryByTicker.get(card.ticker);
      if (!entry) return null;
      const candles = candlesByTicker.get(card.ticker) ?? [];
      const legacyCandidate = applyStockSignalPolicy({ memberId: request.memberId, card, universeEntry: entry, candles, selected, timeframe: primaryTimeframe });
      const quantCandidate = applyScannerQuantHardening({
        card: legacyCandidate,
        timeframe: primaryTimeframe,
        candles,
        contextCandles: contextByTicker.get(card.ticker) ?? [],
        strategyMode,
        allowShort: false,
        sessionAware: true,
      });
      const marketCandidate = applyScannerMarketProfile({
        card: quantCandidate,
        profile: request.market === 'KR' ? 'KR_STOCK' : 'US_STOCK',
        candles,
        strategyMode,
      });
      return applyUniverseStaleness(marketCandidate, universe.stale);
    }).filter((card): card is ScannerSignalCard => card != null)
      .filter((card) => request.filters.maximumRiskScore == null || (card.riskScore != null && card.riskScore <= request.filters.maximumRiskScore));

    const ranking = rankScannerCandidates({
      cards: broadCandidates,
      market: request.market,
      strategy: strategyMode,
      softMinimumScore: request.filters.minimumScore,
      limit: 10,
    });
    const rankedCards = ranking.cards.map((card) => card.signalGrade === 'B'
      ? { ...card, strongSignalEligible: false, signalState: 'CANDIDATE' as const }
      : card);
    const lifecycle = applyScannerSignalLifecycle(request.memberId, rankedCards);
    const partial = raw.partial || universe.partial;
    const timedOut = raw.timedOut;
    const hasUntrusted = broadCandidates.some((card) => card.dataQuality?.state === 'DATA_UNTRUSTED');
    const dataState = universe.stale ? 'stale' as const : hasUntrusted ? 'untrusted' as const : partial ? 'partial' as const : 'complete' as const;
    const completedCount = raw.completedCount;
    const actionableCount = ranking.diagnostics.sGradeCount + ranking.diagnostics.aGradeCount;
    const message = universe.stale
      ? `종목 마스터 제공기관이 지연되어 ${universe.source} 목록으로 ${completedCount}/${universe.entries.length}종목을 분석했습니다.`
      : partial
        ? `일부 공급자 지연으로 ${completedCount}/${universe.entries.length}종목 중 확인 가능한 후보만 표시합니다.`
        : raw.dataSuccessCount === 0 && raw.insufficientDataCount > 0
          ? `현재 묶음에서 공급자 응답은 받았지만 ${raw.insufficientDataCount}종목의 분석 데이터가 부족합니다.`
          : lifecycle.cards.length === 0
            ? `현재 묶음 ${completedCount}종목에서 Hard Risk Filter를 통과한 후보가 없습니다.`
            : actionableCount === 0
              ? `현재 진입 가능한 강한 신호 없음 · 관찰 후보 ${ranking.diagnostics.bGradeCount}개`
              : `S/A 진입 검토 ${actionableCount}개 · B 관찰 ${ranking.diagnostics.bGradeCount}개`;

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
        providerAcceptedCount: raw.providerAcceptedCount,
        dataSuccessCount: raw.dataSuccessCount,
        insufficientDataCount: raw.insufficientDataCount,
        filteredByStrategyCount: raw.filteredByStrategyCount,
        staleCount: raw.staleCount,
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
        hardFilterPassCount: ranking.diagnostics.hardFilterPassCount,
        hardFilterRejectedCount: ranking.diagnostics.hardFilterRejectedCount,
        softCandidateCount: ranking.diagnostics.softCandidateCount,
        finalDisplayedCount: ranking.diagnostics.finalDisplayedCount,
        sGradeCount: ranking.diagnostics.sGradeCount,
        aGradeCount: ranking.diagnostics.aGradeCount,
        bGradeCount: ranking.diagnostics.bGradeCount,
        backtestMissingCount: ranking.diagnostics.backtestMissingCount,
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