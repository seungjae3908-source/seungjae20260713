import { authorizedFetch } from '@/lib/auth-fetch';
import type { StockGrade } from '@workspace/stock-grade';

export type { StockGrade };

export type Market = 'US' | 'KR';
export type Currency = 'USD' | 'KRW';
export type Rating = 'STRONG_BUY' | 'BUY' | 'HOLD' | 'SELL' | 'STRONG_SELL';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type HealthLevel = 'STRONG' | 'AVERAGE' | 'WEAK';
export type SignalTone = 'positive' | 'neutral' | 'negative';

export type Timeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '60m'
  | '4H'
  | '1D'
  | '3D'
  | '5D'
  | '1W'
  | '1M';

export type ChartFrameInput =
  | Timeframe
  | '1h'
  | '4h'
  | '1d'
  | '3d'
  | '5d'
  | '1w'
  | '1mo';

export interface RatingResult {
  rating: Rating;
  confidence: number;
  score: number;
}

export type AssetType =
  | 'STOCK'
  | 'ETF'
  | 'ETN'
  | 'LEVERAGED_ETF'
  | 'INVERSE_ETF'
  | 'LEVERAGED_ETN'
  | 'INVERSE_ETN'
  | 'REIT'
  | 'ADR';

export interface SearchResult {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  assetType?: AssetType;
}

export interface QuoteRow extends SearchResult {
  price: number;
  changePercent: number;
  rating: RatingResult;
  grade?: StockGrade;
  reason?: string;
  exchange?: string;
  signals?: string[];
  entry?: number;
  take1?: number;
  take2?: number;
  stop?: number;
  riskLevel?: RiskLevel;
  volume?: number;
  tradingValue?: number;
  per?: number | null;
  pbr?: number | null;
  roe?: number | null;
  debtRatio?: number | null;
}

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

export interface SummaryItem {
  key: string;
  label: string;
  price: number;
  changePercent: number;
  spark: number[];
  unit: 'index' | 'krw' | 'usd';
  ok: boolean;
}

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

export interface UndervaluedCard {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
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

export interface UndervaluedData {
  market: MarketKey;
  cards: UndervaluedCard[];
}

export interface MarketAlert {
  id: string;
  ticker: string;
  name: string;
  market: Market;
  kind: 'positive' | 'negative';
  category: string;
  title: string;
  importance: 'high' | 'medium' | 'low';
  time: string;
  url: string | null;
}

export interface AlertFeed {
  positive: MarketAlert[];
  negative: MarketAlert[];
}

export interface Quote {
  price: number;
  changeAmount: number;
  changePercent: number;
  volume: number;
  marketCap: number;
  week52High: number;
  week52Low: number;
}

export interface CompanyProfile {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  description: string;
  industry: string;
  sector: string;
  country: string;
  mainBusiness: string;
  competitors: string[];
}

export interface RiskFactorSummary {
  label: string;
  level: RiskLevel;
  detail: string;
}

export interface Overview {
  profile: CompanyProfile;
  quote: Quote;
  rating: RatingResult;
  grade?: StockGrade;
  buyReasons: string[];
  riskFactors: RiskFactorSummary[];
  summary: string;
}

export interface Candle {
  time: string | number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorSeries {
  ma20: (number | null)[];
  ma60: (number | null)[];
  ma120: (number | null)[];
  ma240: (number | null)[];
  rsi: (number | null)[];
  macd: {
    macd: (number | null)[];
    signal: (number | null)[];
    hist: (number | null)[];
  };
}

export interface Signal {
  key: string;
  label: string;
  active: boolean;
  tone: SignalTone;
  detail: string;
}

export interface ChartData {
  timeframe: Timeframe;
  candles: Candle[];
  indicators: IndicatorSeries;
  signals: Signal[];
  rating: RatingResult;
}

export interface FinancialRow {
  period: string;
  revenue: number;
  operatingIncome: number;
  netIncome: number;
  cash?: number;
  debt: number;
  equity?: number;
  capital?: number;
}

export interface Financials {
  quarterly: FinancialRow[];
  annual: FinancialRow[];
  rows?: FinancialRow[];
  ratios: {
    eps: number;
    per: number;
    pbr: number;
    roe: number;
    debtRatio: number;
  };
  growth: {
    revenue: number[];
    profit: number[];
  };
  cashBurn: {
    cashBalance: number;
    quarterlyBurn: number;
    survivalQuarters: number | null;
  };
  health: {
    level: HealthLevel;
    confidence: number;
  };
}

export interface RiskItem {
  label: string;
  score: number;
  level: RiskLevel;
  explanation: string;
}

export type RiskEventType =
  | 'DELISTING'
  | 'TRADING_SUSPENSION'
  | 'DILUTION'
  | 'CONVERTIBLE_BOND'
  | 'CAPITAL_IMPAIRMENT'
  | 'GOING_CONCERN'
  | 'OTHER';

export type RiskEventStatus = 'CURRENT' | 'WATCH' | 'HISTORICAL' | 'IGNORED';

// Evidence-driven, recency-aware risk event. Emitted by the backend risk feed
// so every screen shares the same recency judgement (see requirements 15-17,19).
export interface RiskEvent {
  id: string;
  type: RiskEventType;
  label: string;
  status: RiskEventStatus;
  level: RiskLevel;
  date: string | null;
  title: string;
  summary: string;
  source: 'DART' | 'SEC' | 'NEWS' | 'SYSTEM';
  url?: string | null;
  isRecent: boolean;
  isResolved: boolean;
}

export type Sentiment = 'positive' | 'negative' | 'neutral';

export type EventType =
  | 'ATM'
  | 'OFFERING'
  | 'REVERSE_SPLIT'
  | 'CB'
  | 'BW'
  | 'RIGHTS_OFFERING'
  | 'DIVIDEND'
  | 'DELISTING'
  | 'SUPPLY_CONTRACT';

export interface Filing {
  form: string;
  date: string;
  description: string;
  url: string;
  sentiment: Sentiment;
  events: EventType[];
  eventLabels: string[];
  relatedCount?: number;
}

export interface Disclosure {
  report: string;
  date: string;
  description: string;
  url: string;
  sentiment: Sentiment;
  events: EventType[];
  eventLabels: string[];
  relatedCount?: number;
}

export interface DisclosureData {
  market: Market;
  filings: Filing[];
  disclosures: Disclosure[];
}

export interface RiskAnalysis {
  market: Market;
  items: RiskItem[];
  events?: RiskEvent[];
  overallScore: number;
  overallLevel: RiskLevel;
  explanation: string;
  filings: Filing[];
  disclosures: Disclosure[];
}

export interface NewsItem {
  title: string;
  source: string;
  sourceDomain: string;
  date: string;
  url: string;
  tone: 'positive' | 'negative' | 'neutral';
  reliability?: number;
  summary?: string;
  impact?: string;
}

export interface NewsData {
  positive: NewsItem[];
  negative: NewsItem[];
  news?: NewsItem[];
  sentimentScore: number;
}

export interface AiStrategyLeg {
  price: number;
  reason: string;
}

export interface AiStrategy {
  entry1: AiStrategyLeg;
  entry2: AiStrategyLeg;
  target: AiStrategyLeg;
  stop: AiStrategyLeg;
}

export interface AiAnalysis {
  opinion: Rating;
  opinionReason: string;
  confidence: number;
  buyReasons: string[];
  sellReasons: string[];
  shortTerm: string;
  midTerm: string;
  longTerm: string;
  targetPrice: number;
  stopLossPrice: number;
  strategy?: AiStrategy;
  conclusion: string;
  score?: number;
}

export interface AppConfig {
  providers: {
    finnhub: boolean;
    alphavantage: boolean;
    dart: boolean;
    secEdgar: boolean;
  };
  mode: 'sample' | 'live';
}

export type SignalCategory =
  | 'accumulation'
  | 'trend'
  | 'momentum'
  | 'volume'
  | 'valuation'
  | 'disclosure'
  | 'supply';

export type DataQuality = 'ok' | 'partial' | 'insufficient';

export interface AiSignal {
  key: string;
  label: string;
  category: SignalCategory;
  active: boolean;
  score: number;
  confidence: number;
  tone: SignalTone;
  reasons: string[];
  missing: string[];
  action: string;
  dataQuality: DataQuality;
}

export interface AccumulationResult {
  score: number;
  stars: number;
  label: string;
  confidence: number;
  breakoutProbability: number;
  expectedPeriod: string;
  passed: string[];
  failed: string[];
  strategy: {
    entry: string[];
    take: string[];
    stop: string[];
    caution: string[];
  };
  dataQuality: DataQuality;
}

export interface SignalReport {
  asOf: string;
  accumulation: AccumulationResult;
  signals: AiSignal[];
}

export interface ScanCard {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
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
  assetType?: AssetType;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNAVAILABLE';
  riskScore?: number | null;
  liquidity?: number | null;
  marketCap?: number | null;
  dataState?: 'ok' | 'unavailable' | 'insufficient' | 'delayed' | 'stale';
  analyzedAt?: string;
  scoreBreakdown?: Record<string, { score: number | null; status: 'ok' | 'unavailable' | 'insufficient' | 'delayed' | 'stale'; reasons: string[] }>;
}

export interface ScanResult {
  cards: ScanCard[];
  selected: string[];
  supportedIndicators?: string[];
  fetchedAt?: string;
  searchRunId?: string;
  timeframe?: string;
}

export interface Movers {
  popular: QuoteRow[];
  gainers: QuoteRow[];
  risky: QuoteRow[];
  recommended: QuoteRow[];
  /**
   * Human-readable basis of the ranking per tab (e.g. "거래대금 기준",
   * "등락률 기준", "AI 점수 기준"). Optional; degrades gracefully.
   */
  rankingSource?: {
    popular?: string;
    gainers?: string;
    losers?: string;
    recommended?: string;
  };
}

export interface ThemeStock {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number;
  changePercent: number;
  assetType?: AssetType;
}

export interface ThemeGroup {
  key: string;
  label: string;
  count: number;
  stocks: ThemeStock[];
}

export interface ThemesData {
  market: 'KR' | 'US';
  themes: ThemeGroup[];
}

export interface SectorPopularRow {
  rank: number;
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number;
  changePercent: number;
  tradingValue?: number;
  volume?: number;
}

export interface SectorPopularGroup {
  key: string;
  label: string;
  rows: SectorPopularRow[];
}

export interface SectorPopularData {
  market: 'KR' | 'US';
  sortBasis: string;
  sectors: SectorPopularGroup[];
  error?: string;
}

export interface LatestBackupResponse {
  ok: boolean;
  exists: boolean;
  schemaVersion?: number;
  localStorage?: Record<string, string>;
  itemCount?: number;
  checksum?: string;
  clientUpdatedAt?: string | null;
  updatedAt?: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

const BASE = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, '') || '/api';

const enc = encodeURIComponent;

export async function apiGet<T>(path: string): Promise<T> {
  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${separator}_ts=${Date.now()}`;
  const res = await authorizedFetch(url, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    },
  });

  if (!res.ok) {
    let code = `HTTP_${res.status}`;

    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      // ignore
    }

    throw new ApiError(res.status, code);
  }

  return (await res.json()) as T;
}

function normalizeFrame(tf: ChartFrameInput): Timeframe {
  if (tf === '1h') return '60m';
  if (tf === '4h') return '4H';
  if (tf === '1d') return '1D';
  if (tf === '3d') return '3D';
  if (tf === '5d') return '5D';
  if (tf === '1w') return '1W';
  if (tf === '1mo') return '1M';

  return tf;
}

function clampAnalysisPrice(analysis: AiAnalysis, overview: Overview): AiAnalysis {
  const price = overview.quote.price;
  const currency = overview.profile.currency;
  const name = overview.profile.name.toLowerCase();

  const isEtf =
    name.includes('etf') ||
    name.includes('etn') ||
    name.includes('tiger') ||
    name.includes('kodex') ||
    name.includes('ace') ||
    name.includes('sol') ||
    name.includes('hanaro') ||
    name.includes('arirang') ||
    name.includes('soxl') ||
    name.includes('soxs') ||
    name.includes('tqqq') ||
    name.includes('sqqq');

  const maxTargetRate = isEtf
    ? 0.08
    : analysis.opinion === 'STRONG_BUY'
      ? 0.15
      : analysis.opinion === 'BUY'
        ? 0.1
        : analysis.opinion === 'HOLD'
          ? 0.06
          : 0.04;

  const maxStopRate = isEtf
    ? 0.05
    : analysis.opinion === 'STRONG_BUY' || analysis.opinion === 'BUY'
      ? 0.08
      : analysis.opinion === 'HOLD'
        ? 0.06
        : 0.04;

  let targetPrice = analysis.targetPrice;
  let stopLossPrice = analysis.stopLossPrice;

  if (
    !Number.isFinite(targetPrice) ||
    targetPrice <= price ||
    targetPrice > price * (1 + maxTargetRate)
  ) {
    targetPrice = price * (1 + maxTargetRate);
  }

  if (
    !Number.isFinite(stopLossPrice) ||
    stopLossPrice >= price ||
    stopLossPrice < price * (1 - maxStopRate)
  ) {
    stopLossPrice = price * (1 - maxStopRate);
  }

  const round = (value: number) =>
    currency === 'KRW' ? Math.round(value) : Math.round(value * 100) / 100;

  return {
    ...analysis,
    targetPrice: round(targetPrice),
    stopLossPrice: round(stopLossPrice),
  };
}

export const api = {
  config: () => apiGet<AppConfig>('/config'),

  search: (q: string) =>
    apiGet<{ results: SearchResult[] }>(`/search?q=${enc(q)}`),

  // Full-universe search enriched with live quote + rating so results can show
  // name / ticker / market / price / changePercent / grade regardless of the
  // currently selected category.
  searchRows: (q: string) =>
    apiGet<{ results: QuoteRow[] }>(`/search/quotes?q=${enc(q)}`),

  movers: (market?: MarketKey) =>
    apiGet<Movers>(`/market/movers${market ? `?market=${market}` : ''}`),

  summary: () => apiGet<{ items: SummaryItem[] }>('/market/summary'),

  briefing: () => apiGet<Briefing>('/market/briefing'),

  undervalued: (market: MarketKey) =>
    apiGet<UndervaluedData>(`/market/undervalued?market=${market}`),

  alertFeed: (market: 'ALL' | 'KR' | 'US') =>
    apiGet<AlertFeed>(`/market/alerts?market=${market}`),

  quotes: (tickers: string[]) =>
    apiGet<{ quotes: QuoteRow[] }>(
      `/quotes?tickers=${enc(tickers.join(','))}`,
    ),

  overview: (ticker: string) =>
    apiGet<Overview>(`/stocks/${enc(ticker)}/overview`),

  chart: (ticker: string, timeframe: ChartFrameInput) =>
    apiGet<ChartData>(
      `/stocks/${enc(ticker)}/chart?tf=${enc(normalizeFrame(timeframe))}`,
    ),

  financials: (ticker: string) =>
    apiGet<Financials>(`/stocks/${enc(ticker)}/financials`),

  risk: (ticker: string) =>
    apiGet<RiskAnalysis>(`/stocks/${enc(ticker)}/risk`),

  disclosures: (ticker: string) =>
    apiGet<DisclosureData>(`/stocks/${enc(ticker)}/disclosures`),

  news: (ticker: string) =>
    apiGet<NewsData>(`/stocks/${enc(ticker)}/news`),

  analysis: async (ticker: string) => {
    const [analysis, overview] = await Promise.all([
      apiGet<AiAnalysis>(`/stocks/${enc(ticker)}/analysis`),
      apiGet<Overview>(`/stocks/${enc(ticker)}/overview`),
    ]);

    return clampAnalysisPrice(analysis, overview);
  },

  signals: (ticker: string) =>
    apiGet<SignalReport>(`/stocks/${enc(ticker)}/signals`),

  scan: (
    indicators: string[],
    market: string,
    opts?: { volumeThreshold?: number; tradingValueThreshold?: number; marketCapThreshold?: number; minimumScore?: number; maximumRiskScore?: number; volumeLookbackDays?: number; tradingValueLookbackDays?: number; timeframe?: string },
  ) => {
    const params = new URLSearchParams({
      indicators: indicators.join(','),
      market,
    });
    if (opts?.volumeThreshold != null)
      params.set('volumeThreshold', String(opts.volumeThreshold));
    if (opts?.tradingValueThreshold != null)
      params.set('tradingValueThreshold', String(opts.tradingValueThreshold));
    if (opts?.marketCapThreshold != null)
      params.set('marketCapThreshold', String(opts.marketCapThreshold));
    if (opts?.minimumScore != null) params.set('minimumScore', String(opts.minimumScore));
    if (opts?.maximumRiskScore != null) params.set('maximumRiskScore', String(opts.maximumRiskScore));
    if (opts?.volumeLookbackDays != null)
      params.set('volumeLookbackDays', String(opts.volumeLookbackDays));
    if (opts?.tradingValueLookbackDays != null)
      params.set('tradingValueLookbackDays', String(opts.tradingValueLookbackDays));
    if (opts?.timeframe) params.set('timeframe', opts.timeframe);
    return apiGet<ScanResult>(`/market/scan?${params.toString()}`);
  },

  themes: (market: 'KR' | 'US') =>
    apiGet<ThemesData>(`/market/themes?market=${market}`),

  sectorPopular: (market: 'KR' | 'US') =>
    apiGet<SectorPopularData>(`/market/sector-popular?market=${market}`),

  pushSubscribe: (subscription: unknown) =>
    authorizedFetch(`${BASE}/push/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(subscription),
    }).then((res) => res.json()),

  pushUnsubscribe: (endpoint: string) =>
    authorizedFetch(`${BASE}/push/unsubscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint }),
    }).then((res) => res.json()),

  pushTest: (endpoint?: string) =>
    authorizedFetch(`${BASE}/push/test`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoint }),
    }).then((res) => res.json()),

  backupLatest: () => apiGet<LatestBackupResponse>('/backup/latest'),

  saveLatestBackup: async (payload: {
    schemaVersion: number;
    localStorage: Record<string, string>;
    clientUpdatedAt: string;
  }) => {
    const res = await authorizedFetch(`${BASE}/backup/latest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as LatestBackupResponse & { error?: string };
    if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP_${res.status}`);
    return body;
  },
};
