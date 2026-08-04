import { CATALOG, type CatalogEntry } from '../data/catalog';
import { classifyAssetType } from '../data/asset-type';
import { runBoundedWorkPool } from '../lib/bounded-work-pool';
import { computeIndicators } from '../sample/indicators';
import type { Timeframe } from '../sample/types';
import {
  computeScanConditions,
  computeSignalReport,
  type ScanConditions,
  type SignalContext,
} from '../sample/accumulation';
import { MarketDataService } from './market-data.service';
import {
  buildContext,
  computeLiveAiScore,
  type ScanCard,
  type ScanFilters,
} from './signal.service';

export const SCAN_EXECUTION_LIMITS = Object.freeze({
  deadlineMs: 12_000,
  itemTimeoutMs: 4_000,
  concurrency: 6,
  marketContextTimeoutMs: 800,
});

const SCAN_CARD_LIMIT = 100;
const SCAN_POOL_LIMIT = 200;
const SCAN_TIMEFRAMES = ['5m', '15m', '60m', '4H', '1D'] as const satisfies readonly Timeframe[];

export type ScannerTimeframe = (typeof SCAN_TIMEFRAMES)[number];

function isScannerTimeframe(value: string): value is ScannerTimeframe {
  return SCAN_TIMEFRAMES.some((timeframe) => timeframe === value);
}

type ScanKey =
  | 'accumulation'
  | 'box_consolidation'
  | 'obv_rising'
  | 'volume_accum'
  | 'bollinger_squeeze'
  | 'rsi_recovery'
  | 'macd_turn'
  | 'inst_accumulation'
  | 'foreign_accumulation'
  | 'volume_spike'
  | 'trading_value_up'
  | 'ma_breakout'
  | 'ma5_breakout'
  | 'ma20_recovery'
  | 'ma60_breakout'
  | 'ma120_breakout'
  | 'rsi_overheat'
  | 'new_high_near'
  | 'new_low_rebound'
  | 'oversold'
  | 'undervalued'
  | 'low_per'
  | 'low_pbr'
  | 'roe_improving'
  | 'ai_high'
  | 'positive_disclosure'
  | 'positive_news'
  | 'short_trend_turn'
  | 'pullback'
  | 'pre_breakout'
  | 'volatility_expand'
  | 'box_lower'
  | 'box_upper_breakout'
  | 'support_rebound'
  | 'resistance_breakout';

const SCAN_LABELS: Record<ScanKey, string> = {
  accumulation: '바닥권매집',
  box_consolidation: '박스권 하단',
  obv_rising: '단기 추세 전환',
  volume_accum: '거래량 증가',
  bollinger_squeeze: '돌파 직전',
  rsi_recovery: 'RSI 과매도 반등',
  macd_turn: 'MACD 골든크로스',
  inst_accumulation: '기관 수급',
  foreign_accumulation: '외국인 수급',
  volume_spike: '거래량 급증',
  trading_value_up: '거래대금 증가',
  ma_breakout: '이평선 돌파',
  ma5_breakout: '5일선 돌파',
  ma20_recovery: '20일선 회복',
  ma60_breakout: '60일선 돌파',
  ma120_breakout: '120일선 돌파',
  rsi_overheat: 'RSI 과열',
  new_high_near: '신고가 근접',
  new_low_rebound: '신저가 반등',
  oversold: '낙폭과대',
  undervalued: '저평가',
  low_per: 'PER 낮음',
  low_pbr: 'PBR 낮음',
  roe_improving: 'ROE 개선',
  ai_high: 'AI 점수 상위',
  positive_disclosure: '공시 호재',
  positive_news: '뉴스 호재',
  short_trend_turn: '단기 추세 전환',
  pullback: '눌림목',
  pre_breakout: '돌파 직전',
  volatility_expand: '변동성 확대',
  box_lower: '박스권 하단',
  box_upper_breakout: '박스권 상단 돌파',
  support_rebound: '지지선 반등',
  resistance_breakout: '저항선 돌파',
};

const LABEL_TO_KEYS: Record<string, ScanKey[]> = Object.entries(SCAN_LABELS).reduce(
  (accumulator, [key, label]) => {
    accumulator[label] = [...(accumulator[label] ?? []), key as ScanKey];
    return accumulator;
  },
  {} as Record<string, ScanKey[]>,
);

const SUPPORTED_INDICATORS = Array.from(new Set([...Object.values(SCAN_LABELS), '시총']));

type CandleList = Awaited<ReturnType<typeof MarketDataService.getCandles>>;
type Quote = Awaited<ReturnType<typeof MarketDataService.getQuote>>;

export interface ScanExecutionOptions {
  signal?: AbortSignal;
  deadlineMs?: number;
  itemTimeoutMs?: number;
  concurrency?: number;
  limit?: number;
}

export interface BoundedScanResult {
  cards: ScanCard[];
  selected: string[];
  supportedIndicators: string[];
  scanned: number;
  requestedCount: number;
  completedCount: number;
  providerErrorCount: number;
  timeoutCount: number;
  excludedCount: number;
  appliedFilters: {
    volumeThreshold: number | null;
    tradingValueThreshold: number | null;
    marketCapThreshold: number | null;
    minimumScore: number | null;
    maximumRiskScore: number | null;
  };
  timeframe: ScannerTimeframe;
  partial: boolean;
  timedOut: boolean;
  elapsedMs: number;
  dataState: 'complete' | 'partial';
  message: string;
  maxConcurrency: number;
  deadlineMs: number;
  itemTimeoutMs: number;
}

export interface BoundedScannerDependencies {
  catalog: readonly CatalogEntry[];
  getCandles: (ticker: string, timeframe: ScannerTimeframe) => Promise<CandleList>;
  getQuote: (ticker: string) => Promise<Quote>;
  getContext: (entry: CatalogEntry) => Promise<SignalContext>;
  now: () => number;
}

export class ScanProviderUnavailableError extends Error {
  readonly code = 'SCAN_PROVIDER_ERROR';
  readonly provider = 'market-data';

  constructor(message: string) {
    super(message);
    this.name = 'ScanProviderUnavailableError';
  }
}

export class ScanRequestAbortedError extends Error {
  constructor() {
    super('Scanner request aborted');
    this.name = 'AbortError';
  }
}

const defaultDependencies: BoundedScannerDependencies = {
  catalog: CATALOG,
  getCandles: (ticker, timeframe) => MarketDataService.getCandles(ticker, timeframe),
  getQuote: (ticker) => MarketDataService.getQuote(ticker),
  getContext: (entry) => buildContext(entry),
  now: Date.now,
};

function normalizeSelected(selected: string[]): ScanKey[] {
  const keys: ScanKey[] = [];
  for (const item of selected) {
    const trimmed = item.trim();
    const direct = (Object.keys(SCAN_LABELS) as ScanKey[]).find((key) => key === trimmed);
    if (direct) keys.push(direct);
    else if (LABEL_TO_KEYS[trimmed]) keys.push(...LABEL_TO_KEYS[trimmed]);
  }
  return Array.from(new Set(keys));
}

function marketFilter(market: string): (entry: CatalogEntry) => boolean {
  if (market === 'KR') return (entry) => entry.market === 'KR';
  if (market === 'US') return (entry) => entry.market === 'US';
  return () => true;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentChange(from: number, to: number): number {
  return from ? ((to - from) / Math.abs(from)) * 100 : 0;
}

function scanTimeframe(value: unknown, market: string): ScannerTimeframe {
  const normalized = String(value ?? '1D') === '1H' ? '60m' : String(value ?? '1D');
  if (String(market).toUpperCase() === 'US' && normalized === '4H') {
    throw new Error('SCAN_TIMEFRAME_UNSUPPORTED:US:4H');
  }
  return isScannerTimeframe(normalized) ? normalized : '1D';
}

function boundedLookback(value: unknown, fallback = 20): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 60 ? parsed : fallback;
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isInteger(value) && Number(value) > 0
    ? Math.min(Number(value), maximum)
    : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ScanRequestAbortedError();
}

function candleDataState(candles: CandleList, timeframe: ScannerTimeframe): ScanCard['dataState'] {
  if (!candles.length) return 'unavailable';
  if (candles.length < 20) return 'insufficient';
  const rawTime = candles.at(-1)?.time;
  const latest = typeof rawTime === 'number'
    ? (rawTime > 10_000_000_000 ? rawTime : rawTime * 1_000)
    : Date.parse(String(rawTime ?? ''));
  if (!Number.isFinite(latest)) return 'delayed';
  const staleAfter = timeframe === '1D'
    ? 5 * 24 * 60 * 60_000
    : timeframe === '4H'
      ? 12 * 60 * 60_000
      : timeframe === '60m'
        ? 3 * 60 * 60_000
        : timeframe === '15m'
          ? 45 * 60_000
          : 20 * 60_000;
  return Date.now() - latest > staleAfter ? 'stale' : 'ok';
}

function dataStateRank(state: ScanCard['dataState']): number {
  return state === 'ok' ? 4 : state === 'delayed' ? 3 : state === 'stale' ? 2 : state === 'insufficient' ? 1 : 0;
}

function buildExtraCondition(
  key: ScanKey,
  conditions: ScanConditions,
  candles: CandleList,
  context: SignalContext,
): boolean | null {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const latestClose = closes.at(-1) ?? null;
  const latestHigh = highs.at(-1) ?? null;
  const latestLow = lows.at(-1) ?? null;
  const latestVolume = volumes.at(-1) ?? null;
  const high60 = highs.length ? Math.max(...highs.slice(-60)) : 0;
  const low60 = lows.length ? Math.min(...lows.slice(-60)) : 0;
  const high120 = highs.length ? Math.max(...highs.slice(-120)) : 0;
  const low120 = lows.length ? Math.min(...lows.slice(-120)) : 0;
  const ma20 = average(closes.slice(-20));
  const ma60 = average(closes.slice(-60));
  const ma120 = average(closes.slice(-120));
  const recentMove = percentChange(closes[closes.length - 20] ?? 0, latestClose ?? 0);
  const todayMove = percentChange(closes[closes.length - 2] ?? 0, latestClose ?? 0);

  switch (key) {
    case 'volume_spike':
      return latestVolume != null && average(volumes.slice(-20)) > 0
        ? latestVolume >= average(volumes.slice(-20)) * 1.8
        : null;
    case 'trading_value_up':
      return average(volumes.slice(-20)) > average(volumes.slice(-40, -20)) * 1.25;
    case 'ma_breakout':
    case 'ma20_recovery':
      return latestClose != null && ma20 > 0 && latestClose > ma20;
    case 'ma5_breakout': {
      if (closes.length < 6) return false;
      const latest5Ma = average(closes.slice(-5));
      const previous5Ma = average(closes.slice(-6, -1));
      const previousClose = closes[closes.length - 2];
      return latestClose != null
        && previousClose != null
        && latest5Ma > 0
        && previous5Ma > 0
        && previousClose <= previous5Ma
        && latestClose > latest5Ma;
    }
    case 'ma60_breakout':
      return latestClose != null && ma60 > 0 && latestClose > ma60;
    case 'ma120_breakout':
      return latestClose != null && ma120 > 0 && latestClose > ma120;
    case 'rsi_overheat':
      return conditions.score >= 75 && todayMove > 4;
    case 'new_high_near':
      return latestHigh != null && high120 > 0 && latestHigh >= high120 * 0.97;
    case 'new_low_rebound':
      return latestLow != null && low120 > 0 && latestLow <= low120 * 1.08 && todayMove > 0;
    case 'oversold':
      return recentMove <= -12;
    case 'undervalued':
      return Boolean(
        (context.financials?.pbr != null && context.financials.pbr > 0 && context.financials.pbr <= 1.2)
        || (context.financials?.per != null && context.financials.per > 0 && context.financials.per <= 12),
      );
    case 'low_per':
      return context.financials?.per != null && context.financials.per > 0 && context.financials.per <= 12;
    case 'low_pbr':
      return context.financials?.pbr != null && context.financials.pbr > 0 && context.financials.pbr <= 1.2;
    case 'roe_improving':
      return context.financials?.roe != null && context.financials.roe >= 8;
    case 'ai_high':
      return conditions.score >= 70;
    case 'positive_disclosure':
      return (context.positiveEvents?.length ?? 0) > 0;
    case 'positive_news':
      return (context.newsPositive ?? 0) > 0 || (context.newsScore ?? 0) > 55;
    case 'short_trend_turn':
      return latestClose != null && ma20 > 0 && latestClose > ma20 && conditions.macd_turn;
    case 'pullback':
      return latestClose != null && ma20 > 0 && latestClose >= ma20 * 0.97 && latestClose <= ma20 * 1.04;
    case 'pre_breakout':
      return conditions.bollinger_squeeze || (latestClose != null && high60 > 0 && latestClose >= high60 * 0.95);
    case 'volatility_expand':
      return Math.abs(todayMove) >= 4 || Math.abs(recentMove) >= 12;
    case 'box_lower':
      return latestClose != null && low60 > 0 && latestClose <= low60 * 1.08;
    case 'box_upper_breakout':
      return latestClose != null && high60 > 0 && latestClose >= high60;
    case 'support_rebound':
      return latestClose != null && low60 > 0 && latestClose <= low60 * 1.1 && todayMove > 0;
    case 'resistance_breakout':
      return latestClose != null && high60 > 0 && latestClose >= high60 * 0.99;
    default:
      return null;
  }
}

function conditionValue(
  key: ScanKey,
  conditions: ScanConditions,
  candles: CandleList,
  context: SignalContext,
): boolean | null {
  if (key in conditions) {
    return (conditions as unknown as Record<string, boolean | null>)[key] ?? null;
  }
  return buildExtraCondition(key, conditions, candles, context);
}

function scoreBreakdown(
  conditions: ScanConditions,
  candles: CandleList,
  context: SignalContext,
  liquidity: number | null,
  dataState: ScanCard['dataState'],
  marketChangePercent: number | null,
): ScanCard['scoreBreakdown'] {
  const latestVolume = candles.at(-1)?.volume ?? null;
  const baseline = average(candles.slice(-21, -1).map((item) => item.volume));
  const volumeRatio = latestVolume != null && baseline > 0 ? latestVolume / baseline : null;
  const riskEvents = context.negativeEvents?.length ?? 0;
  const financialValues = [context.financials?.per, context.financials?.pbr, context.financials?.roe]
    .filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
  const bounded = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
  const factor = (score: number | null, status: ScanCard['dataState'] | 'ok', reasons: string[]) => ({
    score: score == null ? null : bounded(score),
    status,
    reasons,
  });
  return {
    trend: factor(conditions.score, dataState === 'ok' ? 'ok' : dataState, [`기술 조건 점수 ${Math.round(conditions.score)}`]),
    volume: volumeRatio == null
      ? factor(null, 'insufficient', ['거래량 평균을 계산할 봉이 부족합니다.'])
      : factor(Math.min(100, volumeRatio * 50), dataState === 'ok' ? 'ok' : dataState, [`최근 평균 대비 거래량 ${volumeRatio.toFixed(2)}배`]),
    liquidity: liquidity == null
      ? factor(null, 'unavailable', ['거래대금 데이터가 제공되지 않았습니다.'])
      : factor(Math.min(100, Math.log10(Math.max(liquidity, 1)) * 8), 'ok', [`가격×거래량 ${Math.round(liquidity)}`]),
    technical: factor(conditions.confidence, dataState === 'ok' ? 'ok' : dataState, [`기술 신뢰도 ${Math.round(conditions.confidence)}`]),
    news: context.newsScore == null
      ? factor(null, 'unavailable', ['뉴스 점수를 제공하지 못했습니다.'])
      : factor((context.newsScore + 100) / 2, 'ok', [`긍정 ${context.newsPositive ?? 0}건 · 부정 ${context.newsNegative ?? 0}건`]),
    financial: financialValues.length && context.financialSource === 'live'
      ? factor(50 + Math.min(25, Math.max(-25, context.financials?.roe ?? 0)), 'ok', [`재무 지표 ${financialValues.length}개 사용`])
      : factor(null, 'unavailable', ['사용 가능한 재무 지표가 없습니다.']),
    market: marketChangePercent == null
      ? factor(null, 'unavailable', ['시장 지수 등락률을 제공하지 못했습니다.'])
      : factor(50 + marketChangePercent * 5, 'ok', [`시장 지수 등락률 ${marketChangePercent.toFixed(2)}%`]),
    risk: context.riskDataAvailable
      ? factor(Math.max(0, 100 - riskEvents * 20), 'ok', riskEvents ? [`부정 위험 이벤트 ${riskEvents}건 반영`] : ['공시·위험 데이터에서 확정된 부정 이벤트가 없습니다.'])
      : factor(null, 'unavailable', ['공시·위험 데이터를 제공하지 못했습니다.']),
  };
}

function createCard(
  entry: CatalogEntry,
  quote: Quote,
  candles: CandleList,
  context: SignalContext,
  conditions: ScanConditions,
  matched: string[],
  missing: string[],
  selectedCount: number,
  timeframe: ScannerTimeframe,
  marketMove: number | null,
): ScanCard {
  const report = computeSignalReport(candles, computeIndicators(candles), context);
  const accumulation = report.accumulation;
  const liquidity = typeof quote.volume === 'number' && Number.isFinite(quote.volume)
    ? quote.price * quote.volume
    : null;
  const dataState = candleDataState(candles, timeframe);
  const negativeEvents = context.negativeEvents?.length ?? 0;
  const riskScore = context.riskDataAvailable
    ? Math.min(100, negativeEvents * 25 + (dataState === 'stale' ? 20 : dataState === 'insufficient' ? 10 : 0))
    : null;
  const breakdown = scoreBreakdown(conditions, candles, context, liquidity, dataState, marketMove);
  const liveScore = computeLiveAiScore(breakdown);
  const marketCap = typeof quote.marketCap === 'number' && Number.isFinite(quote.marketCap) && quote.marketCap > 0
    ? quote.marketCap
    : null;

  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    assetType: classifyAssetType(entry.name, entry.market),
    price: quote.price,
    changePercent: quote.changePercent,
    score: liveScore,
    confidence: conditions.confidence,
    matched: Array.from(new Set(matched)),
    missing: Array.from(new Set(missing)),
    breakoutProbability: accumulation?.breakoutProbability ?? conditions.score,
    expectedPeriod: accumulation?.expectedPeriod ?? '단기 추세 확인 필요',
    entry: accumulation?.strategy.entry?.length
      ? accumulation.strategy.entry
      : [`박스권 하단 약 ${quote.price} 부근에서 진입`],
    stop: accumulation?.strategy.stop?.length
      ? accumulation.strategy.stop
      : [`최근 지지선 이탈 시 ${Math.round(quote.price * 0.94 * 100) / 100} 부근 손절`],
    matchCount: matched.length,
    selectedCount,
    riskLevel: riskScore == null ? 'UNAVAILABLE' : riskScore >= 60 ? 'HIGH' : riskScore >= 25 ? 'MEDIUM' : 'LOW',
    riskScore,
    liquidity,
    marketCap,
    dataState,
    analyzedAt: new Date().toISOString(),
    scoreBreakdown: breakdown,
  };
}

export function createBoundedScannerService(dependencies: BoundedScannerDependencies = defaultDependencies) {
  return {
    async scan(
      market: string,
      selected: string[],
      filters: ScanFilters = {},
      execution: ScanExecutionOptions = {},
    ): Promise<BoundedScanResult> {
      const startedAt = dependencies.now();
      const deadlineMs = positiveBound(execution.deadlineMs, SCAN_EXECUTION_LIMITS.deadlineMs, SCAN_EXECUTION_LIMITS.deadlineMs);
      const itemTimeoutMs = positiveBound(execution.itemTimeoutMs, SCAN_EXECUTION_LIMITS.itemTimeoutMs, deadlineMs);
      const concurrency = positiveBound(execution.concurrency, SCAN_EXECUTION_LIMITS.concurrency, 16);
      const limit = positiveBound(execution.limit, SCAN_POOL_LIMIT, SCAN_POOL_LIMIT);
      throwIfAborted(execution.signal);

      const keys = normalizeSelected(selected);
      const includesMarketCap = selected.some((item) => item.trim() === '시총');
      const active: ScanKey[] = keys.length > 0
        ? keys
        : includesMarketCap
          ? []
          : ['volume_accum', 'ma_breakout', 'ai_high'];
      const timeframe = scanTimeframe(filters.timeframe, market);
      const volumeThreshold = typeof filters.volumeThreshold === 'number' && filters.volumeThreshold > 0
        ? filters.volumeThreshold
        : null;
      const tradingValueThreshold = typeof filters.tradingValueThreshold === 'number' && filters.tradingValueThreshold > 0
        ? filters.tradingValueThreshold
        : null;
      const marketCapThreshold = typeof filters.marketCapThreshold === 'number' && Number.isFinite(filters.marketCapThreshold) && filters.marketCapThreshold > 0
        ? filters.marketCapThreshold
        : null;
      const minimumScore = typeof filters.minimumScore === 'number' && Number.isFinite(filters.minimumScore)
        ? Math.max(0, Math.min(100, filters.minimumScore))
        : null;
      const maximumRiskScore = typeof filters.maximumRiskScore === 'number' && Number.isFinite(filters.maximumRiskScore)
        ? Math.max(0, Math.min(100, filters.maximumRiskScore))
        : null;
      const volumeLookback = boundedLookback(filters.volumeLookbackDays);
      const tradingValueLookback = boundedLookback(filters.tradingValueLookbackDays);
      const pool = dependencies.catalog.filter(marketFilter(market)).slice(0, limit);
      const marketMoves = new Map<string, number>();
      const targetMarkets = market === 'KR' || market === 'US' ? [market] : ['KR', 'US'];

      await runBoundedWorkPool(
        targetMarkets,
        async (targetMarket, _index, signal) => {
          throwIfAborted(signal);
          try {
            const quote = await dependencies.getQuote(targetMarket === 'KR' ? '^KS11' : '^GSPC');
            if (!signal.aborted && Number.isFinite(quote.changePercent)) {
              marketMoves.set(targetMarket, quote.changePercent);
            }
          } catch {
            // Market index context is optional and stays unavailable when delayed.
          }
        },
        {
          concurrency: 2,
          deadlineMs: Math.min(SCAN_EXECUTION_LIMITS.marketContextTimeoutMs, deadlineMs),
          itemTimeoutMs: Math.min(SCAN_EXECUTION_LIMITS.marketContextTimeoutMs, itemTimeoutMs),
          signal: execution.signal,
          now: dependencies.now,
        },
      );
      throwIfAborted(execution.signal);

      const remainingMs = Math.max(1, deadlineMs - (dependencies.now() - startedAt));
      const work = await runBoundedWorkPool(
        pool,
        async (entry, _index, signal): Promise<ScanCard | null> => {
          throwIfAborted(signal);
          const [candles, quote, context] = await Promise.all([
            dependencies.getCandles(entry.ticker, timeframe),
            dependencies.getQuote(entry.ticker),
            dependencies.getContext(entry),
          ]);
          throwIfAborted(signal);
          const indicators = computeIndicators(candles);
          const conditions = computeScanConditions(candles, indicators);
          if (!conditions || !quote) return null;

          const latestVolume = candles.at(-1)?.volume ?? null;
          if (volumeThreshold != null) {
            const baseline = average(candles.slice(-(volumeLookback + 1), -1).map((candle) => candle.volume));
            if (latestVolume == null || baseline <= 0 || latestVolume < baseline * (volumeThreshold / 100)) return null;
          }
          if (tradingValueThreshold != null) {
            const latestTradingValue = latestVolume == null ? null : latestVolume * quote.price;
            const baseline = average(candles.slice(-(tradingValueLookback + 1), -1).map((candle) => candle.volume * candle.close));
            if (latestTradingValue == null || baseline <= 0 || latestTradingValue < baseline * (tradingValueThreshold / 100)) return null;
          }

          const matched: string[] = [];
          const missing: string[] = [];
          const marketCap = typeof quote.marketCap === 'number' && Number.isFinite(quote.marketCap) && quote.marketCap > 0
            ? quote.marketCap
            : null;
          if (includesMarketCap) {
            if (marketCap != null && (marketCapThreshold == null || marketCap >= marketCapThreshold)) matched.push('시총');
            else missing.push('시총');
          }
          for (const key of active) {
            const passed = conditionValue(key, conditions, candles, context);
            const label = SCAN_LABELS[key];
            if (passed === true) matched.push(label);
            else missing.push(label);
          }
          if (matched.length === 0) return null;

          const card = createCard(
            entry,
            quote,
            candles,
            context,
            conditions,
            matched,
            missing,
            active.length + (includesMarketCap ? 1 : 0),
            timeframe,
            marketMoves.get(entry.market) ?? null,
          );
          if (minimumScore != null && card.score < minimumScore) return null;
          if (maximumRiskScore != null && (card.riskScore == null || card.riskScore > maximumRiskScore)) return null;
          return card;
        },
        {
          concurrency,
          deadlineMs: remainingMs,
          itemTimeoutMs: Math.min(itemTimeoutMs, remainingMs),
          signal: execution.signal,
          now: dependencies.now,
        },
      );
      throwIfAborted(execution.signal);

      const completedCards = work.outcomes
        .filter((outcome) => outcome.status === 'fulfilled')
        .map((outcome) => outcome.value ?? null);
      const completedCount = work.fulfilledCount;
      const providerErrorCount = work.rejectedCount;
      const timeoutCount = work.timedOutCount;
      const failureCount = providerErrorCount + timeoutCount;
      const unreliable = pool.length > 0 && (
        completedCount === 0
        || (
          work.startedCount > 0
          && failureCount >= Math.max(3, Math.ceil(work.startedCount * 0.8))
          && completedCount < Math.min(3, pool.length)
        )
      );
      if (unreliable) {
        throw new ScanProviderUnavailableError(
          `SCAN_PROVIDER_ERROR: completed=${completedCount}, providerErrors=${providerErrorCount}, timeouts=${timeoutCount}, started=${work.startedCount}`,
        );
      }

      const matchedCards = completedCards.filter((card): card is ScanCard => card !== null);
      const cards = matchedCards
        .sort((left, right) => right.score - left.score
          || right.confidence - left.confidence
          || (right.liquidity ?? -1) - (left.liquidity ?? -1)
          || right.matchCount - left.matchCount
          || (left.riskScore ?? 100) - (right.riskScore ?? 100)
          || dataStateRank(right.dataState) - dataStateRank(left.dataState))
        .slice(0, SCAN_CARD_LIMIT);
      const elapsedMs = Math.max(0, dependencies.now() - startedAt);
      const partial = work.deadlineReached
        || work.startedCount < pool.length
        || providerErrorCount > 0
        || timeoutCount > 0;
      const dataState: BoundedScanResult['dataState'] = partial ? 'partial' : 'complete';
      const message = partial
        ? `일부 데이터가 지연되어 ${completedCount}/${pool.length}종목 처리 결과를 반환했습니다.`
        : cards.length === 0
          ? '스캔은 정상 완료됐지만 조건에 맞는 종목이 없습니다.'
          : `${completedCount}종목 스캔을 정상 완료했습니다.`;

      return {
        cards,
        selected: [...active.map((key) => SCAN_LABELS[key]), ...(includesMarketCap ? ['시총'] : [])],
        supportedIndicators: SUPPORTED_INDICATORS,
        scanned: work.startedCount,
        requestedCount: pool.length,
        completedCount,
        providerErrorCount,
        timeoutCount,
        excludedCount: Math.max(0, completedCount - matchedCards.length),
        appliedFilters: {
          volumeThreshold,
          tradingValueThreshold,
          marketCapThreshold,
          minimumScore,
          maximumRiskScore,
        },
        timeframe,
        partial,
        timedOut: timeoutCount > 0 || work.deadlineReached,
        elapsedMs,
        dataState,
        message,
        maxConcurrency: work.maxConcurrency,
        deadlineMs,
        itemTimeoutMs,
      };
    },
  };
}

export const BoundedScannerService = createBoundedScannerService();