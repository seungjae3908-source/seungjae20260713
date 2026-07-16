// MarketListingService — powers the redesigned home screen.
import {
  CATALOG,
  registerDynamicEntry,
  type CatalogEntry,
} from '../data/catalog';
import {
  classifyAssetType,
  isLeveraged,
  isInverse,
  type AssetType,
} from '../data/asset-type';
import { getUsUniverse } from '../providers/us-universe';
import { getKrUniverse } from '../providers/krx';
import * as yahoo from '../providers/yahoo';
import { computeScores } from '../sample/scores';
import { scoreToRating } from '../sample/rating';
import { cached, TTL } from '../lib/cache';
import type { Rating, Candle } from '../sample/types';
import { MarketDataService, type QuoteRow } from './market-data.service';
import { FinancialService } from './financial.service';
import { NewsService } from './news.service';
import { RiskAnalysisService } from './risk-analysis.service';
import { SECTOR_MAP } from '../data/sectors';

// ---- Market summary ---------------------------------------------------------

export interface SummaryItem {
  key: string;
  label: string;
  price: number;
  changePercent: number;
  spark: number[];
  unit: 'index' | 'krw' | 'usd';
  ok: boolean;
}

const SUMMARY_DEFS: {
  key: string;
  label: string;
  symbol: string;
  unit: SummaryItem['unit'];
}[] = [
  { key: 'kospi', label: '코스피', symbol: '^KS11', unit: 'index' },
  { key: 'kosdaq', label: '코스닥', symbol: '^KQ11', unit: 'index' },
  { key: 'nasdaq', label: '나스닥', symbol: '^IXIC', unit: 'index' },
  { key: 'sp500', label: 'S&P 500', symbol: '^GSPC', unit: 'index' },
  { key: 'dow', label: '다우', symbol: '^DJI', unit: 'index' },
  { key: 'russell', label: '러셀2000', symbol: '^RUT', unit: 'index' },
  { key: 'vix', label: 'VIX', symbol: '^VIX', unit: 'index' },
  { key: 'usdkrw', label: '원/달러', symbol: 'KRW=X', unit: 'krw' },
  { key: 'btc', label: '비트코인', symbol: 'BTC-USD', unit: 'usd' },
  { key: 'gold', label: '금', symbol: 'GC=F', unit: 'usd' },
  { key: 'oil', label: '유가(WTI)', symbol: 'CL=F', unit: 'usd' },
];

async function getMarketSummary(): Promise<SummaryItem[]> {
  return Promise.all(
    SUMMARY_DEFS.map(async (d) => {
      try {
        const q = await yahoo.getIndexQuote(d.symbol);
        return {
          key: d.key,
          label: d.label,
          price: q.price,
          changePercent: q.changePercent,
          spark: q.spark,
          unit: d.unit,
          ok: true,
        };
      } catch {
        return {
          key: d.key,
          label: d.label,
          price: 0,
          changePercent: 0,
          spark: [],
          unit: d.unit,
          ok: false,
        };
      }
    }),
  );
}

// ---- Per-market category lists ---------------------------------------------

export type MarketKey =
  | 'KRX'
  | 'KOSPI'
  | 'KOSDAQ'
  | 'KR_ETF'
  | 'KR_ETN'
  | 'NASDAQ'
  | 'NYSE'
  | 'AMEX'
  | 'US_ETF'
  | 'US_ETN';

export interface MarketListings {
  market: MarketKey;
  popular: QuoteRow[];
  gainers: QuoteRow[];
  losers: QuoteRow[];
  recommended: QuoteRow[];
}

const MAX = 30;
const CANDIDATE_CAP = 250;

const RATING_LABEL: Record<Rating, string> = {
  STRONG_BUY: '적극 매수',
  BUY: '매수',
  HOLD: '보통',
  SELL: '매도',
  STRONG_SELL: '적극 매도',
};

const US_ETF_TICKERS = new Set([
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'VOO',
  'VTI',
  'SCHD',
  'JEPI',
  'JEPQ',
  'SMH',
  'SOXX',
  'XLK',
  'XLE',
  'XLF',
  'XLV',
  'XLI',
  'ARKK',
  'ARKG',
  'ARKW',
  'SOXL',
  'SOXS',
  'TQQQ',
  'SQQQ',
  'SPXL',
  'SPXS',
  'TECL',
  'TECS',
  'LABU',
  'LABD',
  'BOIL',
  'KOLD',
  'UVXY',
]);

const KR_ETF_BRANDS = [
  'KODEX',
  'TIGER',
  'ACE',
  'RISE',
  'SOL',
  'HANARO',
  'ARIRANG',
  'PLUS',
  'KBSTAR',
  'KINDEX',
  'KOSEF',
  'TIMEFOLIO',
];

function assetTypeOf(e: CatalogEntry): AssetType {
  const name = e.name.toLowerCase();
  const upperName = e.name.toUpperCase();
  const ticker = e.ticker.toUpperCase();

  const isKrEtfBrand = KR_ETF_BRANDS.some((brand) =>
    upperName.startsWith(brand),
  );

  const leveraged =
    name.includes('3x') ||
    name.includes('2x') ||
    name.includes('레버리지') ||
    name.includes('bull') ||
    name.includes('ultrapro') ||
    name.includes('ultra ');

  const inverse =
    name.includes('inverse') ||
    name.includes('short') ||
    name.includes('bear') ||
    name.includes('인버스');

  const etn =
    name.includes('etn') ||
    upperName.includes(' ETN') ||
    upperName.endsWith('ETN');

  if (etn) {
    if (leveraged) return 'LEVERAGED_ETN';
    if (inverse) return 'INVERSE_ETN';
    return 'ETN';
  }

  if (isKrEtfBrand || US_ETF_TICKERS.has(ticker) || name.includes('etf')) {
    if (leveraged) return 'LEVERAGED_ETF';
    if (inverse) return 'INVERSE_ETF';
    return 'ETF';
  }

  return classifyAssetType(e.name, e.market);
}

const isEtf = (a: AssetType) =>
  a === 'ETF' || a === 'LEVERAGED_ETF' || a === 'INVERSE_ETF';

const isEtnAsset = (a: AssetType) =>
  a === 'ETN' || a === 'LEVERAGED_ETN' || a === 'INVERSE_ETN';

const isStock = (a: AssetType) => a === 'STOCK' || a === 'REIT' || a === 'ADR';

async function krExchangeMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  try {
    for (const e of await getKrUniverse()) {
      if (e.marketName.includes('유가증권') || e.marketName.includes('코스피')) {
        map.set(e.ticker, 'KOSPI');
      } else if (e.marketName.includes('코스닥')) {
        map.set(e.ticker, 'KOSDAQ');
      }
    }
  } catch {
    // best-effort
  }

  return map;
}

async function buildCandidates(market: MarketKey): Promise<CatalogEntry[]> {
	const at = (e: CatalogEntry) => assetTypeOf(e);

	const uniqueAndRegister = (entries: CatalogEntry[]): CatalogEntry[] => {
		const seen = new Set<string>();
		const out: CatalogEntry[] = [];

		for (const entry of entries) {
			const key = `${entry.market}:${entry.ticker.toUpperCase()}`;

			if (seen.has(key)) continue;
			seen.add(key);

			registerDynamicEntry(entry);
			out.push(entry);
		}

		return out;
	};

	const catalogKr = CATALOG.filter((e) => e.market === 'KR');
	const catalogUs = CATALOG.filter((e) => e.market === 'US');

	if (
		market === 'KRX' ||
		market === 'KOSPI' ||
		market === 'KOSDAQ' ||
		market === 'KR_ETF' ||
		market === 'KR_ETN'
	) {
		let krEntries: CatalogEntry[] = [];

		try {
			const universe = await getKrUniverse();

			krEntries = universe
				.filter((e) => {
					if (market === 'KRX') {
						return isStock(e.assetType);
					}

					if (market === 'KOSPI') {
						return (
							isStock(e.assetType) &&
							(e.marketName.includes('유가증권') ||
								e.marketName.includes('코스피') ||
								e.marketName.toUpperCase().includes('KOSPI'))
						);
					}

					if (market === 'KOSDAQ') {
						return (
							isStock(e.assetType) &&
							(e.marketName.includes('코스닥') ||
								e.marketName.toUpperCase().includes('KOSDAQ'))
						);
					}

					if (market === 'KR_ETF') {
						return isEtf(e.assetType);
					}

					if (market === 'KR_ETN') {
						return isEtnAsset(e.assetType);
					}

					return false;
				})
				.map((e) => ({
					ticker: e.ticker,
					name: e.name,
					market: 'KR' as const,
					currency: 'KRW' as const,
				}));
		} catch (error) {
			console.error('[market-listing] KRX universe failed:', error);
		}

		const catalogFallback = catalogKr.filter((e) => {
			const assetType = at(e);

			if (market === 'KRX') return isStock(assetType);
			if (market === 'KOSPI') return isStock(assetType);
			if (market === 'KOSDAQ') return isStock(assetType);
			if (market === 'KR_ETF') return isEtf(assetType);
			if (market === 'KR_ETN') return isEtnAsset(assetType);

			return false;
		});

		return uniqueAndRegister([...krEntries, ...catalogFallback]).slice(
			0,
			CANDIDATE_CAP,
		);
	}

	if (
		market === 'NASDAQ' ||
		market === 'NYSE' ||
		market === 'AMEX' ||
		market === 'US_ETF' ||
		market === 'US_ETN'
	) {
		let usEntries: CatalogEntry[] = [];

		try {
			const universe = await getUsUniverse();

			usEntries = universe
				.filter((e) => {
					if (market === 'NASDAQ' || market === 'NYSE' || market === 'AMEX') {
						return e.exchange === market && isStock(e.assetType);
					}

					if (market === 'US_ETF') {
						return isEtf(e.assetType);
					}

					if (market === 'US_ETN') {
						return isEtnAsset(e.assetType);
					}

					return false;
				})
				.map((e) => ({
					ticker: e.ticker,
					name: e.name,
					market: 'US' as const,
					currency: 'USD' as const,
				}));
		} catch (error) {
			console.error('[market-listing] US universe failed:', error);
		}

		const catalogFallback = catalogUs.filter((e) => {
			const assetType = at(e);

			if (market === 'NASDAQ' || market === 'NYSE' || market === 'AMEX') {
				return isStock(assetType);
			}

			if (market === 'US_ETF') return isEtf(assetType);
			if (market === 'US_ETN') return isEtnAsset(assetType);

			return false;
		});

		return uniqueAndRegister([...usEntries, ...catalogFallback]).slice(
			0,
			CANDIDATE_CAP,
		);
	}

	return uniqueAndRegister(CATALOG).slice(0, CANDIDATE_CAP);
}

async function toRow(entry: CatalogEntry): Promise<QuoteRow | null> {
  try {
    const quote = entry.market === 'US'
      ? await yahoo.getQuote(entry)
      : await MarketDataService.getQuote(entry.ticker);

    if (!quote) return null;

    const price = Number(quote.price ?? 0);
    if (!Number.isFinite(price) || price <= 0) return null;

    const changeAmount = Number(quote.changeAmount ?? 0);
    const changePercent = Number(quote.changePercent ?? 0);
    const volume = Number(quote.volume ?? 0);
    const tradingValue = Number((quote as any).tradingValue ?? price * volume);
    const assetType = assetTypeOf(entry);
    const { overall } = computeScores(entry.ticker);

    return {
      ticker: entry.ticker,
      name: entry.name,
      market: entry.market,
      currency: entry.currency,
      assetType,
      price,
      changeAmount: Number.isFinite(changeAmount) ? changeAmount : 0,
      changePercent: Number.isFinite(changePercent) ? changePercent : 0,
      volume: Number.isFinite(volume) ? volume : 0,
      tradingValue: Number.isFinite(tradingValue) ? tradingValue : 0,
      high: Number((quote as any).high ?? 0) || undefined,
      low: Number((quote as any).low ?? 0) || undefined,
      open: Number((quote as any).open ?? 0) || undefined,
      previousClose: Number((quote as any).previousClose ?? 0) || undefined,
      updatedAt: String((quote as any).updatedAt ?? new Date().toISOString()),
      rating: scoreToRating(overall),
      exchange: String((entry as any).exchange ?? ''),
    };
  } catch {
    return null;
  }
}

function sma(v: number[], p: number, i: number): number {
  if (i + 1 < p) return NaN;

  let s = 0;
  for (let k = i - p + 1; k <= i; k++) s += v[k];

  return s / p;
}

function rsi14(closes: number[]): number {
  const n = closes.length;
  if (n < 15) return NaN;

  let gain = 0;
  let loss = 0;

  for (let i = n - 14; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }

  if (loss === 0) return 100;

  const rs = gain / 14 / (loss / 14);
  return 100 - 100 / (1 + rs);
}

function computeSignals(candles: Candle[]): string[] {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const n = closes.length;
  const chips: string[] = [];

  if (n < 25) return chips;

  const i = n - 1;
  const s5 = sma(closes, 5, i);
  const s20 = sma(closes, 20, i);
  const p5 = sma(closes, 5, i - 1);
  const p20 = sma(closes, 20, i - 1);

  if (p5 <= p20 && s5 > s20) chips.push('골든크로스');
  else if (p5 >= p20 && s5 < s20) chips.push('데드크로스');
  else if (s5 > s20) chips.push('정배열 상승추세');

  const avgVol = vols.slice(n - 21, n - 1).reduce((a, b) => a + b, 0) / 20;
  if (avgVol > 0 && vols[i] > avgVol * 1.5) chips.push('거래량 급증');

  const r = rsi14(closes);
  if (r <= 30) chips.push('RSI 과매도');
  else if (r >= 70) chips.push('RSI 과매수');

  return chips;
}

function roundPrice(v: number, currency: string): number {
  return currency === 'KRW' ? Math.round(v) : Math.round(v * 100) / 100;
}

function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const recent = candles.slice(-period);
  const start = candles.length - period;

  const trs = recent.map((c, i) => {
    const prev = candles[start + i - 1];

    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close),
    );
  });

  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function supportResistance(candles: Candle[], price: number) {
  const recent = candles.slice(-60);
  const lows = recent.map((c) => c.low).filter((v) => v < price);
  const highs = recent.map((c) => c.high).filter((v) => v > price);

  return {
    support: lows.length ? Math.max(...lows) : null,
    resistance: highs.length ? Math.min(...highs) : null,
    recentHigh: recent.length ? Math.max(...recent.map((c) => c.high)) : null,
    recentLow: recent.length ? Math.min(...recent.map((c) => c.low)) : null,
  };
}

function targetStopRates(rating: Rating, assetType: AssetType) {
  const etfLike = isEtf(assetType) || isEtnAsset(assetType);
  const highRiskEtf = isLeveraged(assetType) || isInverse(assetType);

  if (highRiskEtf) {
    return { maxTargetRate: 0.05, maxStopRate: 0.035 };
  }

  if (etfLike) {
    return { maxTargetRate: 0.08, maxStopRate: 0.05 };
  }

  if (rating === 'STRONG_BUY') {
    return { maxTargetRate: 0.1, maxStopRate: 0.065 };
  }

  if (rating === 'BUY') {
    return { maxTargetRate: 0.08, maxStopRate: 0.055 };
  }

  if (rating === 'HOLD') {
    return { maxTargetRate: 0.05, maxStopRate: 0.045 };
  }

  return { maxTargetRate: 0.035, maxStopRate: 0.035 };
}

function levels(
  price: number,
  rating: Rating,
  currency: string,
  assetType: AssetType,
  candles: Candle[] = [],
) {
  const a = atr(candles);
  const sr = supportResistance(candles, price);
  const { maxTargetRate, maxStopRate } = targetStopRates(rating, assetType);

  const atrTake1 = a ? price + a * 1.2 : price * (1 + maxTargetRate * 0.45);
  const atrTake2 = a ? price + a * 2.0 : price * (1 + maxTargetRate);
  const atrStop = a ? price - a * 1.1 : price * (1 - maxStopRate);

  const rawTake1 = sr.resistance ?? atrTake1;
  const rawTake2 =
    sr.recentHigh && sr.recentHigh > price ? sr.recentHigh : atrTake2;
  const rawStop = sr.support ?? sr.recentLow ?? atrStop;

  const cappedTake1 = Math.min(rawTake1, price * (1 + maxTargetRate * 0.65));
  const cappedTake2 = Math.min(rawTake2, price * (1 + maxTargetRate));
  const cappedStop = Math.max(rawStop, price * (1 - maxStopRate));

  return {
    entry: roundPrice(price, currency),
    take1: roundPrice(Math.max(cappedTake1, price * 1.01), currency),
    take2: roundPrice(Math.max(cappedTake2, price * 1.02), currency),
    stop: roundPrice(Math.min(cappedStop, price * 0.995), currency),
  };
}
function riskOf(
  assetType: AssetType,
  changePercent: number,
): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (isLeveraged(assetType) || isInverse(assetType)) return 'HIGH';

  const v = Math.abs(changePercent);
  if (v >= 5) return 'HIGH';
  if (v >= 2) return 'MEDIUM';

  return 'LOW';
}

function reasonFor(row: QuoteRow): string {
  if (row.signals?.length) return row.signals.slice(0, 3).join(' · ');

  const label = RATING_LABEL[row.rating.rating];
  const parts: string[] = [];

  if (isEtf(row.assetType)) {
    parts.push('ETF 차트 기준 평가');
  } else if (isEtnAsset(row.assetType)) {
    parts.push('ETN 변동성 기준 평가');
  }

  if (row.changePercent >= 3) parts.push('강한 상승 흐름');
  else if (row.changePercent > 0) parts.push('상승 전환');
  else if (row.changePercent <= -3) parts.push('낙폭 확대');
  else if (row.changePercent < 0) parts.push('약세 흐름');
  else parts.push('보합권');

  parts.push(`AI ${row.rating.score}점 · ${label}`);

  return parts.join(' · ');
}

async function enrichRecommended(row: QuoteRow): Promise<QuoteRow> {
  let signals: string[] = [];
  let candles: Candle[] = [];

  try {
    candles = await MarketDataService.getCandles(row.ticker, '1D');
    signals = computeSignals(candles);
  } catch {
    // best-effort
  }

  const lv = levels(
    row.price,
    row.rating.rating,
    row.currency,
    row.assetType,
    candles,
  );

  const enriched: QuoteRow = {
    ...row,
    signals,
    ...lv,
    riskLevel: riskOf(row.assetType, row.changePercent),
  };

  enriched.reason = reasonFor(enriched);

  return enriched;
}

async function getMarketListings(market: MarketKey): Promise<MarketListings> {
  return cached(`listing:v5:${market}`, TTL.quote, async () => {
    const candidates = await buildCandidates(market);

    let rows = (await Promise.all(candidates.map(toRow))).filter(
      (r): r is QuoteRow => r !== null,
    );

    if (market === 'NASDAQ' || market === 'NYSE' || market === 'AMEX') {
      rows = rows.filter((r) => r.exchange === market);
    }

    const popular = rows.slice(0, MAX).map((r) => ({
      ...r,
      reason: reasonFor(r),
    }));

    const gainers = [...rows]
      .filter((r) => r.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, MAX)
      .map((r) => ({ ...r, reason: reasonFor(r) }));

    const losers = [...rows]
      .filter((r) => r.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, MAX)
      .map((r) => ({ ...r, reason: reasonFor(r) }));

    const topByScore = [...rows]
      .sort((a, b) => b.rating.score - a.rating.score)
      .slice(0, 12);

    const recommended = await Promise.all(topByScore.map(enrichRecommended));

    return { market, popular, gainers, losers, recommended };
  });
}

// ---- Undervalued ------------------------------------------------------------

export interface UndervaluedCard {
  ticker: string;
  name: string;
  market: 'US' | 'KR';
  currency: 'USD' | 'KRW';
  price: number;
  changePercent: number;
  score: number;
  per: number | null;
  pbr: number | null;
  roe: number | null;
  debtRatio: number | null;
  reasons: string[];
  risks: string[];
  entry: number;
  stop: number;
  target: number;
  dataQuality: 'ok' | 'partial' | 'insufficient';
}

function num(v: number | undefined | null): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : null;
}

async function undervaluedCard(entry: CatalogEntry): Promise<UndervaluedCard | null> {
  const assetType = assetTypeOf(entry);

  // ETF/ETN은 재무제표 저평가 계산 제외
  if (isEtf(assetType) || isEtnAsset(assetType)) {
    return null;
  }

  const [fin, quoteRow] = await Promise.all([
    FinancialService.getFinancials(entry.ticker).catch(() => null),
    toRow(entry),
  ]);

  if (!quoteRow) return null;

  const per = num(fin?.ratios?.per);
  const pbr = num(fin?.ratios?.pbr);
  const roe = num(fin?.ratios?.roe);
  const debtRatio = num(fin?.ratios?.debtRatio);
  const cash = num(fin?.cashBurn?.cashBalance);
  const revGrowth = fin?.growth?.revenue?.length
    ? fin.growth.revenue[fin.growth.revenue.length - 1]
    : null;
  const profitGrowth = fin?.growth?.profit?.length
    ? fin.growth.profit[fin.growth.profit.length - 1]
    : null;

  const reasons: string[] = [];
  const risks: string[] = [];
  let strength = 0;
  let weight = 0;

  const add = (w: number, s: number) => {
    strength += w * s;
    weight += w;
  };

  if (per != null) {
    if (per > 0 && per < 10) {
      add(1, 1);
      reasons.push(`저PER ${per.toFixed(1)}배`);
    } else if (per > 0 && per < 15) {
      add(1, 0.6);
      reasons.push(`PER ${per.toFixed(1)}배 (합리적)`);
    } else if (per > 0) {
      add(1, 0.1);
    }

    if (per <= 0) risks.push('적자 또는 PER 산정 불가');
  }

  if (pbr != null) {
    if (pbr > 0 && pbr < 1) {
      add(1, 1);
      reasons.push(`저PBR ${pbr.toFixed(2)}배 (청산가치 이하)`);
    } else if (pbr > 0 && pbr < 1.5) {
      add(1, 0.6);
      reasons.push(`PBR ${pbr.toFixed(2)}배`);
    } else if (pbr > 0) {
      add(1, 0.1);
    }
  }

  if (roe != null) {
    if (roe >= 15) {
      add(1, 1);
      reasons.push(`우수한 ROE ${roe.toFixed(1)}%`);
    } else if (roe >= 8) {
      add(1, 0.7);
      reasons.push(`양호한 ROE ${roe.toFixed(1)}%`);
    } else if (roe >= 0) {
      add(1, 0.3);
    } else {
      add(1, 0);
      risks.push(`마이너스 ROE ${roe.toFixed(1)}%`);
    }
  }

  if (debtRatio != null) {
    if (debtRatio < 80) {
      add(0.8, 1);
      reasons.push(`낮은 부채비율 ${debtRatio.toFixed(0)}%`);
    } else if (debtRatio < 150) {
      add(0.8, 0.5);
    } else {
      add(0.8, 0.1);
      risks.push(`높은 부채비율 ${debtRatio.toFixed(0)}%`);
    }
  }

  if (cash != null && cash > 0) {
    add(0.5, 1);
    reasons.push('현금 보유 양호');
  }

  if (revGrowth != null) {
    if (revGrowth > 0) {
      add(0.6, 1);
      reasons.push(`매출 성장 +${revGrowth.toFixed(1)}%`);
    } else {
      add(0.6, 0.2);
      risks.push(`매출 역성장 ${revGrowth.toFixed(1)}%`);
    }
  }

  if (profitGrowth != null && profitGrowth > 0) {
    add(0.6, 1);
    reasons.push(`이익 개선 +${profitGrowth.toFixed(1)}%`);
  } else if (profitGrowth != null && profitGrowth < 0) {
    risks.push(`이익 감소 ${profitGrowth.toFixed(1)}%`);
  }

  if (weight === 0) return null;

  const score = Math.round((strength / weight) * 100);
  const factorsSeen = [per, pbr, roe, debtRatio].filter((v) => v != null).length;

  const dataQuality: UndervaluedCard['dataQuality'] =
    factorsSeen >= 3 ? 'ok' : factorsSeen >= 1 ? 'partial' : 'insufficient';

  if (risks.length === 0) risks.push('재무상 특이 리스크 미확인');

  let candles: Candle[] = [];
  try {
    candles = await MarketDataService.getCandles(quoteRow.ticker, '1D');
  } catch {
    // fallback
  }

  const lv = levels(
    quoteRow.price,
    quoteRow.rating.rating,
    quoteRow.currency,
    quoteRow.assetType,
    candles,
  );

  return {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market,
    currency: entry.currency,
    price: quoteRow.price,
    changePercent: quoteRow.changePercent,
    score,
    per,
    pbr,
    roe,
    debtRatio,
    reasons,
    risks,
    entry: lv.entry,
    stop: lv.stop,
    target: lv.take2,
    dataQuality,
  };
}

const UNDERVALUED_CAP = 30;

async function getUndervalued(
  market: MarketKey,
): Promise<{ market: MarketKey; cards: UndervaluedCard[] }> {
  return cached(`undervalued:v5:${market}`, TTL.quote, async () => {
    const candidates = (await buildCandidates(market)).slice(0, UNDERVALUED_CAP);

    const cards = (
      await Promise.all(candidates.map((c) => undervaluedCard(c).catch(() => null)))
    )
      .filter((c): c is UndervaluedCard => c !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX);

    return { market, cards };
  });
}

// ---- Sector strength --------------------------------------------------------

function aggregateSectors(
  rows: QuoteRow[],
): { sector: string; changePercent: number; count: number }[] {
  const map = new Map<string, { sum: number; count: number }>();

  for (const r of rows) {
    const sector = SECTOR_MAP[r.ticker];
    if (!sector) continue;

    const cur = map.get(sector) ?? { sum: 0, count: 0 };
    cur.sum += r.changePercent;
    cur.count += 1;
    map.set(sector, cur);
  }

  return Array.from(map.entries())
    .filter(([, v]) => v.count >= 1)
    .map(([sector, v]) => ({
      sector,
      changePercent: Math.round((v.sum / v.count) * 100) / 100,
      count: v.count,
    }))
    .sort((a, b) => b.changePercent - a.changePercent);
}

// ---- AI briefing ------------------------------------------------------------

export interface BriefingNews {
  ticker: string;
  name: string;
  title: string;
  url: string;
}

export interface BriefingRisk {
  ticker: string;
  name: string;
  level: 'MEDIUM' | 'HIGH';
  label: string;
}

export interface Briefing {
  asOf: string;
  mood: 'positive' | 'neutral' | 'negative';
  headline: string;
  lines: string[];
  strongSectors: { sector: string; changePercent: number; count: number }[];
  weakSectors: { sector: string; changePercent: number; count: number }[];
  positiveNews: BriefingNews[];
  negativeNews: BriefingNews[];
  disclosureRisks: BriefingRisk[];
  gainers: { ticker: string; name: string; changePercent: number }[];
  losers: { ticker: string; name: string; changePercent: number }[];
  picks: { ticker: string; name: string; rating: Rating; score: number }[];
}

function moodOf(avg: number): Briefing['mood'] {
  if (avg >= 0.4) return 'positive';
  if (avg <= -0.4) return 'negative';
  return 'neutral';
}

async function getBriefing(): Promise<Briefing> {
  return cached('briefing:v5', TTL.quote, async () => {
    const [summary, kr, us] = await Promise.all([
      getMarketSummary(),
      getMarketListings('KRX'),
      getMarketListings('NASDAQ'),
    ]);

    const byKey = (k: string) => summary.find((s) => s.key === k);
    const kospi = byKey('kospi');
    const kosdaq = byKey('kosdaq');
    const nasdaq = byKey('nasdaq');
    const sp = byKey('sp500');

    const changes = [kospi, nasdaq, sp]
      .filter((s): s is SummaryItem => !!s && s.ok)
      .map((s) => s.changePercent);

    const avg = changes.length
      ? changes.reduce((a, b) => a + b, 0) / changes.length
      : 0;

    const mood = moodOf(avg);

    const pct = (s?: SummaryItem) =>
      s && s.ok
        ? `${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%`
        : '—';

    const lines: string[] = [];

    if (kospi) lines.push(`코스피 ${pct(kospi)} · 코스닥 ${pct(kosdaq)}`);
    if (nasdaq) lines.push(`나스닥 ${pct(nasdaq)} · S&P500 ${pct(sp)}`);

    const vix = byKey('vix');
    const usdkrw = byKey('usdkrw');

    if (vix) {
      lines.push(
        `VIX ${vix.ok ? vix.price.toFixed(1) : '—'} · 원/달러 ${
          usdkrw?.ok
            ? Math.round(usdkrw.price).toLocaleString('ko-KR')
            : '—'
        }원`,
      );
    }

    const headline =
      mood === 'positive'
        ? '위험 선호 우위 · 지수 상승 흐름'
        : mood === 'negative'
          ? '위험 회피 우위 · 지수 하락 압력'
          : '혼조세 · 방향성 탐색 구간';

    const sectorRows = [
      ...kr.popular,
      ...kr.gainers,
      ...kr.losers,
      ...us.popular,
      ...us.gainers,
      ...us.losers,
    ];

    const bySector = new Map<string, QuoteRow>();
    for (const r of sectorRows) {
      if (!bySector.has(r.ticker)) bySector.set(r.ticker, r);
    }

    const sectors = aggregateSectors(Array.from(bySector.values()));
    const strongSectors = sectors.filter((s) => s.changePercent > 0).slice(0, 4);
    const weakSectors = sectors.filter((s) => s.changePercent < 0).reverse().slice(0, 4);

    const picksRows = [...kr.recommended, ...us.recommended]
      .sort((a, b) => b.rating.score - a.rating.score)
      .slice(0, 4);

    const positiveNews: BriefingNews[] = [];
    const negativeNews: BriefingNews[] = [];
    const disclosureRisks: BriefingRisk[] = [];

    const enrich = await Promise.allSettled(
      picksRows.map(async (r) => {
        const [news, risk] = await Promise.all([
          NewsService.getNews(r.ticker).catch(() => null),
          RiskAnalysisService.getRisk(r.ticker).catch(() => null),
        ]);

        return { r, news, risk };
      }),
    );

    for (const e of enrich) {
      if (e.status !== 'fulfilled') continue;

      const { r, news, risk } = e.value;

      if (news?.positive?.[0]) {
        positiveNews.push({
          ticker: r.ticker,
          name: r.name,
          title: news.positive[0].title,
          url: news.positive[0].url,
        });
      }

      if (news?.negative?.[0]) {
        negativeNews.push({
          ticker: r.ticker,
          name: r.name,
          title: news.negative[0].title,
          url: news.negative[0].url,
        });
      }

      if (risk && (risk.overallLevel === 'HIGH' || risk.overallLevel === 'MEDIUM')) {
        const top = risk.items?.[0];

        disclosureRisks.push({
          ticker: r.ticker,
          name: r.name,
          level: risk.overallLevel,
          label: top?.label ?? '공시 위험',
        });
      }
    }

    return {
      asOf: new Date().toISOString(),
      mood,
      headline,
      lines,
      strongSectors,
      weakSectors,
      positiveNews: positiveNews.slice(0, 3),
      negativeNews: negativeNews.slice(0, 3),
      disclosureRisks: disclosureRisks.slice(0, 3),
      gainers: kr.gainers.slice(0, 4).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        changePercent: r.changePercent,
      })),
      losers: kr.losers.slice(0, 4).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        changePercent: r.changePercent,
      })),
      picks: picksRows.slice(0, 3).map((r) => ({
        ticker: r.ticker,
        name: r.name,
        rating: r.rating.rating,
        score: r.rating.score,
      })),
    };
  });
}

export const MarketListingService = {
  getMarketSummary,
  getMarketListings,
  getBriefing,
  getUndervalued,
};