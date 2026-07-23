import { cached, TTL } from '../lib/cache';
import { getCatalogEntry, CATALOG, type CatalogEntry } from '../data/catalog';
import { classifyAssetType, type AssetType } from '../data/asset-type';
import { MarketDataService } from './market-data.service';
import { FinancialService } from './financial.service';
import { RiskAnalysisService } from './risk-analysis.service';
import { NewsService } from './news.service';
import { computeScores } from '../sample/scores';
import { computeIndicators } from '../sample/indicators';
import {
  computeSignalReport,
  computeScanConditions,
  type SignalContext,
  type SignalReport,
  type ScanConditions,
} from '../sample/accumulation';

const NEGATIVE_EVENTS = new Set([
  'OFFERING',
  'ATM',
  'REVERSE_SPLIT',
  'CB',
  'BW',
  'RIGHTS_OFFERING',
]);

const POSITIVE_EVENTS = new Set(['DIVIDEND', 'SUPPLY_CONTRACT']);

export async function buildContext(entry: CatalogEntry): Promise<SignalContext> {
  const ctx: SignalContext = { currency: entry.currency };

  const [fin, risk, news] = await Promise.allSettled([
    FinancialService.getFinancials(entry.ticker),
    RiskAnalysisService.getRisk(entry.ticker),
    NewsService.getNews(entry.ticker),
  ]);

  if (fin.status === 'fulfilled' && fin.value) {
    const f = fin.value;

    ctx.financials = {
      revenueGrowth: f.growth?.revenue,
      profitGrowth: f.growth?.profit,
      per: f.ratios?.per,
      pbr: f.ratios?.pbr,
      roe: f.ratios?.roe,
      debtRatio: f.ratios?.debtRatio,
      cashBalance: f.cashBurn?.cashBalance,
    };
  }

  if (risk.status === 'fulfilled' && risk.value) {
    const positive: string[] = [];
    const negative: string[] = [];

    const items = [
      ...(risk.value.filings ?? []),
      ...(risk.value.disclosures ?? []),
    ];

    for (const item of items) {
      const events = item.events ?? [];
      const labels = item.eventLabels ?? [];

      events.forEach((code, index) => {
        const label = labels[index] ?? code;

        if (NEGATIVE_EVENTS.has(code)) negative.push(label);
        else if (POSITIVE_EVENTS.has(code)) positive.push(label);
      });
    }

    ctx.negativeEvents = Array.from(new Set(negative));
    ctx.positiveEvents = Array.from(new Set(positive));
  }

  if (news.status === 'fulfilled' && news.value) {
    ctx.newsScore = news.value.sentimentScore;
    ctx.newsPositive = news.value.positive?.length ?? 0;
    ctx.newsNegative = news.value.negative?.length ?? 0;
  }

  return ctx;
}

async function getReport(ticker: string): Promise<SignalReport | null> {
  const entry = getCatalogEntry(ticker);

  if (!entry) return null;

  return cached(`signals:${ticker}`, TTL.signals, async () => {
    const candles = await MarketDataService.getCandles(ticker, '1D');
    const indicators = computeIndicators(candles);
    const ctx = await buildContext(entry);

    return computeSignalReport(candles, indicators, ctx);
  });
}

export interface ScanCard {
  ticker: string;
  name: string;
  market: 'US' | 'KR';
  currency: 'USD' | 'KRW';
  assetType: AssetType;
  price: number;
  changePercent: number;
  score: number;
  confidence: number;
  matched: string[];
  missing: string[];
  breakoutProbability: number;
  expectedPeriod: string;
  entry: string[];
  stop: string[];
  matchCount: number;
  selectedCount: number;
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
  (acc, [key, label]) => {
    acc[label] = [...(acc[label] ?? []), key as ScanKey];

    return acc;
  },
  {} as Record<string, ScanKey[]>,
);

function normalizeSelected(selected: string[]): ScanKey[] {
  const keys: ScanKey[] = [];

  selected.forEach((item) => {
    const trimmed = item.trim();

    const direct = (Object.keys(SCAN_LABELS) as ScanKey[]).find(
      (key) => key === trimmed,
    );

    if (direct) {
      keys.push(direct);
      return;
    }

    const mapped = LABEL_TO_KEYS[trimmed];

    if (mapped) {
      keys.push(...mapped);
    }
  });

  return Array.from(new Set(keys));
}

function marketFilter(market: string): (entry: CatalogEntry) => boolean {
  if (market === 'KR') return (entry) => entry.market === 'KR';
  if (market === 'US') return (entry) => entry.market === 'US';

  return () => true;
}

function last<T>(items: T[]): T | null {
  return items.length ? items[items.length - 1] : null;
}

function avg(values: number[]): number {
  if (!values.length) return 0;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pctChange(a: number, b: number): number {
  if (!a) return 0;

  return ((b - a) / Math.abs(a)) * 100;
}

function buildExtraCondition(
  key: ScanKey,
  cond: ScanConditions,
  candles: Awaited<ReturnType<typeof MarketDataService.getCandles>>,
  ctx: SignalContext,
): boolean | null {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const latestClose = last(closes);
  const latestHigh = last(highs);
  const latestLow = last(lows);
  const latestVolume = last(volumes);
  const recentCloses = closes.slice(-20);
  const prevCloses = closes.slice(-40, -20);
  const recentVolumes = volumes.slice(-20);
  const prevVolumes = volumes.slice(-40, -20);
  const high60 = Math.max(...highs.slice(-60));
  const low60 = Math.min(...lows.slice(-60));
  const high120 = Math.max(...highs.slice(-120));
  const low120 = Math.min(...lows.slice(-120));
  const ma20 = avg(closes.slice(-20));
  const ma60 = avg(closes.slice(-60));
  const ma120 = avg(closes.slice(-120));
  const recentMove = pctChange(closes[closes.length - 20] ?? 0, latestClose ?? 0);
  const todayMove = pctChange(closes[closes.length - 2] ?? 0, latestClose ?? 0);

  switch (key) {
    case 'volume_spike':
      return latestVolume != null && avg(recentVolumes) > 0
        ? latestVolume >= avg(recentVolumes) * 1.8
        : null;

    case 'trading_value_up':
      return avg(recentVolumes) > avg(prevVolumes) * 1.25;

    case 'ma_breakout':
      return latestClose != null && ma20 > 0 && latestClose > ma20;

    case 'ma5_breakout': {
      // Real 5-day MA breakout: latest close crosses ABOVE the 5-day moving
      // average (previous close <= previous 5MA, latest close > latest 5MA).
      // Requires >= 6 daily bars (5 for the MA + 1 prior bar to detect the
      // cross). With fewer bars we cannot confirm a cross → not matched.
      if (closes.length < 6) return false;

      const latest5Ma = avg(closes.slice(-5));
      const prev5Ma = avg(closes.slice(-6, -1));
      const prevClose = closes[closes.length - 2];

      if (
        latestClose == null ||
        prevClose == null ||
        latest5Ma <= 0 ||
        prev5Ma <= 0
      ) {
        return false;
      }

      return prevClose <= prev5Ma && latestClose > latest5Ma;
    }

    case 'ma20_recovery':
      return latestClose != null && ma20 > 0 && latestClose > ma20;

    case 'ma60_breakout':
      return latestClose != null && ma60 > 0 && latestClose > ma60;

    case 'ma120_breakout':
      return latestClose != null && ma120 > 0 && latestClose > ma120;

    case 'rsi_overheat':
      return cond.score >= 75 && todayMove > 4;

    case 'new_high_near':
      return latestHigh != null && high120 > 0 && latestHigh >= high120 * 0.97;

    case 'new_low_rebound':
      return latestLow != null && low120 > 0 && latestLow <= low120 * 1.08 && todayMove > 0;

    case 'oversold':
      return recentMove <= -12;

    case 'undervalued':
      return Boolean(
        (ctx.financials?.pbr != null && ctx.financials.pbr > 0 && ctx.financials.pbr <= 1.2) ||
          (ctx.financials?.per != null && ctx.financials.per > 0 && ctx.financials.per <= 12),
      );

    case 'low_per':
      return ctx.financials?.per != null && ctx.financials.per > 0 && ctx.financials.per <= 12;

    case 'low_pbr':
      return ctx.financials?.pbr != null && ctx.financials.pbr > 0 && ctx.financials.pbr <= 1.2;

    case 'roe_improving':
      return ctx.financials?.roe != null && ctx.financials.roe >= 8;

    case 'ai_high':
      return cond.score >= 70;

    case 'positive_disclosure':
      return (ctx.positiveEvents?.length ?? 0) > 0;

    case 'positive_news':
      return (ctx.newsPositive ?? 0) > 0 || (ctx.newsScore ?? 0) > 55;

    case 'short_trend_turn':
      return latestClose != null && ma20 > 0 && latestClose > ma20 && cond.macd_turn;

    case 'pullback':
      return latestClose != null && ma20 > 0 && latestClose >= ma20 * 0.97 && latestClose <= ma20 * 1.04;

    case 'pre_breakout':
      return cond.bollinger_squeeze || (latestClose != null && high60 > 0 && latestClose >= high60 * 0.95);

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
  cond: ScanConditions,
  candles: Awaited<ReturnType<typeof MarketDataService.getCandles>>,
  ctx: SignalContext,
): boolean | null {
  if (key in cond) {
    return (cond as unknown as Record<string, boolean | null>)[key] ?? null;
  }

  return buildExtraCondition(key, cond, candles, ctx);
}

export interface ScanFilters {
  // Minimum latest daily volume (shares/contracts).
  volumeThreshold?: number;
  // Minimum latest trading value (latest close * latest volume).
  tradingValueThreshold?: number;
}

// Maximum scan cards returned (raised from 30 → ~100).
const SCAN_CARD_LIMIT = 100;
// Universe pool size scanned per request (raised from 48).
const SCAN_POOL_LIMIT = 200;

// Full list of supported indicator keys (exact strings the frontend may send).
// Both the internal keys AND their Korean labels are accepted by
// normalizeSelected(); the labels are the canonical display strings.
const SUPPORTED_INDICATORS: string[] = Object.values(SCAN_LABELS);

async function scan(
  market: string,
  selected: string[],
  filters: ScanFilters = {},
  limit = SCAN_POOL_LIMIT,
): Promise<{
  cards: ScanCard[];
  selected: string[];
  supportedIndicators: string[];
  scanned: number;
  excludedCount: number;
  appliedFilters: { volumeThreshold: number | null; tradingValueThreshold: number | null };
}> {
  const keys = normalizeSelected(selected);
  const active: ScanKey[] =
    keys.length > 0 ? keys : ['volume_accum', 'ma_breakout', 'ai_high'];

  const volumeThreshold =
    typeof filters.volumeThreshold === 'number' && filters.volumeThreshold > 0
      ? filters.volumeThreshold
      : null;
  const tradingValueThreshold =
    typeof filters.tradingValueThreshold === 'number' &&
    filters.tradingValueThreshold > 0
      ? filters.tradingValueThreshold
      : null;

  const pool = CATALOG.filter(marketFilter(market)).slice(0, limit);

  // 공급자 오류(데이터 조회 실패)와 조건 미충족을 구분해 집계한다.
  let providerErrors = 0;

  const settled = await Promise.all(
    pool.map(async (entry): Promise<ScanCard | null> => {
      try {
        const [candles, quote, ctx] = await Promise.all([
          MarketDataService.getCandles(entry.ticker, '1D'),
          MarketDataService.getQuote(entry.ticker),
          buildContext(entry),
        ]);

        const indicators = computeIndicators(candles);
        const cond = computeScanConditions(candles, indicators);

        if (!cond || !quote) return null;

        // Optional volume / trading-value filters. Thresholds are expressed as
        // "평소(최근 평균) 대비 %": 100 = 평균 수준, 150 = 평균보다 50% 많음.
        // We compare the latest bar against a ~20-bar recent-average baseline,
        // NOT an absolute share count (which would be meaningless as a filter).
        const recentBars = candles.slice(-21, -1);
        const latestVolume =
          candles.length > 0 ? candles[candles.length - 1].volume : null;

        if (volumeThreshold != null) {
          const avgVolume = recentBars.length
            ? avg(recentBars.map((c) => c.volume))
            : null;
          if (
            latestVolume == null ||
            avgVolume == null ||
            avgVolume <= 0 ||
            latestVolume < avgVolume * (volumeThreshold / 100)
          ) {
            return null;
          }
        }

        if (tradingValueThreshold != null) {
          const latestTradingValue =
            latestVolume != null ? latestVolume * quote.price : null;
          const avgTradingValue = recentBars.length
            ? avg(recentBars.map((c) => c.volume * c.close))
            : null;
          if (
            latestTradingValue == null ||
            avgTradingValue == null ||
            avgTradingValue <= 0 ||
            latestTradingValue < avgTradingValue * (tradingValueThreshold / 100)
          ) {
            return null;
          }
        }

        const matched: string[] = [];
        const missing: string[] = [];

        for (const key of active) {
          const passed = conditionValue(key, cond, candles, ctx);
          const label = SCAN_LABELS[key];

          if (passed === true) matched.push(label);
          else missing.push(label);
        }

        if (matched.length === 0) return null;

        const report = await getReport(entry.ticker);
        const accumulation = report?.accumulation;

        // Canonical investment score — same computeScores().overall used by the
        // overview / analysis endpoints and movers rows. Do NOT invent a
        // separate scoring formula for lists.
        const { overall } = computeScores(entry.ticker);

        return {
          ticker: entry.ticker,
          name: entry.name,
          market: entry.market,
          currency: entry.currency,
          assetType: classifyAssetType(entry.name, entry.market),
          price: quote.price,
          changePercent: quote.changePercent,
          score: overall,
          confidence: cond.confidence,
          matched: Array.from(new Set(matched)),
          missing: Array.from(new Set(missing)),
          breakoutProbability: accumulation?.breakoutProbability ?? cond.score,
          expectedPeriod: accumulation?.expectedPeriod ?? '단기 추세 확인 필요',
          entry:
            accumulation?.strategy.entry?.length
              ? accumulation.strategy.entry
              : [`박스권 하단 약 ${quote.price} 부근에서 진입`],
          stop:
            accumulation?.strategy.stop?.length
              ? accumulation.strategy.stop
              : [`최근 지지선 이탈 시 ${Math.round(quote.price * 0.94 * 100) / 100} 부근 손절`],
          matchCount: matched.length,
          selectedCount: active.length,
        };
      } catch {
        // 데이터 조회 실패(공급자 오류) — 조건 미충족(null 반환 경로)과 구분.
        providerErrors += 1;
        return null;
      }
    }),
  );

  // 풀의 대부분에서 데이터 조회 자체가 실패하면 "결과 0건"이 아니라
  // 공급자 오류로 명시적으로 실패시킨다.
  if (pool.length > 0 && providerErrors >= Math.max(10, Math.ceil(pool.length * 0.8))) {
    const err = new Error(
      `SCAN_PROVIDER_ERROR: ${providerErrors}/${pool.length} 종목 데이터 조회 실패 (시세 공급자 장애)`,
    );
    (err as any).provider = 'market-data';
    throw err;
  }

  const cards = settled
    .filter((card): card is ScanCard => card !== null)
    .sort((a, b) => b.matchCount - a.matchCount || b.score - a.score)
    .slice(0, SCAN_CARD_LIMIT);

  const survived = settled.filter((card) => card !== null).length;

  return {
    cards,
    selected: active.map((key) => SCAN_LABELS[key]),
    supportedIndicators: SUPPORTED_INDICATORS,
    scanned: pool.length,
    excludedCount: pool.length - survived,
    appliedFilters: { volumeThreshold, tradingValueThreshold },
  };
}

export const SUPPORTED_SCAN_INDICATORS = SUPPORTED_INDICATORS;

export const SignalService = {
  getReport,
  scan,
};