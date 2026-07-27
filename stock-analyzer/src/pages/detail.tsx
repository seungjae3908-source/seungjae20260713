import { authorizedFetch } from "@/lib/auth-fetch";
import { useMemberPermissions } from "@/lib/permissions";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  ChevronDown,
  Maximize2,
  Minimize2,
  Settings2,
} from "lucide-react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { BottomNav } from "@/components/bottom-nav";
import { PriceAlertCard } from "@/components/price-alert-card";
import { buildAiInsights } from "@/lib/ai-insights";
import {
  displayStockName,
  eventLabelKo,
  formatAppPercent,
  formatAppPrice,
  isInWatchlist,
  summarizeText,
  toggleWatchlistItem,
  translateMarketText,
} from "@/lib/stock-display";
import { stockClassBadgeClass } from "@/lib/stock-classifier";
import { cn } from "@/lib/utils";
import { getAutoTradeSignal } from "@/lib/auto-trading";
import {
  getPortfolioChartOverlay,
  type PortfolioChartOverlay,
} from "@/lib/portfolio-overlay";
import {
  getStudyChartFocus,
  type StudyChartFocus,
  type StudyMarkerStrategy,
} from "@/lib/study-chart";

type AnyObj = Record<string, any>;
type Market = "KR" | "US";
type Currency = "KRW" | "USD";
type DetailTab =
  | "overview"
  | "ai"
  | "chart"
  | "financials"
  | "filings"
  | "news";
type ChartTimeframe =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1H"
  | "4H"
  | "1D"
  | "3D"
  | "5D"
  | "10D"
  | "1M"
  | "1Y"
  | "ALL";
type FinancialPeriod = "annual" | "quarterly";
type Tone = "positive" | "negative" | "neutral";
type RiskLabel = "낮음" | "보통" | "높음" | "매우 높음";
type FinancialMetricKey = "roe" | "pbr" | "per" | "psr";

interface DetailData {
  ticker: string;
  quote: AnyObj | null;
  company: AnyObj | null;
  candles: AnyObj[];
  financials: AnyObj | null;
  risk: AnyObj | null;
  filings: AnyObj[];
  news: AnyObj[];
}

interface CandlePoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CoreMetrics {
  fairPrice: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  riskLabel: RiskLabel;
  riskCaption: string;
}

interface FinancialMetric {
  key: FinancialMetricKey;
  label: string;
  valueText: string;
  status: string;
  tone: Tone;
  meaning: string;
  interpretation: string;
  caution: string;
}

interface ChartStats {
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  sma5: number | null;
  sma20: number | null;
  volumeRatio: number | null;
  trend: string;
}

const TABS: Array<{ key: DetailTab; label: string }> = [
  { key: "overview", label: "개요" },
  { key: "ai", label: "AI분석" },
  { key: "chart", label: "차트" },
  { key: "financials", label: "재무제표" },
  { key: "filings", label: "공시" },
  { key: "news", label: "뉴스" },
];

const TIMEFRAMES: Array<{ key: ChartTimeframe; label: string }> = [
  { key: "1m", label: "1분봉" },
  { key: "3m", label: "3분봉" },
  { key: "5m", label: "5분봉" },
  { key: "15m", label: "15분봉" },
  { key: "30m", label: "30분봉" },
  { key: "1H", label: "1시간봉" },
  { key: "4H", label: "4시간봉" },
  { key: "1D", label: "1일봉" },
  { key: "3D", label: "3일봉" },
  { key: "5D", label: "5일봉" },
  { key: "10D", label: "10일봉" },
  { key: "1M", label: "1달봉" },
  { key: "1Y", label: "1년봉" },
  { key: "ALL", label: "전체" },
];

interface ChartIndicatorSettings {
  sma5: boolean;
  sma20: boolean;
  sma60: boolean;
  sma120: boolean;
  volume: boolean;
  priceGrid: boolean;
  bollinger: boolean;
  vwap: boolean;
  rsi: boolean;
  macd: boolean;
  stochastic: boolean;
  ichimoku: boolean;
  atr: boolean;
  cci: boolean;
  obv: boolean;
  williamsR: boolean;
  roc: boolean;
}

const DEFAULT_CHART_INDICATORS: ChartIndicatorSettings = {
  sma5: true,
  sma20: true,
  sma60: false,
  sma120: false,
  volume: true,
  priceGrid: true,
  bollinger: false,
  vwap: false,
  rsi: false,
  macd: false,
  stochastic: false,
  ichimoku: false,
  atr: false,
  cci: false,
  obv: false,
  williamsR: false,
  roc: false,
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Number(
      value
        .replace(/,/g, "")
        .replace(/%/g, "")
        .replace(/[₩$원배]/g, "")
        .trim(),
    );

    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed != null) return parsed;
  }

  return null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return null;
}

function isKrTicker(ticker: string): boolean {
  return /^\d/.test(ticker);
}

function marketOf(
  ticker: string,
  quote?: AnyObj | null,
  company?: AnyObj | null,
): Market {
  if (quote?.market === "US" || company?.market === "US") return "US";
  if (quote?.market === "KR" || company?.market === "KR") return "KR";

  return isKrTicker(ticker) ? "KR" : "US";
}

function currencyOf(market: Market, quote?: AnyObj | null): Currency {
  if (quote?.currency === "USD") return "USD";
  if (quote?.currency === "KRW") return "KRW";

  return market === "US" ? "USD" : "KRW";
}

async function tryJson<T>(urls: string[], fallback: T): Promise<T> {
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await authorizedFetch(url, {
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) continue;

      return (await response.json()) as T;
    } catch {
      // 다음 API 주소를 시도합니다.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  return fallback;
}

function normalizeQuote(ticker: string, data: AnyObj): AnyObj | null {
  if (Array.isArray(data?.quotes)) {
    return (
      data.quotes.find(
        (item: AnyObj) => String(item.ticker ?? "").toUpperCase() === ticker,
      ) ??
      data.quotes[0] ??
      null
    );
  }

  if (data?.quote) return data.quote;
  if (data?.ticker || data?.price) return data;

  return null;
}

function normalizeObject(data: AnyObj, keys: string[]): AnyObj | null {
  for (const key of keys) {
    const value = data?.[key];

    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value;
    }
  }

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).length > 0
  ) {
    return data;
  }

  return null;
}

function uniqueItems(
  items: AnyObj[],
  keyOf: (item: AnyObj) => string,
): AnyObj[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = keyOf(item);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function collectFilings(data: AnyObj): AnyObj[] {
  const nested = data?.data && typeof data.data === "object" ? data.data : {};

  return uniqueItems(
    [
      ...(Array.isArray(data?.filings) ? data.filings : []),
      ...(Array.isArray(data?.disclosures) ? data.disclosures : []),
      ...(Array.isArray(data?.items) ? data.items : []),
      ...(Array.isArray(nested?.filings) ? nested.filings : []),
      ...(Array.isArray(nested?.disclosures) ? nested.disclosures : []),
      ...(Array.isArray(nested?.items) ? nested.items : []),
      ...(Array.isArray(data?.data) ? data.data : []),
    ],
    (item) =>
      `${item.rcept_no ?? item.accessionNumber ?? item.url ?? ""}:${
        item.title ?? item.report_nm ?? item.report ?? item.form ?? ""
      }`,
  );
}

function collectNews(data: AnyObj): AnyObj[] {
  const nested = data?.data && typeof data.data === "object" ? data.data : {};

  return uniqueItems(
    [
      ...(Array.isArray(data?.news) ? data.news : []),
      ...(Array.isArray(data?.positive) ? data.positive : []),
      ...(Array.isArray(data?.negative) ? data.negative : []),
      ...(Array.isArray(data?.items) ? data.items : []),
      ...(Array.isArray(nested?.news) ? nested.news : []),
      ...(Array.isArray(nested?.articles) ? nested.articles : []),
      ...(Array.isArray(nested?.items) ? nested.items : []),
      ...(Array.isArray(data?.articles) ? data.articles : []),
      ...(Array.isArray(data?.data) ? data.data : []),
    ],
    (item) =>
      `${item.url ?? item.link ?? item.articleUrl ?? ""}:${
        item.title ?? item.headline ?? ""
      }`,
  );
}

interface DetailIdentityData {
  quote: AnyObj | null;
  company: AnyObj | null;
}

interface DetailAdvancedData {
  financials: AnyObj | null;
  risk: AnyObj | null;
  filings: AnyObj[];
  news: AnyObj[];
}

function collectCandleRows(candlesRaw: AnyObj): AnyObj[] {
  return Array.isArray(candlesRaw?.candles)
    ? candlesRaw.candles
    : Array.isArray(candlesRaw?.data?.candles)
      ? candlesRaw.data.candles
      : Array.isArray(candlesRaw?.items)
        ? candlesRaw.items
        : Array.isArray(candlesRaw)
          ? candlesRaw
          : [];
}

async function fetchDetailCore(ticker: string): Promise<DetailData> {
  const upper = ticker.toUpperCase();
  const candlesRaw = await tryJson<AnyObj>(
    [`/api/stocks/${upper}/candles?tf=1D`],
    {},
  );

  return {
    ticker: upper,
    quote: null,
    company: null,
    candles: collectCandleRows(candlesRaw),
    financials: null,
    risk: null,
    filings: [],
    news: [],
  };
}

async function fetchDetailIdentity(
  ticker: string,
): Promise<DetailIdentityData> {
  const upper = ticker.toUpperCase();
  const [quoteRaw, companyRaw] = await Promise.all([
    tryJson<AnyObj>(
      [`/api/quotes?tickers=${upper}`, `/api/stocks/${upper}/quote`],
      {},
    ),
    tryJson<AnyObj>(
      [`/api/stocks/${upper}/company`, `/api/stocks/${upper}/profile`],
      {},
    ),
  ]);

  return {
    quote: normalizeQuote(upper, quoteRaw),
    company: normalizeObject(companyRaw, ["company", "profile", "data"]),
  };
}

async function fetchDetailAdvanced(
  ticker: string,
): Promise<DetailAdvancedData> {
  const upper = ticker.toUpperCase();
  const [financialRaw, riskRaw, filingsRaw, newsRaw] = await Promise.all([
    tryJson<AnyObj>([`/api/stocks/${upper}/financials`], {}),
    tryJson<AnyObj>(
      [`/api/stocks/${upper}/risk`, `/api/stocks/${upper}/analysis`],
      {},
    ),
    tryJson<AnyObj>(
      [
        `/api/stocks/${upper}/disclosures?all=1`,
        `/api/stocks/${upper}/filings?all=1`,
        `/api/stocks/${upper}/disclosures`,
        `/api/stocks/${upper}/filings`,
      ],
      {},
    ),
    tryJson<AnyObj>(
      [`/api/stocks/${upper}/news?all=1`, `/api/stocks/${upper}/news`],
      {},
    ),
  ]);

  let filings = collectFilings(filingsRaw);
  let news = collectNews(newsRaw);
  let specialFeedRaw: AnyObj = {};

  if (filings.length === 0 || news.length === 0) {
    const market = /^\d{6}$/.test(upper) ? 'KR' : 'US';
    specialFeedRaw = await tryJson<AnyObj>(
      [`/api/stocks/special-feed?asset=stock&market=${market}&limit=2000`],
      {},
    );
    const matchingItems = (Array.isArray(specialFeedRaw?.items)
      ? specialFeedRaw.items
      : []
    ).filter(
      (item: AnyObj) =>
        String(item?.ticker ?? '').trim().toUpperCase() === upper,
    );

    if (filings.length === 0) {
      filings = matchingItems.filter(
        (item: AnyObj) => String(item?.kind ?? '') === 'disclosure',
      );
    }
    if (news.length === 0) {
      news = matchingItems.filter(
        (item: AnyObj) => String(item?.kind ?? '') === 'news',
      );
    }
  }

  if (filings.length === 0) {
    filings = [
      {
        title: '공시 제공 상태',
        report_nm: '공시 제공 상태',
        summary:
          firstText(filingsRaw?.summary, filingsRaw?.message, specialFeedRaw?.message) ??
          (/^\d{6}$/.test(upper)
            ? 'DART 공시 제공처 연결을 확인하고 있습니다.'
            : 'SEC EDGAR 공시 제공처 연결을 확인하고 있습니다.'),
        source: /^\d{6}$/.test(upper) ? 'DART' : 'SEC EDGAR',
        date: new Date().toISOString(),
        statusOnly: true,
      },
    ];
  }

  if (news.length === 0) {
    news = [
      {
        title: '뉴스 제공 상태',
        summary:
          firstText(newsRaw?.summary, newsRaw?.message, specialFeedRaw?.message) ??
          '뉴스 제공처 연결이 지연되어 관련 기사를 다시 확인하고 있습니다.',
        source: '뉴스 제공처',
        date: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
        statusOnly: true,
      },
    ];
  }

  return {
    financials: normalizeObject(financialRaw, ["financials", "data"]),
    risk: normalizeObject(riskRaw, ["risk", "analysis", "data"]),
    filings,
    news,
  };
}

function currentBackPath(): string {
  const raw = new URLSearchParams(window.location.search).get("back");

  if (!raw) return "/search";

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function roundPrice(price: number, market: Market): number {
  if (market === "US") {
    return Math.round(price * 100) / 100;
  }

  if (price >= 100_000) {
    return Math.round(price / 1_000) * 1_000;
  }

  if (price >= 10_000) {
    return Math.round(price / 100) * 100;
  }

  if (price >= 1_000) {
    return Math.round(price / 10) * 10;
  }

  return Math.round(price);
}

function deriveRiskLabel(
  score: number,
  classification: AnyObj,
  risk: AnyObj | null,
): RiskLabel {
  const text = [
    classification?.label,
    classification?.riskCaption,
    risk?.riskLevel,
    risk?.level,
    risk?.grade,
    risk?.summary,
    risk?.caption,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (
    classification?.delistingWarning ||
    text.includes("상장폐지") ||
    text.includes("매우 높") ||
    text.includes("critical")
  ) {
    return "매우 높음";
  }

  if (
    text.includes("고위험") ||
    text.includes("높음") ||
    text.includes("high") ||
    score < 40
  ) {
    return "높음";
  }

  if (text.includes("우량주") && score >= 70) {
    return "낮음";
  }

  return "보통";
}

function buildCoreMetrics({
  market,
  currentPrice,
  score,
  opinion,
  classification,
  quote,
  company,
  financials,
  risk,
}: {
  market: Market;
  currentPrice: number | null;
  score: number;
  opinion: string;
  classification: AnyObj;
  quote: AnyObj | null;
  company: AnyObj | null;
  financials: AnyObj | null;
  risk: AnyObj | null;
}): CoreMetrics {
  const riskLabel = deriveRiskLabel(score, classification, risk);

  return {
    // 실제 데이터 근거가 없으면 현재가 기반 임의 배수로 만들어내지 않고 null(→ 산출 불가) 처리한다.
    fairPrice: firstNumber(
      quote?.fairPrice,
      quote?.fairValue,
      company?.fairPrice,
      financials?.fairPrice,
      risk?.fairPrice,
    ),

    targetPrice: firstNumber(
      quote?.targetPrice,
      quote?.analystTargetPrice,
      company?.targetPrice,
      financials?.targetPrice,
      risk?.targetPrice,
    ),

    stopPrice: firstNumber(
      quote?.stopPrice,
      quote?.stopLossPrice,
      company?.stopPrice,
      risk?.stopPrice,
    ),

    riskLabel,

    riskCaption: String(
      risk?.summary ??
        risk?.caption ??
        classification?.riskCaption ??
        "가격 변동성과 재무 위험을 함께 확인해야 합니다.",
    ),
  };
}

function formatCompactMoney(value: unknown, currency: Currency): string {
  const numberValue = toNumber(value);

  if (numberValue == null) {
    return "확인 필요";
  }

  const absolute = Math.abs(numberValue);

  const sign = numberValue < 0 ? "-" : "";

  if (currency === "USD") {
    if (absolute >= 1_000_000_000_000) {
      return `${sign}$${(absolute / 1_000_000_000_000).toFixed(1)}T`;
    }

    if (absolute >= 1_000_000_000) {
      return `${sign}$${(absolute / 1_000_000_000).toFixed(1)}B`;
    }

    if (absolute >= 1_000_000) {
      return `${sign}$${(absolute / 1_000_000).toFixed(1)}M`;
    }

    return `${sign}$${Math.round(absolute).toLocaleString()}`;
  }

  if (absolute >= 1_000_000_000_000) {
    return `${sign}${(absolute / 1_000_000_000_000).toFixed(1)}조`;
  }

  if (absolute >= 100_000_000) {
    return `${sign}${(absolute / 100_000_000).toFixed(0)}억`;
  }

  if (absolute >= 10_000) {
    return `${sign}${(absolute / 10_000).toFixed(0)}만`;
  }

  return `${sign}${Math.round(absolute).toLocaleString()}`;
}

// 재무제표 표기용 — 원본 금액을 100만 단위로 나눠 표시합니다(원↔달러 환산 없음).
function formatMillions(value: unknown): string {
  const numberValue = toNumber(value);
  if (numberValue == null) return "정보 없음";
  const scaled = numberValue / 1_000_000;
  return scaled.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatMoney(value: unknown, currency: Currency): string {
  const numberValue = toNumber(value);

  if (numberValue == null) {
    return "확인 필요";
  }

  if (currency === "USD") {
    return `$${numberValue.toLocaleString(undefined, {
      maximumFractionDigits: 0,
    })}`;
  }

  return `${Math.round(numberValue).toLocaleString()}원`;
}

function positiveSummary(insights: ReturnType<typeof buildAiInsights>): string {
  const rows = [
    ...(insights.newsDisclosureSummary ?? []),
    ...(insights.financialSummary ?? []),
    ...(insights.chartSummary ?? []),
  ];

  return (
    rows.find((row) =>
      /상승|증가|개선|성장|호재|긍정|강세|흑자|계약|수주|돌파|우수/.test(row),
    ) ??
    rows[0] ??
    "최근 확인된 뚜렷한 호재가 없습니다."
  );
}

function negativeSummary(insights: ReturnType<typeof buildAiInsights>): string {
  const rows = [
    ...(insights.riskSummary ?? []),
    ...(insights.newsDisclosureSummary ?? []),
    ...(insights.financialSummary ?? []),
    ...(insights.chartSummary ?? []),
  ];

  return (
    rows.find((row) =>
      /하락|감소|악화|부진|악재|부정|약세|적자|위험|과열|부채|주의/.test(row),
    ) ??
    rows[0] ??
    "최근 확인된 뚜렷한 악재가 없습니다."
  );
}

function normalizeCandles(rows: AnyObj[]): CandlePoint[] {
  return rows
    .map((row, index) => {
      const close = firstNumber(
        row.close,
        row.closePrice,
        row.cur_prc,
        row.currentPrice,
        row.price,
      );

      const open = firstNumber(row.open, row.openPrice, row.open_prc, close);

      const high = firstNumber(
        row.high,
        row.highPrice,
        row.high_prc,
        open,
        close,
      );

      const low = firstNumber(row.low, row.lowPrice, row.low_prc, open, close);

      const volume = firstNumber(
        row.volume,
        row.acc_trde_qty,
        row.tradeVolume,
        row.tradingVolume,
        0,
      );

      if (close == null || open == null || high == null || low == null) {
        return null;
      }

      return {
        date: String(
          row.date ?? row.time ?? row.datetime ?? row.timestamp ?? index,
        ),

        open,

        high: Math.max(high, open, close),

        low: Math.min(low, open, close),

        close,

        volume: Math.max(volume ?? 0, 0),
      };
    })
    .filter((item): item is CandlePoint => item != null);
}

async function fetchChartCandles(
  ticker: string,
  timeframe: ChartTimeframe,
  fallbackRows: AnyObj[],
): Promise<CandlePoint[]> {
  const encodedTicker = encodeURIComponent(ticker);
  const encodedFrame = encodeURIComponent(timeframe);
  const raw = await tryJson<AnyObj>(
    [`/api/stocks/${encodedTicker}/candles?tf=${encodedFrame}`],
    {},
  );

  const rows = Array.isArray(raw?.candles)
    ? raw.candles
    : Array.isArray(raw?.data?.candles)
      ? raw.data.candles
      : Array.isArray(raw?.items)
        ? raw.items
        : Array.isArray(raw)
          ? raw
          : [];

  const normalized = normalizeCandles(rows);

  if (normalized.length >= 2) {
    return normalized;
  }

  // 다른 주기의 일봉을 분봉처럼 보여주면 실제 봉처럼 오해할 수 있으므로,
  // 초기 상세 조회와 같은 1일봉일 때만 기존 데이터를 사용합니다.
  return timeframe === "1D" ? normalizeCandles(fallbackRows) : [];
}

function sma(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) {
    return null;
  }

  const selected = values.slice(-period);

  return selected.reduce((sum, value) => sum + value, 0) / period;
}

function ema(values: number[], period: number): number | null {
  if (period <= 0 || values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let index = period; index < values.length; index += 1) {
    result = (values[index] - result) * multiplier + result;
  }

  return result;
}

function calculateRsi(values: number[], period = 14): number | null {
  if (values.length <= period) {
    return null;
  }

  const changes = values
    .slice(1)
    .map((value, index) => value - values[index])
    .slice(-period);

  const gain =
    changes.reduce((sum, value) => sum + Math.max(value, 0), 0) / period;

  const loss =
    changes.reduce((sum, value) => sum + Math.max(-value, 0), 0) / period;

  if (loss === 0) {
    return 100;
  }

  return 100 - 100 / (1 + gain / loss);
}

function calculateChartStats(candles: CandlePoint[]): ChartStats {
  const closes = candles.map((item) => item.close);

  const volumes = candles.map((item) => item.volume);

  const sma5 = sma(closes, 5);

  const sma20 = sma(closes, 20);

  const rsi = calculateRsi(closes);

  const ema12 = ema(closes, 12);

  const ema26 = ema(closes, 26);

  const macd = ema12 != null && ema26 != null ? ema12 - ema26 : null;

  const macdSeries: number[] = [];

  for (let index = 26; index <= closes.length; index += 1) {
    const slice = closes.slice(0, index);

    const fast = ema(slice, 12);

    const slow = ema(slice, 26);

    if (fast != null && slow != null) {
      macdSeries.push(fast - slow);
    }
  }

  const macdSignal = ema(macdSeries, 9);

  const latestVolume = volumes.length ? volumes[volumes.length - 1] : null;

  const volumePeriod = Math.min(20, volumes.length);

  const averageVolume = volumePeriod > 0 ? sma(volumes, volumePeriod) : null;

  const volumeRatio =
    latestVolume != null && averageVolume != null && averageVolume > 0
      ? latestVolume / averageVolume
      : null;

  const latestClose = closes.length ? closes[closes.length - 1] : null;

  let trend = "확인 중";

  if (latestClose != null && sma5 != null && sma20 != null) {
    if (latestClose > sma5 && sma5 > sma20) {
      trend = "상승 우위";
    } else if (latestClose < sma5 && sma5 < sma20) {
      trend = "하락 우위";
    } else {
      trend = "혼조";
    }
  }

  return {
    rsi,
    macd,
    macdSignal,
    sma5,
    sma20,
    volumeRatio,
    trend,
  };
}

function cleanFinancialPeriod(value: unknown) {
  return String(value ?? "")
    .replace(/&#40;|\$#40;|#40;|\(E\)/gi, "")
    .replace(/&#41;|\$#41;|#41;/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/[^0-9.Q분기년월-]/g, "")
    .trim();
}

function financialValue(...values: unknown[]): number | null {
  const value = firstNumber(...values);
  return value == null || value === 0 ? null : value;
}

function financialRows(
  financials: AnyObj | null,
  period: FinancialPeriod,
): AnyObj[] {
  let rows: AnyObj[] = [];
  if (Array.isArray(financials?.[period])) rows = financials[period];
  else if (period === "annual" && Array.isArray(financials?.yearly))
    rows = financials.yearly;
  else if (period === "quarterly" && Array.isArray(financials?.quarters))
    rows = financials.quarters;
  else if (Array.isArray(financials?.rows)) rows = financials.rows;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const unique = new Map<string, AnyObj>();
  for (const raw of rows) {
    const label = cleanFinancialPeriod(raw?.period ?? raw?.date ?? raw?.year);
    if (!label) continue;
    const match = label.match(/(20\d{2})(?:[.-](\d{1,2}))?/);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2] ?? (period === "annual" ? 12 : 1));
      if (year > currentYear || (year === currentYear && month > currentMonth))
        continue;
    }
    const row: AnyObj = { ...raw, period: label };
    const hasValue = [
      row.revenue,
      row.sales,
      row.operatingIncome,
      row.netIncome,
      row.assets,
      row.totalAssets,
      row.liabilities,
      row.totalLiabilities,
      row.equity,
      row.capitalStock,
      row.operatingCashFlow,
    ].some((value) => financialValue(value) != null);
    if (!hasValue) continue;
    if (!unique.has(label)) unique.set(label, row);
  }
  return [...unique.values()].sort((a, b) =>
    String(b.period).localeCompare(String(a.period), "ko", { numeric: true }),
  );
}

function evaluateFinancialMetric(
  key: FinancialMetricKey,
  value: number | null,
): FinancialMetric {
  const labelMap: Record<FinancialMetricKey, string> = {
    roe: "ROE",

    pbr: "PBR",

    per: "PER",

    psr: "PSR",
  };

  const meaningMap: Record<FinancialMetricKey, string> = {
    roe: "ROE는 주주 자본으로 얼마나 많은 이익을 냈는지 보여주는 수익성 지표입니다.",

    pbr: "PBR은 주가가 기업의 순자산 가치보다 몇 배에 거래되는지 보여줍니다.",

    per: "PER은 현재 주가가 연간 순이익의 몇 배인지 보여줍니다.",

    psr: "PSR은 시가총액이 연간 매출의 몇 배인지 보여줍니다.",
  };

  if (value == null) {
    return {
      key,

      label: labelMap[key],

      valueText: "확인 필요",

      status: "데이터 없음",

      tone: "neutral",

      meaning: meaningMap[key],

      interpretation: "현재 데이터가 없어 정확한 판단이 어렵습니다.",

      caution: "한 지표만 보지 말고 실적과 현금흐름을 함께 확인해야 합니다.",
    };
  }

  if (key === "roe") {
    const status = value < 5 ? "낮음" : value < 15 ? "보통" : "높음";

    return {
      key,

      label: "ROE",

      valueText: `${value.toFixed(1)}%`,

      status,

      tone:
        status === "높음"
          ? "positive"
          : status === "낮음"
            ? "negative"
            : "neutral",

      meaning: meaningMap[key],

      interpretation:
        value < 0
          ? "ROE가 마이너스라 현재 수익성이 부진합니다."
          : `자기자본 대비 수익성이 ${status} 수준입니다.`,

      caution: "부채가 많으면 ROE가 과도하게 높아질 수 있습니다.",
    };
  }

  const lowLimit = key === "per" ? 10 : 1;

  const highLimit = key === "per" ? 25 : 3;

  const status =
    key === "per" && value <= 0
      ? "적자"
      : value <= lowLimit
        ? "낮음"
        : value <= highLimit
          ? "보통"
          : "높음";

  return {
    key,

    label: labelMap[key],

    valueText: `${value.toFixed(key === "per" ? 1 : 2)}배`,

    status,

    tone:
      status === "낮음"
        ? "positive"
        : status === "높음" || status === "적자"
          ? "negative"
          : "neutral",

    meaning: meaningMap[key],

    interpretation:
      status === "낮음"
        ? "현재 평가배수가 낮은 편입니다."
        : status === "높음"
          ? "현재 평가배수가 높은 편입니다."
          : status === "적자"
            ? "적자로 정상적인 PER 평가가 어렵습니다."
            : "현재 평가배수가 보통 수준입니다.",

    caution: "업종 평균과 성장률, 이익 추세를 함께 비교해야 합니다.",
  };
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function digits(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function normalizeAccession(value: unknown): string | null {
  const number = digits(value);

  if (number.length !== 18) {
    return null;
  }

  return `${number.slice(0, 10)}-${number.slice(10, 12)}-${number.slice(12)}`;
}

function filingOriginalUrl(item: AnyObj, market: Market): string | null {
  if (market === "KR") {
    const directCandidates = [
      item.dartUrl,
      item.dart_url,
      item.originalUrl,
      item.original_url,
      item.url,
      item.link,
    ];

    for (const candidate of directCandidates) {
      const url = safeUrl(candidate);

      if (url?.includes("dart.fss.or.kr")) {
        return url;
      }
    }

    const receipt = digits(item.rcept_no ?? item.rceptNo ?? item.receiptNo);

    return receipt.length === 14
      ? `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`
      : null;
  }

  const directCandidates = [
    item.secUrl,
    item.sec_url,
    item.filingUrl,
    item.filing_url,
    item.originalUrl,
    item.original_url,
    item.url,
    item.link,
  ];

  for (const candidate of directCandidates) {
    const url = safeUrl(candidate);

    if (url?.includes("sec.gov")) {
      return url;
    }
  }

  const accession = normalizeAccession(
    item.accessionNumber ??
      item.accession_number ??
      item.accessionNo ??
      item.accession_no,
  );

  const cikDigits = digits(
    item.cik ?? item.cikNumber ?? item.companyCik ?? item.company_cik,
  );

  if (!accession || !cikDigits) {
    return null;
  }

  const cik = String(Number(cikDigits));

  if (cik === "NaN") {
    return null;
  }

  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(
    /-/g,
    "",
  )}/${accession}-index.html`;
}

function articleOriginalUrl(item: AnyObj): string | null {
  const candidates = [
    item.url,
    item.link,
    item.articleUrl,
    item.article_url,
    item.originalUrl,
    item.original_url,
    item.sourceUrl,
  ];

  for (const candidate of candidates) {
    const url = safeUrl(candidate);

    if (url) {
      return url;
    }
  }

  return null;
}

function scoreTone(score: number): string {
  if (score >= 70) {
    return "text-positive";
  }

  if (score < 45) {
    return "text-destructive";
  }

  return "text-foreground";
}

function opinionTone(opinion: string): string {
  if (/매수|buy/i.test(opinion)) {
    return "text-positive";
  }

  if (/매도|sell/i.test(opinion)) {
    return "text-destructive";
  }

  return "text-foreground";
}

function riskTone(risk: RiskLabel): string {
  if (risk === "낮음") {
    return "text-positive";
  }

  if (risk === "높음" || risk === "매우 높음") {
    return "text-destructive";
  }

  return "text-foreground";
}

function metricBorder(tone: Tone): string {
  if (tone === "positive") {
    return "border-positive/30 bg-positive/5";
  }

  if (tone === "negative") {
    return "border-destructive/30 bg-destructive/5";
  }

  return "border-card-border bg-secondary/50";
}

function metricText(tone: Tone): string {
  if (tone === "positive") {
    return "text-positive";
  }

  if (tone === "negative") {
    return "text-destructive";
  }

  return "text-primary";
}

interface DetailSavedState {
  tab?: DetailTab;
  scrollTopByTab?: Partial<Record<DetailTab, number>>;
}

function readDetailState(ticker: string): DetailSavedState {
  try {
    return JSON.parse(
      sessionStorage.getItem(`sa-detail-state:${ticker}`) ?? "{}",
    ) as DetailSavedState;
  } catch {
    return {};
  }
}

function detailTabFromUrl(ticker: string): DetailTab {
  const raw = new URLSearchParams(window.location.search).get("tab");
  if (raw === "financial") return "financials";

  if (TABS.some((item) => item.key === raw)) return raw as DetailTab;

  const saved = readDetailState(ticker).tab;
  return TABS.some((item) => item.key === saved) ? saved! : "overview";
}

export default function DetailPage() {
  const [, params] = useRoute("/stock/:ticker") as [
    boolean,
    {
      ticker?: string;
    } | null,
  ];

  const [, navigate] = useLocation();
  const permissions = useMemberPermissions();

  const ticker = String(params?.ticker ?? "").toUpperCase();
  const studyId = new URLSearchParams(window.location.search).get("study");

  const [tab, setTab] = useState<DetailTab>(() =>
    permissions.canUseAdvancedAnalysis ? detailTabFromUrl(ticker) : "chart",
  );
  const visibleTabs = useMemo(
    () =>
      permissions.canUseAdvancedAnalysis
        ? TABS
        : TABS.filter((item) => item.key === "chart"),
    [permissions.canUseAdvancedAnalysis],
  );
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const restoredScrollRef = useRef<string | null>(null);

  const [watched, setWatched] = useState(() => isInWatchlist(ticker));
  const [alertOpen, setAlertOpen] = useState(false);

  const coreDetail = useQuery<DetailData>({
    queryKey: ["stock-detail-core-v16", ticker],
    queryFn: () => fetchDetailCore(ticker),
    enabled: Boolean(ticker),
    staleTime: 15_000,
    gcTime: 10 * 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const identityDetail = useQuery<DetailIdentityData>({
    queryKey: ["stock-detail-identity-v16", ticker],
    queryFn: () => fetchDetailIdentity(ticker),
    enabled: Boolean(ticker),
    staleTime: 60_000,
    gcTime: 15 * 60_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
  });

  const advancedDetail = useQuery<DetailAdvancedData>({
    queryKey: ["stock-detail-advanced-v16", ticker],
    queryFn: () => fetchDetailAdvanced(ticker),
    enabled: Boolean(
      ticker && permissions.canUseAdvancedAnalysis && coreDetail.data,
    ),
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });

  const data = useMemo<DetailData | undefined>(() => {
    if (!coreDetail.data) return undefined;
    const identityMerged: DetailData = {
      ...coreDetail.data,
      quote: identityDetail.data?.quote ?? coreDetail.data.quote,
      company: identityDetail.data?.company ?? coreDetail.data.company,
    };
    if (!permissions.canUseAdvancedAnalysis || !advancedDetail.data) {
      return identityMerged;
    }
    return {
      ...identityMerged,
      ...advancedDetail.data,
    };
  }, [
    advancedDetail.data,
    coreDetail.data,
    identityDetail.data,
    permissions.canUseAdvancedAnalysis,
  ]);

  const detail = {
    data,
    isLoading: coreDetail.isLoading,
    isError: coreDetail.isError,
  };

  const market = marketOf(ticker, data?.quote, data?.company);

  const currency = currencyOf(market, data?.quote);

  const companyName = displayStockName(
    ticker,

    String(
      data?.company?.name ??
        data?.quote?.name ??
        data?.company?.companyName ??
        ticker,
    ),

    market,
  );

  const insights = useMemo(
    () =>
      buildAiInsights({
        ticker,

        name: companyName,

        market,
        currency,

        quote: data?.quote,

        financials: data?.financials,

        risk: data?.risk,

        news: data?.news ?? [],

        filings: data?.filings ?? [],

        candles: data?.candles ?? [],
      }),
    [ticker, companyName, market, currency, data],
  );

  const currentPrice = toNumber(data?.quote?.price);

  const metrics = useMemo(
    () =>
      buildCoreMetrics({
        market,
        currentPrice,

        score: insights.score,

        opinion: insights.opinion,

        classification: insights.classification,

        quote: data?.quote ?? null,

        company: data?.company ?? null,

        financials: data?.financials ?? null,

        risk: data?.risk ?? null,
      }),
    [market, currentPrice, insights, data],
  );

  const changePositive = (toNumber(data?.quote?.changePercent) ?? 0) >= 0;

  useEffect(() => {
    if (!permissions.canUseAdvancedAnalysis && tab !== "chart") {
      setTab("chart");
    }
  }, [permissions.canUseAdvancedAnalysis, tab]);

  useEffect(() => {
    const state = readDetailState(ticker);
    sessionStorage.setItem(
      `sa-detail-state:${ticker}`,
      JSON.stringify({ ...state, tab }),
    );

    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(window.history.state, "", url);
  }, [ticker, tab]);

  useEffect(() => {
    if (!data) return;
    const restoreKey = `${ticker}:${tab}`;
    if (restoredScrollRef.current === restoreKey) return;
    restoredScrollRef.current = restoreKey;

    const savedTop = readDetailState(ticker).scrollTopByTab?.[tab] ?? 0;
    requestAnimationFrame(() => {
      scrollContainerRef.current?.scrollTo({ top: savedTop });
    });
  }, [ticker, tab, data]);

  const saveScrollPosition = () => {
    const top = scrollContainerRef.current?.scrollTop ?? 0;
    const state = readDetailState(ticker);
    sessionStorage.setItem(
      `sa-detail-state:${ticker}`,
      JSON.stringify({
        ...state,
        tab,
        scrollTopByTab: { ...state.scrollTopByTab, [tab]: top },
      }),
    );
  };

  return (
    <div
      ref={scrollContainerRef}
      onScroll={saveScrollPosition}
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background"
    >
      <header className="relative z-20 shrink-0 border-b border-card-border bg-background px-3 pb-2 pt-3">
        <div className="grid grid-cols-[36px_minmax(0,1fr)_auto_36px_36px] items-center gap-2">
          <button
            type="button"
            aria-label="뒤로가기"
            onClick={() => navigate(currentBackPath())}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-xl font-bold"
          >
            ‹
          </button>

          <div className="absolute left-1/2 top-[30px] w-[calc(100%_-_184px)] -translate-x-1/2 -translate-y-1/2 text-center">
            <div className="flex min-w-0 flex-wrap items-center justify-center gap-1.5">
              <h1 className="max-w-full break-keep text-center text-lg font-extrabold leading-tight">{companyName || ticker}</h1>

              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-extrabold",

                  stockClassBadgeClass(insights.classification.label),
                )}
              >
                {insights.classification.label}
              </span>
            </div>

            <p className="mt-0.5 text-center text-[11px] font-bold text-muted-foreground">
              {ticker}
            </p>
          </div>

          <div className="shrink-0 text-right">
            <p className="text-base font-extrabold">
              {formatAppPrice(data?.quote?.price, currency)}
            </p>

            <p
              className={cn(
                "mt-0.5 text-xs font-extrabold",

                changePositive ? "text-positive" : "text-destructive",
              )}
            >
              {formatAppPercent(data?.quote?.changePercent)}
            </p>
          </div>

          <button
            type="button"
            aria-label="알림 설정"
            onClick={() => setAlertOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground"
          >
            <Bell className="h-4 w-4" />
          </button>

          <button
            type="button"
            aria-label="관심종목"
            onClick={() =>
              setWatched(
                toggleWatchlistItem({
                  ticker,

                  name: companyName,

                  market,
                  currency,
                }),
              )
            }
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-xl",

              watched ? "text-yellow-400" : "text-muted-foreground",
            )}
          >
            {watched ? "★" : "☆"}
          </button>
        </div>

        <div
          className="mt-2 grid gap-1"
          style={{
            gridTemplateColumns: `repeat(${visibleTabs.length}, minmax(0, 1fr))`,
          }}
        >
          {visibleTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setTab(item.key);
                scrollContainerRef.current?.scrollTo({ top: 0 });
              }}
              className={cn(
                "flex min-h-9 min-w-0 items-center justify-center break-keep rounded-xl border px-0.5 py-2 text-center text-[9px] font-extrabold leading-4",

                tab === item.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-card-border bg-card text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-none px-3 pb-28 pt-3">
        {detail.isLoading && (
          <CenterMessage>종목 데이터를 불러오는 중...</CenterMessage>
        )}

        {detail.isError && (
          <CenterMessage error>
            종목 데이터를 불러오지 못했습니다.
          </CenterMessage>
        )}

        {permissions.canUseAdvancedAnalysis && data && tab === "overview" && (
          <OverviewTab
            ticker={ticker}
            name={companyName}
            market={market}
            currency={currency}
            data={data}
            insights={insights}
            metrics={metrics}
          />
        )}

        {permissions.canUseAdvancedAnalysis && data && tab === "ai" && (
          <AiTab
            market={market}
            currency={currency}
            currentPrice={currentPrice}
            insights={insights}
            metrics={metrics}
          />
        )}

        {data && tab === "chart" && (
          <ChartTab
            ticker={ticker}
            fallbackRows={data.candles}
            insights={insights}
            currentPrice={currentPrice}
            currency={currency}
            studyId={studyId}
            basicOnly={!permissions.canUseAdvancedAnalysis}
            showAutoTradingData={permissions.canUseAutoTrading}
          />
        )}

        {permissions.canUseAdvancedAnalysis && data && tab === "financials" && (
          <FinancialTab financials={data.financials} currency={currency} />
        )}

        {permissions.canUseAdvancedAnalysis && data && tab === "filings" && (
          <FilingTab
            ticker={ticker}
            market={market}
            filings={data.filings}
            summary={insights.disclosureAiSummary}
          />
        )}

        {permissions.canUseAdvancedAnalysis && data && tab === "news" && (
          <NewsTab
            ticker={ticker}
            news={data.news}
            summary={insights.newsAiSummary}
          />
        )}
      </main>

      {alertOpen && (
        <Modal
          title={`${companyName} 알림`}
          onClose={() => setAlertOpen(false)}
        >
          <PriceAlertCard
            assetType="stock"
            market={market}
            symbol={ticker}
            currentPrice={currentPrice}
            currency={currency}
          />
          {permissions.canUseAdvancedAnalysis && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setAlertOpen(false);
                  setTab("news");
                }}
                className="rounded-xl border border-card-border bg-secondary px-3 py-2 text-xs font-extrabold"
              >
                관련 뉴스
              </button>
              <button
                type="button"
                onClick={() => {
                  setAlertOpen(false);
                  setTab("filings");
                }}
                className="rounded-xl border border-card-border bg-secondary px-3 py-2 text-xs font-extrabold"
              >
                관련 공시
              </button>
            </div>
          )}
        </Modal>
      )}

      <BottomNav />
    </div>
  );
}

function CenterMessage({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <p
        className={cn(
          "text-center text-sm font-bold",

          error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {children}
      </p>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  actions,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** 기본은 접힘. 최상단 헤더 등 항상 펼쳐야 하는 경우만 true */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-2xl border border-card-border bg-card shadow-sm">
      <div className="flex items-stretch gap-2 border-b border-card-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center justify-center gap-2 px-4 py-3 text-center"
        >
          <span className="min-w-0 flex-1 text-center">
            <span className="block break-keep text-base font-extrabold leading-6">
              {title}
            </span>
          </span>

          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>

        {actions && open && (
          <div className="flex shrink-0 items-center pr-3">{actions}</div>
        )}
      </div>

      {open && <div className="p-3">{children}</div>}
    </section>
  );
}

function inferCompanyBusiness(
  name: string,
  ticker: string,
  company: AnyObj | null,
) {
  const direct = firstText(
    company?.industry,
    company?.sector,
    company?.business,
    company?.businessType,
    company?.category,
  );
  const text = `${name} ${ticker} ${direct ?? ""}`.toLowerCase();
  if (/삼성전자|하이닉스|nvidia|amd|intel|broadcom|micron|반도체/.test(text))
    return "반도체·전자 기업으로 메모리, 시스템반도체, AI 연산칩 또는 관련 장비·부품 사업의 실적과 업황 영향을 크게 받습니다.";
  if (
    /바이오|제약|pharma|therapeutics|셀트리온|삼성바이오|lilly|pfizer/.test(
      text,
    )
  )
    return "바이오·제약 기업으로 신약, 바이오의약품, 임상, 허가, 생산계약과 연구개발 성과가 기업가치에 큰 영향을 줍니다.";
  if (/현대차|기아|tesla|motor|rivian|자동차/.test(text))
    return "자동차·모빌리티 기업으로 완성차 판매, 전기차, 배터리 원가, 환율과 글로벌 수요에 따라 실적이 움직입니다.";
  if (/은행|증권|금융|bank|jpmorgan|visa/.test(text))
    return "금융 기업으로 금리, 대출·예금, 수수료, 자산건전성 또는 결제 거래량이 핵심 실적 변수입니다.";
  if (
    /소프트웨어|software|microsoft|alphabet|naver|카카오|oracle|meta/.test(text)
  )
    return "소프트웨어·인터넷 기업으로 플랫폼 이용자, 광고, 클라우드, 구독과 AI 서비스 성장이 핵심 사업입니다.";
  if (/에너지|화학|oil|gas|battery|배터리/.test(text))
    return "에너지·소재 기업으로 원자재 가격, 제품 스프레드, 설비 가동률과 전방산업 수요에 영향을 받습니다.";
  return direct
    ? `${direct} 분야를 중심으로 사업을 영위하는 상장기업입니다. 매출 구성, 주요 고객, 경쟁력과 최근 실적을 함께 확인하세요.`
    : `${name}은(는) ${/^\d/.test(ticker) ? "대한민국" : "미국"} 상장기업입니다. 회사 개요 데이터가 부족해 재무제표·공시·뉴스의 사업 내용을 함께 확인해야 합니다.`;
}

function cleanCompanyOverview(
  value: unknown,
  name: string,
  ticker: string,
  company: AnyObj | null,
) {
  const fallback = inferCompanyBusiness(name, ticker, company);
  let text = translateMarketText(String(value ?? ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[-_=]{4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const looksLikeReportIndex =
    /(요약재무정보|연결재무제표|별도재무제표|재무에 관한 사항|배당에 관한 사항|증권의 발행|감사인의 감사|임원 및 직원|주주에 관한 사항)/.test(
      text,
    ) ||
    (text.match(/(?:^|\s)(?:[IVXⅠⅡⅢⅣⅤ]+|\d{1,3})[.)]?\s/g) ?? []).length >= 5;

  if (!text || looksLikeReportIndex) return fallback;

  const blocked = /(목차|사업보고서|분기보고서|반기보고서|재무제표|감사보고서)/;
  const sentences = text
    .split(/(?<=[.!?。！？])\s+|[\r\n]+/)
    .map((sentence) => sentence.trim())
    .filter(
      (sentence) =>
        sentence.length >= 20 &&
        sentence.length <= 260 &&
        !blocked.test(sentence),
    );

  const unique = [...new Set(sentences)].slice(0, 3);
  const summary = unique.join(" ").trim();
  return summary.length >= 30 ? summary : fallback;
}

type RiskGrade = "낮음" | "보통" | "높음" | "매우 높음" | "데이터 부족";

interface RiskRow {
  name: string;
  grade: RiskGrade;
  reason: string;
}

// 페이지가 이미 불러온 데이터만 사용해 세부 위험을 계산합니다. 근거 없는 값은 '데이터 부족'입니다.
function computeRiskBreakdown(
  data: DetailData,
  chartStats: ChartStats | null,
): RiskRow[] {
  const rows: RiskRow[] = [];
  const fin = data.financials;
  const quote = data.quote;
  const candles = normalizeCandles(data.candles ?? []);

  // 재무 위험 — 부채비율 / 적자 여부
  {
    const ratios = fin?.ratios ?? {};
    const debtRatio = firstNumber(ratios.debtRatio, fin?.debtRatio);
    const annual = Array.isArray(fin?.annual)
      ? fin.annual
      : Array.isArray(fin?.yearly)
        ? fin.yearly
        : [];
    const quarterly = Array.isArray(fin?.quarterly)
      ? fin.quarterly
      : Array.isArray(fin?.quarters)
        ? fin.quarters
        : [];
    const latest = quarterly[0] ?? annual[0] ?? null;
    const netIncome = latest
      ? firstNumber(latest.netIncome, latest.profit)
      : null;
    if (debtRatio == null && netIncome == null) {
      rows.push({
        name: "재무 위험",
        grade: "데이터 부족",
        reason: "부채비율·순이익 데이터가 없습니다.",
      });
    } else {
      const deficit = netIncome != null && netIncome < 0;
      let grade: RiskGrade = "보통";
      if (deficit && debtRatio != null && debtRatio >= 200) grade = "매우 높음";
      else if (deficit || (debtRatio != null && debtRatio >= 200))
        grade = "높음";
      else if (debtRatio != null && debtRatio < 100) grade = "낮음";
      rows.push({
        name: "재무 위험",
        grade,
        reason: `${deficit ? "최근 순이익 적자" : "최근 순이익 흑자"}${debtRatio != null ? ` · 부채비율 ${debtRatio.toFixed(0)}%` : ""}`,
      });
    }
  }

  // 밸류에이션 위험 — PER / PBR
  {
    const ratios = fin?.ratios ?? {};
    const per = firstNumber(ratios.per, quote?.per, quote?.pe);
    const pbr = firstNumber(ratios.pbr, quote?.pbr, quote?.pb);
    if (per == null && pbr == null) {
      rows.push({
        name: "밸류에이션 위험",
        grade: "데이터 부족",
        reason: "PER·PBR 데이터가 없습니다.",
      });
    } else {
      let grade: RiskGrade = "보통";
      const high = (per != null && per > 40) || (pbr != null && pbr > 5);
      const low =
        per != null && per > 0 && per < 10 && (pbr == null || pbr < 1.5);
      const deficit = per != null && per <= 0;
      if (high) grade = "높음";
      else if (deficit) grade = "높음";
      else if (low) grade = "낮음";
      rows.push({
        name: "밸류에이션 위험",
        grade,
        reason: `${per != null ? `PER ${per.toFixed(1)}배` : "PER 없음"}${pbr != null ? ` · PBR ${pbr.toFixed(2)}배` : ""}`,
      });
    }
  }

  // 가격 변동성 위험 — 최근 캔들 일간 변동성
  {
    if (candles.length < 6) {
      rows.push({
        name: "가격 변동성 위험",
        grade: "데이터 부족",
        reason: "변동성 계산에 필요한 캔들이 부족합니다.",
      });
    } else {
      const recent = candles.slice(-20);
      const ranges = recent.map((c) => (c.high - c.low) / (c.close || 1));
      const avg = ranges.reduce((s, v) => s + v, 0) / ranges.length;
      let grade: RiskGrade = "보통";
      if (avg >= 0.07) grade = "매우 높음";
      else if (avg >= 0.045) grade = "높음";
      else if (avg < 0.02) grade = "낮음";
      rows.push({
        name: "가격 변동성 위험",
        grade,
        reason: `최근 평균 일간 변동폭 약 ${(avg * 100).toFixed(1)}%`,
      });
    }
  }

  // 유동성 위험 — 거래대금(거래량 x 종가)
  {
    const last = candles[candles.length - 1] ?? null;
    const tradeValue = last ? last.volume * last.close : null;
    if (tradeValue == null || tradeValue <= 0) {
      rows.push({
        name: "유동성 위험",
        grade: "데이터 부족",
        reason: "거래대금 데이터가 없습니다.",
      });
    } else {
      const market = marketOf(data.ticker, quote, data.company);
      const threshold = market === "KR" ? 1_000_000_000 : 5_000_000; // 10억원 / $5M
      const lowThreshold = market === "KR" ? 100_000_000 : 500_000;
      let grade: RiskGrade = "보통";
      if (tradeValue < lowThreshold) grade = "높음";
      else if (tradeValue >= threshold) grade = "낮음";
      rows.push({
        name: "유동성 위험",
        grade,
        reason: `최근 거래대금 ${formatCompactMoney(tradeValue, currencyOf(market, quote))}`,
      });
    }
  }

  // 기술적 위험 — RSI / 이평 위치
  {
    if (!chartStats || chartStats.rsi == null) {
      rows.push({
        name: "기술적 위험",
        grade: "데이터 부족",
        reason: "기술 지표 계산 데이터가 부족합니다.",
      });
    } else {
      const rsi = chartStats.rsi;
      let grade: RiskGrade = "보통";
      if (rsi >= 80 || rsi <= 20) grade = "높음";
      else if (rsi >= 70 || rsi <= 30) grade = "보통";
      else grade = "낮음";
      const trend = chartStats.trend;
      rows.push({
        name: "기술적 위험",
        grade,
        reason: `RSI ${rsi.toFixed(0)} · ${trend}`,
      });
    }
  }

  // 뉴스 위험 — 실제 부정 신호가 있을 때만
  {
    const news = Array.isArray(data.news) ? data.news : [];
    if (news.length === 0) {
      rows.push({
        name: "뉴스 위험",
        grade: "데이터 부족",
        reason: "수집된 뉴스가 없습니다.",
      });
    } else {
      const negRe =
        /적자|하락|급락|감소|악재|소송|리콜|횡령|배임|하향|경고|부진|손실/;
      const negCount = news.filter((n) =>
        negRe.test(String(n.title ?? n.headline ?? "")),
      ).length;
      let grade: RiskGrade = "낮음";
      if (negCount >= 3) grade = "높음";
      else if (negCount >= 1) grade = "보통";
      rows.push({
        name: "뉴스 위험",
        grade,
        reason:
          negCount > 0
            ? `부정적 표현 뉴스 ${negCount}건 감지`
            : `최근 뉴스 ${news.length}건에서 부정 신호 없음`,
      });
    }
  }

  const filings = Array.isArray(data.filings) ? data.filings : [];
  const filingTitle = (f: AnyObj) =>
    String(f.title ?? f.report_nm ?? f.report ?? f.form ?? "");

  // 공시 위험 — 공시 존재 여부
  {
    if (filings.length === 0) {
      rows.push({
        name: "공시 위험",
        grade: "데이터 부족",
        reason: "수집된 공시가 없습니다.",
      });
    } else {
      rows.push({
        name: "공시 위험",
        grade: "낮음",
        reason: `최근 공시 ${filings.length}건 확인됨`,
      });
    }
  }

  // 오퍼링·유상증자 위험 — 공시 제목 키워드 검색
  {
    if (filings.length === 0) {
      rows.push({
        name: "오퍼링·유상증자 위험",
        grade: "데이터 부족",
        reason: "공시 데이터가 없습니다.",
      });
    } else {
      const re = /유상증자|전환사채|신주인수권|CB|BW|offering|dilut/i;
      const hits = filings.filter((f) => re.test(filingTitle(f)));
      rows.push({
        name: "오퍼링·유상증자 위험",
        grade: hits.length >= 2 ? "높음" : hits.length === 1 ? "보통" : "낮음",
        reason:
          hits.length > 0
            ? `유상증자·전환사채 관련 공시 ${hits.length}건`
            : "관련 공시 없음",
      });
    }
  }

  // 상장폐지·거래정지 위험 — 공시 키워드
  {
    if (filings.length === 0) {
      rows.push({
        name: "상장폐지·거래정지 위험",
        grade: "데이터 부족",
        reason: "공시 데이터가 없습니다.",
      });
    } else {
      const re =
        /상장폐지|거래정지|관리종목|감사의견\s*거절|투자주의|투자경고|delist|going concern/i;
      const hits = filings.filter((f) => re.test(filingTitle(f)));
      rows.push({
        name: "상장폐지·거래정지 위험",
        grade: hits.length > 0 ? "매우 높음" : "낮음",
        reason:
          hits.length > 0
            ? `관련 공시 ${hits.length}건 감지`
            : "관련 공시 없음",
      });
    }
  }

  // 공매도 위험 — 공매도 비중
  {
    const shortRatio = firstNumber(
      quote?.shortRatio,
      quote?.shortInterestRatio,
      data.risk?.shortRatio,
    );
    if (shortRatio == null) {
      rows.push({
        name: "공매도 위험",
        grade: "데이터 부족",
        reason: "공매도 비중 데이터가 없습니다.",
      });
    } else {
      let grade: RiskGrade = "보통";
      if (shortRatio >= 15) grade = "높음";
      else if (shortRatio < 5) grade = "낮음";
      rows.push({
        name: "공매도 위험",
        grade,
        reason: `공매도 비중 약 ${shortRatio.toFixed(1)}%`,
      });
    }
  }

  // 수급 위험 — 외국인/기관 순매도 지속(quote/risk에 값이 있을 때만)
  {
    const foreignNet = firstNumber(
      quote?.foreignNet,
      quote?.foreignNetBuy,
      data.risk?.foreignNet,
    );
    const instNet = firstNumber(
      quote?.institutionNet,
      quote?.instNetBuy,
      data.risk?.institutionNet,
    );
    if (foreignNet == null && instNet == null) {
      rows.push({
        name: "수급 위험",
        grade: "데이터 부족",
        reason: "외국인·기관 순매수 데이터가 없습니다.",
      });
    } else {
      const bothSell =
        foreignNet != null && foreignNet < 0 && instNet != null && instNet < 0;
      const anySell =
        (foreignNet != null && foreignNet < 0) ||
        (instNet != null && instNet < 0);
      let grade: RiskGrade = "보통";
      if (bothSell) grade = "높음";
      else if (!anySell) grade = "낮음";
      rows.push({
        name: "수급 위험",
        grade,
        reason: `외국인 ${foreignNet == null ? "정보 없음" : foreignNet < 0 ? "순매도" : "순매수"} · 기관 ${instNet == null ? "정보 없음" : instNet < 0 ? "순매도" : "순매수"}`,
      });
    }
  }

  return rows;
}

function riskGradeTone(grade: RiskGrade): string {
  switch (grade) {
    case "낮음":
      return "text-positive";
    case "보통":
      return "text-muted-foreground";
    case "높음":
      return "text-destructive";
    case "매우 높음":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function OverviewTab({
  ticker,
  name,
  market,
  currency,
  data,
  insights,
  metrics,
}: {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  data: DetailData;
  insights: ReturnType<typeof buildAiInsights>;
  metrics: CoreMetrics;
}) {
  const isPlaceholderDescription = (value: unknown): boolean => {
    const text = String(value ?? "").trim();
    if (!text) return true;
    return (
      /기업 정보입니다\.?$/.test(text) ||
      /기업 정보를 확인 중입니다\.?$/.test(text)
    );
  };

  const rawDescription = firstText(
    data.company?.description,
    data.company?.businessSummary,
    data.company?.overview,
    data.company?.summary,
    data.company?.companyDescription,
  );
  const description = cleanCompanyOverview(
    rawDescription && !isPlaceholderDescription(rawDescription)
      ? rawDescription
      : null,
    name,
    ticker,
    data.company,
  );

  const chartStats =
    normalizeCandles(data.candles ?? []).length >= 2
      ? calculateChartStats(normalizeCandles(data.candles ?? []))
      : null;
  const riskRows = computeRiskBreakdown(data, chartStats);
  const [detailModal, setDetailModal] = useState<{
    title: string;
    text: string;
  } | null>(null);

  const marketCap = firstNumber(
    data.quote?.marketCap,
    data.quote?.market_cap,
    data.quote?.marketCapitalization,
    data.company?.marketCap,
    data.financials?.marketCap,
  );

  const industry = firstText(data.company?.industry, data.company?.sector);
  const exchange = firstText(data.company?.exchange, data.quote?.exchange);
  const website = safeUrl(
    firstText(
      data.company?.website,
      data.company?.homepage,
      data.company?.hm_url,
    ),
  );
  const provider =
    firstText(data.company?.provider) ??
    (market === "KR" ? "DART/네이버" : "SEC/Yahoo");

  return (
    <div className="flex flex-col gap-3">
      <SectionCard
        title="개요"
        subtitle={industry ? `업종 ${industry}` : "회사 개요 정보"}
      >
        <div className="flex items-center justify-center gap-2 text-center">
          <div className="flex min-w-0 flex-col items-center gap-1">
            <p className="truncate text-base font-extrabold">{name}</p>
            <span className="shrink-0 rounded-full bg-secondary/70 px-2.5 py-1 text-[10px] font-extrabold text-muted-foreground">
              시총{" "}
              {marketCap != null
                ? formatCompactMoney(marketCap, currency)
                : "정보 없음"}
            </span>
          </div>
        </div>

        <div className="mt-3 rounded-xl bg-secondary/60 px-3 py-3 text-center">
          <p className="text-[10px] font-extrabold text-primary">
            주요 사업 / 회사 설명
          </p>

          <p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <MiniMetric label="업종·산업" value={industry ?? "정보 없음"} />
          <MiniMetric
            label="시장(거래소)"
            value={exchange ?? (market === "KR" ? "국내" : "미국")}
          />
        </div>
        {website && (
          <div className="mt-2 text-center">
            <a
              href={website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block break-all text-[11px] font-extrabold text-primary underline"
            >
              공식 홈페이지
            </a>
          </div>
        )}
        <p className="mt-2 text-center text-[10px] font-bold text-muted-foreground">
          데이터 제공: {provider}
        </p>
      </SectionCard>

      <SectionCard title="AI 간단요약" subtitle="현재 데이터 기준 참고용 분석">
        <div className="grid grid-cols-3 gap-2">
          <MiniMetric
            label="AI 점수"
            value={`${Math.round(insights.score)}점`}
            valueClassName={scoreTone(insights.score)}
          />

          <MiniMetric
            label="의견"
            value={insights.opinion || "관망"}
            valueClassName={opinionTone(insights.opinion)}
          />

          <MiniMetric
            label="위험도"
            value={metrics.riskLabel}
            valueClassName={riskTone(metrics.riskLabel)}
          />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          <MiniMetric
            label="적정가"
            value={
              metrics.fairPrice != null
                ? formatAppPrice(metrics.fairPrice, currency)
                : "산출 불가"
            }
            valueClassName="text-primary"
          />

          <MiniMetric
            label="목표가"
            value={
              metrics.targetPrice != null
                ? formatAppPrice(metrics.targetPrice, currency)
                : "산출 불가"
            }
            valueClassName="text-positive"
          />

          <MiniMetric
            label="손절가"
            value={
              metrics.stopPrice != null
                ? formatAppPrice(metrics.stopPrice, currency)
                : "산출 불가"
            }
            valueClassName="text-destructive"
          />
        </div>

        <p className="mb-1 mt-3 text-[10px] font-extrabold">핵심 투자 포인트</p>

        <div className="grid grid-cols-3 gap-2">
          <SignalBox
            label="호재"
            text={positiveSummary(insights)}
            positive
            compact
            onClick={() =>
              setDetailModal({
                title: "호재 근거",
                text:
                  [
                    ...(insights.newsDisclosureSummary ?? []),
                    ...(insights.financialSummary ?? []),
                    ...(insights.chartSummary ?? []),
                  ]
                    .filter((row) =>
                      /상승|증가|개선|성장|호재|긍정|강세|흑자|계약|수주|돌파|우수/.test(
                        row,
                      ),
                    )
                    .join(" ") || "현재 확인된 뚜렷한 호재가 없습니다.",
              })
            }
          />

          <SignalBox
            label="악재"
            text={negativeSummary(insights)}
            compact
            onClick={() =>
              setDetailModal({
                title: "악재 근거",
                text:
                  [
                    ...(insights.riskSummary ?? []),
                    ...(insights.newsDisclosureSummary ?? []),
                    ...(insights.financialSummary ?? []),
                  ]
                    .filter((row) =>
                      /하락|감소|악화|부진|악재|부정|약세|적자|위험|과열|부채|주의/.test(
                        row,
                      ),
                    )
                    .join(" ") || "현재 확인된 뚜렷한 악재가 없습니다.",
              })
            }
          />
          <SignalBox
            label="리스크"
            text={insights.riskSummary?.[0] ?? metrics.riskCaption}
            compact
            onClick={() =>
              setDetailModal({
                title: "리스크 설명",
                text:
                  (insights.riskSummary ?? []).join(" ") ||
                  metrics.riskCaption ||
                  "현재 확인된 별도 리스크가 없습니다.",
              })
            }
          />
        </div>

        <p className="mb-1 mt-4 text-center text-[10px] font-extrabold">
          세부 위험 분석
        </p>
        <div className="space-y-1.5">
          {riskRows.map((row) => (
            <button
              key={row.name}
              type="button"
              onClick={() =>
                setDetailModal({
                  title: `${row.name} 설명`,
                  text: row.reason || "설명 데이터가 없습니다.",
                })
              }
              className="w-full rounded-xl bg-secondary/50 px-3 py-2 text-center"
            >
              <div className="flex items-center justify-center gap-2">
                <span className="text-[11px] font-extrabold">{row.name}</span>
                <span
                  className={cn(
                    "text-[11px] font-black",
                    riskGradeTone(row.grade),
                  )}
                >
                  {row.grade}
                </span>
              </div>
              <p className="mt-0.5 break-keep text-[10px] font-semibold leading-4 text-muted-foreground">
                {row.reason}
              </p>
            </button>
          ))}
        </div>
      </SectionCard>
      {detailModal && (
        <Modal title={detailModal.title} onClose={() => setDetailModal(null)}>
          <p>{detailModal.text}</p>
        </Modal>
      )}
    </div>
  );
}

function AiTab({
  market,
  currency,
  currentPrice,
  insights,
  metrics,
}: {
  market: Market;
  currency: Currency;
  currentPrice: number | null;
  insights: ReturnType<typeof buildAiInsights>;
  metrics: CoreMetrics;
}) {
  const [analysisModal, setAnalysisModal] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<{
    label: string;
    value: string;
    reason: string;
    checklist: string[];
  } | null>(null);
  const [openSections, setOpenSections] = useState({
    chart: false,
    financial: false,
    news: false,
    plan: false,
  });

  const toggleSection = (key: keyof typeof openSections) =>
    setOpenSections((current) => ({
      ...current,
      [key]: !current[key],
    }));

  const firstEntry =
    currentPrice != null ? roundPrice(currentPrice * 0.965, market) : null;

  const secondEntry =
    currentPrice != null ? roundPrice(currentPrice * 0.925, market) : null;

  const thirdEntry =
    currentPrice != null ? roundPrice(currentPrice * 0.88, market) : null;

  const planRows = [
    {
      label: "1차 진입 · 30%",
      value: formatAppPrice(firstEntry, currency),
      reason: `현재가의 약 3.5% 아래 첫 눌림 구간입니다. ${insights.chartSummary?.[0] ?? "일봉이 5일 이동평균선을 지지하거나 다시 돌파하는지 확인한 뒤 소액으로 시작합니다."}`,
      checklist: [
        "일봉 종가가 5일 이동평균선 위에서 마감하는지 확인",
        "하락할 때 거래량이 줄고 반등할 때 늘어나는지 확인",
        "한 번에 전액 매수하지 않고 예정 자금의 30%만 진입",
      ],
      negative: false,
    },
    {
      label: "2차 진입 · 30%",
      value: formatAppPrice(secondEntry, currency),
      reason:
        "현재가의 약 7.5% 아래 두 번째 지지 후보입니다. 20일 이동평균선 또는 이전 저점에서 반등이 확인될 때만 추가 진입합니다.",
      checklist: [
        "20일선이나 최근 저점 부근에서 긴 아래꼬리 또는 양봉 확인",
        "RSI가 과매도 구간에서 위로 방향을 바꾸는지 확인",
        "악재 공시나 실적 전망 하향이 없는지 다시 확인",
      ],
      negative: false,
    },
    {
      label: "3차 진입 · 20%",
      value: formatAppPrice(thirdEntry, currency),
      reason:
        "급락 뒤 기술적 반등을 노리는 마지막 분할 구간입니다. 가격이 싸다는 이유만으로 매수하지 않고 추세 전환 신호가 나올 때만 진입합니다.",
      checklist: [
        "전일 고가 돌파 또는 5일선 재돌파 확인",
        "MACD 하락 폭 축소와 거래량 회복 확인",
        "신호가 없으면 3차 진입은 취소하고 현금을 보유",
      ],
      negative: false,
    },
    {
      label: "손절 기준",
      value:
        metrics.stopPrice != null
          ? formatAppPrice(metrics.stopPrice, currency)
          : "산출 불가",
      reason:
        "이 가격 아래에서 일봉이 마감하면 지지선이 무너져 기존 상승 시나리오가 틀렸을 가능성이 커집니다. 물타기보다 위험 축소를 우선합니다.",
      checklist: [
        "장중 순간 이탈보다 일봉 종가 기준으로 판단",
        "대량 거래를 동반한 이탈이면 더 빠르게 위험 축소",
        "손실을 만회하려고 계획 없는 추가 매수 금지",
      ],
      negative: true,
    },
    {
      label: "목표가 · 분할매도",
      value:
        metrics.targetPrice != null
          ? formatAppPrice(metrics.targetPrice, currency)
          : "산출 불가",
      reason:
        "목표가에 한 번에 모두 매도하지 않고 상승 강도와 거래량을 보며 나누어 이익을 확정합니다.",
      checklist: [
        "목표가의 95% 부근에서 30% 이익 실현 검토",
        "목표가 도달 시 추가 40% 이익 실현 검토",
        "나머지는 5일선 이탈 전까지 추세를 따라가기",
      ],
      negative: false,
    },
  ];

  return (
    <div className="space-y-3">
      <SectionCard title="AI 종합 판단" subtitle="현재 데이터 기준">
        <div className="grid grid-cols-3 gap-2">
          <MiniMetric
            label="AI 점수"
            value={`${Math.round(insights.score)}점`}
            valueClassName={scoreTone(insights.score)}
          />

          <MiniMetric
            label="AI 의견"
            value={insights.opinion || "관망"}
            valueClassName={opinionTone(insights.opinion)}
          />

          <MiniMetric
            label="위험도"
            value={metrics.riskLabel}
            valueClassName={riskTone(metrics.riskLabel)}
          />
        </div>

        <InfoBox>{insights.opinionReason}</InfoBox>
      </SectionCard>

      <CollapsibleSection
        title="차트"
        open={openSections.chart}
        onToggle={() => toggleSection("chart")}
      >
        <button
          type="button"
          onClick={() =>
            setAnalysisModal({
              title: "차트 분석",
              text:
                (insights.chartSummary ?? []).join(" ") ||
                "차트 분석 데이터가 부족합니다.",
            })
          }
          className="w-full text-left"
        >
          <SummaryItems items={insights.chartSummary} />
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="재무"
        open={openSections.financial}
        onToggle={() => toggleSection("financial")}
      >
        <button
          type="button"
          onClick={() =>
            setAnalysisModal({
              title: "재무 분석",
              text:
                (insights.financialSummary ?? []).join(" ") ||
                "재무 분석 데이터가 부족합니다.",
            })
          }
          className="w-full text-left"
        >
          <SummaryItems items={insights.financialSummary} />
        </button>
      </CollapsibleSection>

      <CollapsibleSection
        title="최근 소식"
        open={openSections.news}
        onToggle={() => toggleSection("news")}
      >
        <div className="grid grid-cols-2 gap-2">
          <SignalBox
            label="호재"
            text={positiveSummary(insights)}
            positive
            compact
            onClick={() =>
              setAnalysisModal({
                title: "최근 호재",
                text:
                  (insights.newsDisclosureSummary ?? [])
                    .filter((row) =>
                      /상승|증가|개선|성장|호재|긍정|강세|흑자|계약|수주|돌파|우수/.test(
                        row,
                      ),
                    )
                    .join(" ") || "최근 확인된 뚜렷한 호재가 없습니다.",
              })
            }
          />

          <SignalBox
            label="악재"
            text={negativeSummary(insights)}
            compact
            onClick={() =>
              setAnalysisModal({
                title: "최근 악재",
                text:
                  [
                    ...(insights.riskSummary ?? []),
                    ...(insights.newsDisclosureSummary ?? []),
                  ]
                    .filter((row) =>
                      /하락|감소|악화|부진|악재|부정|약세|적자|위험|과열|부채|주의/.test(
                        row,
                      ),
                    )
                    .join(" ") || "최근 확인된 뚜렷한 악재가 없습니다.",
              })
            }
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection
        title="AI 진입 계획"
        open={openSections.plan}
        onToggle={() => toggleSection("plan")}
      >
        <p className="mb-2 text-[10px] font-bold text-muted-foreground">
          각 계획을 누르면 진입 근거와 확인 조건이 열립니다
        </p>
        <div className="space-y-2">
          {planRows.map((plan) => (
            <PlanRow
              key={plan.label}
              label={plan.label}
              value={plan.value}
              negative={plan.negative}
              onClick={() => setSelectedPlan(plan)}
            />
          ))}
        </div>
      </CollapsibleSection>

      {analysisModal && (
        <Modal
          title={analysisModal.title}
          onClose={() => setAnalysisModal(null)}
        >
          <p>{analysisModal.text}</p>
        </Modal>
      )}

      {selectedPlan && (
        <Modal
          title={selectedPlan.label}
          subtitle={selectedPlan.value}
          onClose={() => setSelectedPlan(null)}
        >
          <p>{selectedPlan.reason}</p>
          <div className="mt-3 space-y-2">
            {selectedPlan.checklist.map((item, index) => (
              <div
                key={item}
                className="flex gap-2 rounded-xl bg-secondary/60 p-3"
              >
                <span className="font-extrabold text-primary">{index + 1}</span>
                <p>{item}</p>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function technicalSignalFocus(title: string, text: string): StudyChartFocus {
  const lower = title.toLowerCase();
  const preferredIndicator = lower.includes("rsi")
    ? "rsi"
    : lower.includes("macd")
      ? "macd"
      : lower.includes("볼린저")
        ? "bollinger"
        : lower.includes("거래량") || lower.includes("obv")
          ? "volume"
          : lower.includes("이동평균") || lower.includes("고점")
            ? "moving-average"
            : undefined;
  const markerStrategy: StudyMarkerStrategy = lower.includes("거래량")
    ? "highest-volume"
    : lower.includes("고점") || lower.includes("돌파")
      ? "breakout"
      : lower.includes("과매도") || lower.includes("저점")
        ? "recent-low"
        : "latest";
  return {
    id: `signal-${title}`,
    title,
    summary: text,
    markerText: `${title} 확인`,
    markerStrategy,
    preferredIndicator,
  };
}

function ChartTab({
  ticker,
  fallbackRows,
  insights,
  currentPrice,
  currency,
  studyId,
  basicOnly,
  showAutoTradingData,
}: {
  ticker: string;
  fallbackRows: AnyObj[];
  insights: ReturnType<typeof buildAiInsights>;
  currentPrice: number | null;
  currency: Currency;
  studyId: string | null;
  basicOnly: boolean;
  showAutoTradingData: boolean;
}) {
  const storageKey = `sa-chart-state:${ticker}`;
  const storedChartState = useMemo(() => {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}") as {
        timeframe?: ChartTimeframe;
        indicators?: Partial<ChartIndicatorSettings>;
        technicalOpen?: boolean;
        summaryOpen?: boolean;
      };
      return parsed;
    } catch {
      return {};
    }
  }, [storageKey]);
  const [timeframe, setTimeframe] = useState<ChartTimeframe>(() =>
    TIMEFRAMES.some((item) => item.key === storedChartState.timeframe)
      ? storedChartState.timeframe!
      : "1D",
  );

  const [explanation, setExplanation] = useState<{
    title: string;
    text: string;
    focus: StudyChartFocus;
  } | null>(null);

  const [selectedPatternSignal, setSelectedPatternSignal] =
    useState<PatternSignalOccurrence | null>(null);
  const [patternModalOpen, setPatternModalOpen] = useState(false);
  const [patternHistoryOpen, setPatternHistoryOpen] = useState(false);
  const [levelExplanation, setLevelExplanation] = useState<{
    title: string;
    value: string;
    text: string;
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [signalPanelOpen, setSignalPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chartHeight, setChartHeight] = useState(() => {
    const stored = Number(
      localStorage.getItem(`sa-chart-price-height:${ticker}`) ?? 360,
    );
    return Number.isFinite(stored) ? Math.min(720, Math.max(260, stored)) : 360;
  });
  const [technicalOpen, setTechnicalOpen] = useState(
    storedChartState.technicalOpen ?? true,
  );
  const [summaryOpen, setSummaryOpen] = useState(
    storedChartState.summaryOpen ?? true,
  );
  const [indicators, setIndicators] = useState<ChartIndicatorSettings>({
    ...DEFAULT_CHART_INDICATORS,
    ...storedChartState.indicators,
  });
  const chartShellRef = useRef<HTMLDivElement | null>(null);
  const [portfolioOverlay, setPortfolioOverlay] =
    useState<PortfolioChartOverlay | null>(() =>
      getPortfolioChartOverlay(ticker),
    );
  const [autoSignal, setAutoSignal] = useState(() =>
    showAutoTradingData ? getAutoTradeSignal(ticker) : null,
  );
  const tradeJournal = useQuery<{ entries: AutoTradeChartEntry[] }>({
    queryKey: ["detail-auto-trade-journal", ticker],
    queryFn: async () => {
      const response = await authorizedFetch("/api/stocks/auto-trade/journal");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(payload?.message || "매매일지 조회 실패");
      return {
        entries: Array.isArray(payload?.entries) ? payload.entries : [],
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
    enabled: showAutoTradingData,
  });
  const tradeEntries = useMemo(
    () =>
      (tradeJournal.data?.entries ?? []).filter(
        (entry) => entry.ticker.toUpperCase() === ticker.toUpperCase(),
      ),
    [ticker, tradeJournal.data],
  );
  const studyFocus = useMemo(() => getStudyChartFocus(studyId), [studyId]);

  useEffect(() => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ timeframe, indicators, technicalOpen, summaryOpen }),
    );
  }, [storageKey, timeframe, indicators, technicalOpen, summaryOpen]);

  useEffect(() => {
    const refresh = () => {
      setPortfolioOverlay(getPortfolioChartOverlay(ticker));
      setAutoSignal(showAutoTradingData ? getAutoTradeSignal(ticker) : null);
    };

    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener("sa-portfolio-overlay-updated", refresh);
    window.addEventListener("sa-auto-trade-updated", refresh);

    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener("sa-portfolio-overlay-updated", refresh);
      window.removeEventListener("sa-auto-trade-updated", refresh);
    };
  }, [showAutoTradingData, ticker]);

  useEffect(() => {
    if (!studyFocus?.preferredIndicator) return;

    setIndicators((current) => {
      const next = { ...current };
      if (studyFocus.preferredIndicator === "rsi") next.rsi = true;
      if (studyFocus.preferredIndicator === "macd") next.macd = true;
      if (studyFocus.preferredIndicator === "bollinger") next.bollinger = true;
      if (studyFocus.preferredIndicator === "volume") next.volume = true;
      if (studyFocus.preferredIndicator === "moving-average") {
        next.sma20 = true;
        next.sma60 = true;
      }
      return next;
    });
  }, [studyFocus?.id]);

  useEffect(() => {
    localStorage.setItem(
      `sa-chart-price-height:${ticker}`,
      String(chartHeight),
    );
  }, [chartHeight, ticker]);

  useEffect(() => {
    setSelectedPatternSignal(null);
    setPatternModalOpen(false);
    setPatternHistoryOpen(false);
  }, [ticker, timeframe]);

  const beginPriceChartResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = chartHeight;
      const move = (moveEvent: PointerEvent) => {
        setChartHeight(
          Math.min(
            720,
            Math.max(260, startHeight + moveEvent.clientY - startY),
          ),
        );
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish, { once: true });
    },
    [chartHeight],
  );

  useEffect(() => {
    const handleFullscreenChange = () => {
      const shell = chartShellRef.current;
      const active = Boolean(shell && document.fullscreenElement === shell);

      if (!active && document.fullscreenElement == null) {
        setIsFullscreen(false);
      }
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);

    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreen]);

  async function toggleFullscreen() {
    const shell = chartShellRef.current;
    if (!shell) return;

    if (document.fullscreenElement === shell) {
      await document.exitFullscreen().catch(() => undefined);
      setIsFullscreen(false);

      const orientation = window.screen.orientation as
        | (ScreenOrientation & { unlock?: () => void })
        | undefined;
      orientation?.unlock?.();
      return;
    }

    try {
      await shell.requestFullscreen();
      setIsFullscreen(true);

      const orientation = window.screen.orientation as
        | (ScreenOrientation & {
            lock?: (mode: string) => Promise<void>;
          })
        | undefined;
      void orientation?.lock?.("landscape").catch(() => undefined);
    } catch {
      // 일부 모바일 브라우저/PWA는 Fullscreen API를 막습니다.
      // 이 경우 CSS 전체화면으로 동일하게 동작시킵니다.
      setIsFullscreen((current) => !current);
    }
  }

  const chartQuery = useQuery<CandlePoint[]>({
    queryKey: ["detail-chart-v9", ticker, timeframe],

    queryFn: () => fetchChartCandles(ticker, timeframe, fallbackRows),

    enabled: Boolean(ticker),

    staleTime: timeframe.endsWith("m") ? 5_000 : 30_000,

    gcTime: 5 * 60_000,

    refetchInterval: timeframe.endsWith("m") ? 5_000 : 30_000,

    refetchIntervalInBackground: true,

    refetchOnWindowFocus: true,
  });

  const candles =
    chartQuery.data ??
    (timeframe === "1D" ? normalizeCandles(fallbackRows) : []);

  const stats = useMemo(() => calculateChartStats(candles), [candles]);

  const recent = candles.slice(-20);
  const latest = recent[recent.length - 1];
  const previous = recent[recent.length - 2];
  const recentHigh = recent.length
    ? Math.max(...recent.slice(0, -1).map((item) => item.high))
    : null;
  const recentLow = recent.length
    ? Math.min(...recent.map((item) => item.low))
    : null;
  const stochastic =
    latest &&
    recentHigh != null &&
    recentLow != null &&
    recentHigh !== recentLow
      ? ((latest.close - recentLow) / (recentHigh - recentLow)) * 100
      : null;
  const momentum =
    latest && candles.length > 5
      ? (latest.close / candles[candles.length - 6].close - 1) * 100
      : null;
  const close20 = recent.map((item) => item.close);
  const average20 = close20.length
    ? close20.reduce((sum, value) => sum + value, 0) / close20.length
    : null;
  const standardDeviation =
    average20 != null && close20.length
      ? Math.sqrt(
          close20.reduce(
            (sum, value) => sum + Math.pow(value - average20, 2),
            0,
          ) / close20.length,
        )
      : null;
  const bollingerPosition =
    latest &&
    average20 != null &&
    standardDeviation != null &&
    standardDeviation > 0
      ? ((latest.close - (average20 - standardDeviation * 2)) /
          (standardDeviation * 4)) *
        100
      : null;
  const trueRanges = recent
    .slice(1)
    .map((item, index) =>
      Math.max(
        item.high - item.low,
        Math.abs(item.high - recent[index].close),
        Math.abs(item.low - recent[index].close),
      ),
    );
  const atr = trueRanges.length
    ? trueRanges.slice(-14).reduce((sum, value) => sum + value, 0) /
      Math.min(14, trueRanges.length)
    : null;
  const typicalPrices = recent.map(
    (item) => (item.high + item.low + item.close) / 3,
  );
  const typicalAverage = typicalPrices.length
    ? typicalPrices.reduce((sum, value) => sum + value, 0) /
      typicalPrices.length
    : null;
  const meanDeviation =
    typicalAverage != null && typicalPrices.length
      ? typicalPrices.reduce(
          (sum, value) => sum + Math.abs(value - typicalAverage),
          0,
        ) / typicalPrices.length
      : null;
  const cci =
    latest &&
    typicalAverage != null &&
    meanDeviation != null &&
    meanDeviation > 0
      ? ((latest.high + latest.low + latest.close) / 3 - typicalAverage) /
        (0.015 * meanDeviation)
      : null;
  const williamsR = stochastic != null ? stochastic - 100 : null;
  const roc10 =
    latest && candles.length > 10
      ? (latest.close / candles[candles.length - 11].close - 1) * 100
      : null;
  const obvPulse = recent.slice(1).reduce((sum, item, index) => {
    if (item.close > recent[index].close) return sum + item.volume;
    if (item.close < recent[index].close) return sum - item.volume;
    return sum;
  }, 0);
  const averageClose = (period: number) =>
    candles.length >= period
      ? candles.slice(-period).reduce((sum, item) => sum + item.close, 0) /
        period
      : null;
  const sma60Value = averageClose(60);
  const sma120Value = averageClose(120);
  const macdPercent =
    latest && latest.close > 0 && stats.macd != null
      ? (stats.macd / latest.close) * 100
      : null;
  const enabledIndicatorPanels = [
    indicators.rsi && {
      label: "RSI",
      value: stats.rsi != null ? stats.rsi.toFixed(1) : "-",
    },
    indicators.macd && {
      label: "MACD (현재가 대비)",
      value:
        macdPercent != null
          ? `${macdPercent >= 0 ? "+" : ""}${macdPercent.toFixed(3)}%`
          : "-",
    },
    indicators.stochastic && {
      label: "스토캐스틱",
      value: stochastic != null ? stochastic.toFixed(1) : "-",
    },
    indicators.ichimoku && { label: "일목균형표", value: stats.trend },
    indicators.atr && {
      label: "ATR",
      value: atr != null ? atr.toFixed(2) : "-",
    },
    indicators.cci && {
      label: "CCI",
      value: cci != null ? cci.toFixed(0) : "-",
    },
    indicators.obv && {
      label: "OBV",
      value: obvPulse > 0 ? "매수 우위" : obvPulse < 0 ? "매도 우위" : "중립",
    },
    indicators.williamsR && {
      label: "Williams %R",
      value: williamsR != null ? williamsR.toFixed(1) : "-",
    },
    indicators.roc && {
      label: "ROC",
      value:
        roc10 != null ? `${roc10 >= 0 ? "+" : ""}${roc10.toFixed(1)}%` : "-",
    },
  ].filter(Boolean) as { label: string; value: string }[];

  const signals = [
    {
      title:
        stats.rsi == null
          ? "RSI 확인 중"
          : stats.rsi <= 30
            ? "RSI 과매도"
            : stats.rsi >= 70
              ? "RSI 과매수"
              : "RSI 중립",

      value: stats.rsi != null ? stats.rsi.toFixed(1) : "-",

      text: "RSI는 단기 과열과 침체 정도를 보여주는 지표입니다.",
      active: stats.rsi != null && (stats.rsi <= 30 || stats.rsi >= 70),
    },

    {
      title:
        stats.macd == null
          ? "MACD 확인 중"
          : stats.macdSignal != null && stats.macd >= stats.macdSignal
            ? "MACD 상승 우위"
            : "MACD 약세 우위",

      value:
        macdPercent != null
          ? `${macdPercent >= 0 ? "+" : ""}${macdPercent.toFixed(3)}%`
          : "-",

      text: "MACD는 단기 추세와 전환 가능성을 확인하며, 값은 종목 간 비교가 쉽도록 현재가 대비 비율로 표시합니다.",
      active:
        stats.macd != null &&
        stats.macdSignal != null &&
        stats.macd >= stats.macdSignal,
    },

    {
      title: "이동평균선 (5·20·60·120)",

      value:
        latest && sma60Value != null
          ? latest.close >= sma60Value
            ? "60일선 위"
            : "60일선 아래"
          : stats.trend,

      text: `5·20일선은 단기, 60일선은 중기, 120일선은 장기 추세를 봅니다.${sma120Value != null && latest ? ` 현재가는 120일선 ${latest.close >= sma120Value ? "위" : "아래"}입니다.` : ""}`,
      active: stats.trend === "상승 우위",
    },

    {
      title:
        stats.volumeRatio != null && stats.volumeRatio >= 1.5
          ? "거래량 급증"
          : "거래량 상태",

      value:
        stats.volumeRatio != null ? `${stats.volumeRatio.toFixed(1)}배` : "-",

      text: "최근 거래량을 최근 20개 봉 평균과 비교한 값입니다.",
      active: stats.volumeRatio != null && stats.volumeRatio >= 1.5,
    },

    {
      title: "스토캐스틱",
      value: stochastic != null ? stochastic.toFixed(1) : "-",
      text: "최근 가격 범위에서 현재 종가의 위치를 보여줍니다. 20 이하는 과매도, 80 이상은 과매수 후보입니다.",
      active: stochastic != null && (stochastic <= 20 || stochastic >= 80),
    },

    {
      title: "5봉 모멘텀",
      value:
        momentum != null
          ? `${momentum >= 0 ? "+" : ""}${momentum.toFixed(1)}%`
          : "-",
      text: "현재 가격을 5개 봉 전과 비교해 상승 또는 하락 속도를 확인합니다.",
      active: momentum != null && momentum > 2,
    },

    {
      title: "20봉 고점 돌파",
      value:
        latest && recentHigh != null && latest.close > recentHigh
          ? "돌파"
          : "대기",
      text: "최근 20개 봉의 이전 고점을 종가로 넘어섰는지 확인하는 추세 신호입니다.",
      active: Boolean(
        latest && recentHigh != null && latest.close > recentHigh,
      ),
    },

    {
      title: "양봉 전환",
      value:
        latest &&
        previous &&
        latest.close > latest.open &&
        previous.close <= previous.open
          ? "발생"
          : "대기",
      text: "직전 음봉 뒤 현재 봉이 양봉으로 전환됐는지 보여주는 단기 반등 신호입니다.",
      active: Boolean(
        latest &&
          previous &&
          latest.close > latest.open &&
          previous.close <= previous.open,
      ),
    },
    {
      title: "볼린저밴드 위치",
      value:
        bollingerPosition != null ? `${bollingerPosition.toFixed(0)}%` : "-",
      text: "현재 가격이 볼린저밴드 하단과 상단 사이 어디에 있는지 보여줍니다.",
      active:
        bollingerPosition != null &&
        (bollingerPosition <= 10 || bollingerPosition >= 90),
    },
    {
      title: "ATR 변동성",
      value:
        atr != null && latest
          ? `${((atr / latest.close) * 100).toFixed(1)}%`
          : "-",
      text: "ATR은 최근 봉의 평균 가격 변동폭입니다. 높을수록 손절 폭을 넓게 잡아야 합니다.",
      active: Boolean(atr != null && latest && atr / latest.close >= 0.03),
    },
    {
      title: "CCI 추세 강도",
      value: cci != null ? cci.toFixed(0) : "-",
      text: "CCI는 평균 가격에서 얼마나 벗어났는지 보여줍니다. +100 이상은 강세, -100 이하는 약세 후보입니다.",
      active: cci != null && Math.abs(cci) >= 100,
    },
    {
      title: "Williams %R",
      value: williamsR != null ? williamsR.toFixed(1) : "-",
      text: "최근 고가와 저가 범위에서 현재 가격 위치를 확인합니다. -80 이하는 과매도 후보입니다.",
      active: williamsR != null && (williamsR <= -80 || williamsR >= -20),
    },
    {
      title: "10봉 ROC",
      value:
        roc10 != null ? `${roc10 >= 0 ? "+" : ""}${roc10.toFixed(1)}%` : "-",
      text: "10개 봉 전보다 가격이 얼마나 빠르게 상승하거나 하락했는지 보여줍니다.",
      active: roc10 != null && Math.abs(roc10) >= 5,
    },
    {
      title: "OBV 수급 방향",
      value: obvPulse > 0 ? "매수 우위" : obvPulse < 0 ? "매도 우위" : "중립",
      text: "상승일과 하락일의 거래량을 누적해 매수·매도 수급 방향을 추정합니다.",
      active: obvPulse > 0,
    },
  ];

  const buyScore = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        50 +
          (stats.trend === "상승 우위"
            ? 18
            : stats.trend === "하락 우위"
              ? -18
              : 0) +
          ((stats.rsi ?? 50) >= 45 && (stats.rsi ?? 50) <= 68
            ? 12
            : (stats.rsi ?? 50) >= 75
              ? -10
              : 0) +
          ((stats.volumeRatio ?? 1) >= 1.5 ? 10 : 0) +
          (stats.macd != null &&
          stats.macdSignal != null &&
          stats.macd >= stats.macdSignal
            ? 10
            : -5),
      ),
    ),
  );
  const sellScore = Math.max(0, Math.min(100, 100 - buyScore));
  const liveDecision =
    buyScore >= 68 ? "매수 우위" : buyScore <= 38 ? "매도 우위" : "관망";
  const analysisBasePrice = latest?.close ?? currentPrice;
  const technicalRisk =
    analysisBasePrice == null
      ? null
      : Math.max(atr != null ? atr * 1.5 : 0, analysisBasePrice * 0.02);
  const technicalMarket: Market = currency === "USD" ? "US" : "KR";
  const technicalEntry =
    analysisBasePrice == null
      ? null
      : roundPrice(analysisBasePrice, technicalMarket);
  const technicalStop =
    analysisBasePrice != null && technicalRisk != null
      ? roundPrice(
          Math.max(0, analysisBasePrice - technicalRisk),
          technicalMarket,
        )
      : null;
  const technicalTarget1 =
    analysisBasePrice != null && technicalRisk != null
      ? roundPrice(analysisBasePrice + technicalRisk, technicalMarket)
      : null;
  const technicalTarget2 =
    analysisBasePrice != null && technicalRisk != null
      ? roundPrice(analysisBasePrice + technicalRisk * 2, technicalMarket)
      : null;
  const technicalRiskAmount =
    technicalEntry != null && technicalStop != null
      ? technicalEntry - technicalStop
      : null;
  const technicalReward1 =
    technicalEntry != null && technicalTarget1 != null
      ? technicalTarget1 - technicalEntry
      : null;
  const technicalReward2 =
    technicalEntry != null && technicalTarget2 != null
      ? technicalTarget2 - technicalEntry
      : null;
  const technicalRiskReward1 =
    technicalRiskAmount != null &&
    technicalRiskAmount > 0 &&
    technicalReward1 != null &&
    technicalReward1 >= 0
      ? technicalReward1 / technicalRiskAmount
      : null;
  const technicalRiskReward2 =
    technicalRiskAmount != null &&
    technicalRiskAmount > 0 &&
    technicalReward2 != null &&
    technicalReward2 >= 0
      ? technicalReward2 / technicalRiskAmount
      : null;
  const technicalDataCount = [
    stats.rsi,
    stats.macd,
    stats.macdSignal,
    stats.volumeRatio,
    atr,
  ].filter((value) => value != null && Number.isFinite(value)).length;
  const technicalConfidence = Math.min(
    95,
    Math.max(
      35,
      Math.round(
        35 + Math.abs(buyScore - sellScore) * 0.45 + technicalDataCount * 3,
      ),
    ),
  );
  const technicalChartLevels = useMemo<TechnicalChartLevels | null>(
    () =>
      basicOnly
        ? null
        : {
            entry: technicalEntry,
            stop: technicalStop,
            target1: technicalTarget1,
            target2: technicalTarget2,
          },
    [
      basicOnly,
      technicalEntry,
      technicalStop,
      technicalTarget1,
      technicalTarget2,
    ],
  );
  const liveSignalRows = [
    {
      label: "추세",
      value: stats.trend,
      active: stats.trend !== "혼조" && stats.trend !== "확인 중",
    },
    {
      label: "RSI",
      value:
        stats.rsi == null
          ? "계산 중"
          : `${stats.rsi.toFixed(1)} · ${stats.rsi >= 70 ? "과매수" : stats.rsi <= 30 ? "과매도" : "중립"}`,
      active: stats.rsi != null,
    },
    {
      label: "MACD",
      value:
        stats.macd == null || stats.macdSignal == null
          ? "계산 중"
          : stats.macd >= stats.macdSignal
            ? "상승 교차 우위"
            : "하락 교차 우위",
      active: stats.macd != null,
    },
    {
      label: "거래량",
      value:
        stats.volumeRatio == null
          ? "계산 중"
          : `${stats.volumeRatio.toFixed(1)}배${stats.volumeRatio >= 1.5 ? " · 증가" : ""}`,
      active: (stats.volumeRatio ?? 0) >= 1.5,
    },
    {
      label: "최근 봉",
      value:
        latest == null
          ? "대기 중"
          : latest.close >= latest.open
            ? "양봉 진행"
            : "음봉 진행",
      active: latest != null,
    },
  ];

  const chartRowsForSignals = useMemo(() => buildChartRows(candles), [candles]);
  const candlePatternSignals = useMemo(
    () => (basicOnly ? [] : buildCandlePatternSignals(chartRowsForSignals)),
    [basicOnly, chartRowsForSignals],
  );
  const chartPatternSignals = useMemo(
    () => (basicOnly ? [] : buildChartPatternSignals(chartRowsForSignals)),
    [basicOnly, chartRowsForSignals],
  );
  const allPatternSignals = useMemo(
    () => [...candlePatternSignals, ...chartPatternSignals],
    [candlePatternSignals, chartPatternSignals],
  );
  const matchingPatternHistory = useMemo(() => {
    if (!selectedPatternSignal) return [];
    return allPatternSignals
      .filter(
        (item) =>
          item.kind === selectedPatternSignal.kind &&
          item.name === selectedPatternSignal.name,
      )
      .sort((a, b) => Number(b.endTime) - Number(a.endTime));
  }, [allPatternSignals, selectedPatternSignal]);

  const selectPatternSignal = useCallback((signal: PatternSignalOccurrence) => {
    setSelectedPatternSignal(signal);
    setPatternHistoryOpen(false);
    setPatternModalOpen(true);
  }, []);

  const openTechnicalLevelExplanation = useCallback(
    (level: TechnicalLevelKey) => {
      const frame =
        TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe;
      const volatilityBasis =
        atr != null && analysisBasePrice != null
          ? `ATR ${atr.toFixed(2)}의 1.5배와 기준가의 2% 중 더 큰 폭을 사용했습니다.`
          : "ATR 데이터가 부족해 기준가의 2% 폭을 사용했습니다.";
      const common = `${frame} 최신 봉 기준입니다. ${volatilityBasis} 실제 주문 가격이 아니라 차트 위험관리 참고값입니다.`;
      const rows: Record<
        TechnicalLevelKey,
        { title: string; value: string; text: string }
      > = {
        entry: {
          title: "매수가 산출 근거",
          value: formatAppPrice(technicalEntry, currency),
          text: `현재 매수가는 최신 봉 종가를 시장 호가 단위에 맞춰 반올림한 기준가입니다. ${common}`,
        },
        sell: {
          title: "매도 판단 근거",
          value: `${sellScore}점 · ${liveDecision}`,
          text: `매도 점수는 하락 추세, RSI 과열, MACD 약세와 거래량 상태를 합산한 참고 점수입니다. 현재 매도 점수는 ${sellScore}점이며 종합 판단은 ${liveDecision}입니다. 목표가 도달, 손절가 이탈, 추세 약화 여부를 함께 확인합니다.`,
        },
        stop: {
          title: "기술적 손절가 산출 근거",
          value: formatAppPrice(technicalStop, currency),
          text: `매수가에서 예상 변동 위험폭을 뺀 가격입니다. ${common} 종가가 손절가 아래에서 유지되면 현재 분석 가정이 무효화된 것으로 봅니다.`,
        },
        target1: {
          title: "목표가 1 산출 근거",
          value: formatAppPrice(technicalTarget1, currency),
          text: `매수가에서 위험폭 1배를 더한 1차 목표입니다. 현재 손익비는 ${technicalRiskReward1 == null ? "산출 불가" : `1 : ${technicalRiskReward1.toFixed(1)}`}입니다. ${common}`,
        },
        target2: {
          title: "목표가 2 산출 근거",
          value: formatAppPrice(technicalTarget2, currency),
          text: `매수가에서 위험폭 2배를 더한 2차 목표입니다. 현재 손익비는 ${technicalRiskReward2 == null ? "산출 불가" : `1 : ${technicalRiskReward2.toFixed(1)}`}입니다. 목표가 1 도달 후 일부 이익을 보호하는 방식으로 확인합니다. ${common}`,
        },
      };
      setLevelExplanation(rows[level]);
    },
    [
      analysisBasePrice,
      atr,
      currency,
      liveDecision,
      sellScore,
      technicalEntry,
      technicalRiskReward1,
      technicalRiskReward2,
      technicalStop,
      technicalTarget1,
      technicalTarget2,
      timeframe,
    ],
  );

  const portfolioRate =
    portfolioOverlay &&
    currentPrice != null &&
    portfolioOverlay.averagePrice > 0
      ? ((currentPrice - portfolioOverlay.averagePrice) /
          portfolioOverlay.averagePrice) *
        100
      : (portfolioOverlay?.rate ?? null);
  const purchaseTimestamp = portfolioOverlay
    ? Date.parse(portfolioOverlay.purchaseDate)
    : Number.NaN;
  const portfolioCandles = portfolioOverlay
    ? candles.filter((item) => {
        const time = Date.parse(item.date);
        return (
          Number.isNaN(purchaseTimestamp) ||
          Number.isNaN(time) ||
          time >= purchaseTimestamp
        );
      })
    : [];
  const highestAfterPurchase = portfolioCandles.length
    ? Math.max(...portfolioCandles.map((item) => item.high))
    : null;
  const highToCurrentRate =
    highestAfterPurchase && currentPrice != null
      ? ((currentPrice - highestAfterPurchase) / highestAfterPurchase) * 100
      : null;

  return (
    <div className="space-y-3">
      {!basicOnly && portfolioOverlay && (
        <SectionCard
          title="내 포트폴리오 기준"
          subtitle={`수량 ${portfolioOverlay.quantity.toLocaleString("ko-KR")} · 차트에 내 평단과 매수 후 최고점을 표시합니다`}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-secondary/70 p-3">
              <p className="text-[10px] font-bold text-muted-foreground">
                내 평단가
              </p>
              <p className="mt-1 text-sm font-extrabold">
                {formatAppPrice(portfolioOverlay.averagePrice, currency)}
              </p>
            </div>
            <div className="rounded-xl bg-secondary/70 p-3">
              <p className="text-[10px] font-bold text-muted-foreground">
                현재 수익률
              </p>
              <p
                className={cn(
                  "mt-1 text-sm font-extrabold",
                  (portfolioRate ?? 0) >= 0
                    ? "text-positive"
                    : "text-destructive",
                )}
              >
                {portfolioRate == null
                  ? "확인 중"
                  : `${portfolioRate >= 0 ? "+" : ""}${portfolioRate.toFixed(2)}%`}
              </p>
            </div>
            <div className="rounded-xl bg-secondary/70 p-3">
              <p className="text-[10px] font-bold text-muted-foreground">
                매수 후 최고가
              </p>
              <p className="mt-1 text-sm font-extrabold">
                {formatAppPrice(highestAfterPurchase, currency)}
              </p>
            </div>
            <div className="rounded-xl bg-secondary/70 p-3">
              <p className="text-[10px] font-bold text-muted-foreground">
                최고점 대비 현재
              </p>
              <p
                className={cn(
                  "mt-1 text-sm font-extrabold",
                  (highToCurrentRate ?? 0) >= 0
                    ? "text-positive"
                    : "text-destructive",
                )}
              >
                {highToCurrentRate == null
                  ? "확인 중"
                  : `${highToCurrentRate >= 0 ? "+" : ""}${highToCurrentRate.toFixed(2)}%`}
              </p>
            </div>
          </div>
          <p className="mt-2 break-keep text-[11px] font-semibold leading-5 text-muted-foreground">
            차트의 ‘내 평단’과 ‘매수후 최고’ 점선으로 현재 손익과 고점 대비
            낙폭을 확인할 수 있습니다.
          </p>
        </SectionCard>
      )}

      {!basicOnly && autoSignal && (
        <SectionCard
          title={autoSignal.label}
          subtitle={`${autoSignal.candidate.rank}순위 · 조건 충족 확률 ${autoSignal.candidate.probability}%`}
        >
          <p className="break-keep text-sm font-semibold leading-6 text-muted-foreground">
            {autoSignal.candidate.reasons.join(" · ") ||
              "선택 지표와 AI 점수 기준"}{" "}
            조건으로 활성화되었습니다. 차트 최신 봉에 자동신호 위치와 손절·목표
            기준선을 표시합니다.
          </p>
        </SectionCard>
      )}

      {!basicOnly && studyFocus && (
        <SectionCard title={`주식공부 · ${studyFocus.title}`}>
          <p className="break-keep text-sm font-semibold leading-6 text-muted-foreground">
            {studyFocus.summary}
          </p>
        </SectionCard>
      )}

      {!basicOnly && (
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => setSignalPanelOpen(true)}
            className="relative rounded-xl border border-positive/40 bg-positive/10 px-2 py-3 text-[11px] font-extrabold text-positive transition active:scale-[0.98]"
          >
            <span className="absolute right-2 top-2 h-2 w-2 animate-pulse rounded-full bg-positive" />
            실시간 신호분석
          </button>
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="rounded-xl border border-card-border bg-card px-2 py-3 text-[11px] font-extrabold transition active:scale-[0.98]"
          >
            지난 내역
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center justify-center gap-1 rounded-xl border border-card-border bg-card px-2 py-3 text-[11px] font-extrabold transition active:scale-[0.98]"
          >
            <Settings2 className="h-3.5 w-3.5" /> 환경설정
          </button>
        </div>
      )}

      <div
        ref={chartShellRef}
        className={cn(
          isFullscreen &&
            "fixed inset-0 z-[80] overflow-y-auto bg-background p-2 sm:p-4",
        )}
      >
        <SectionCard
          title="차트"
          defaultOpen
          actions={
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="flex h-9 w-9 items-center justify-center rounded-xl border border-card-border bg-secondary text-foreground transition active:scale-95"
                aria-label={isFullscreen ? "전체화면 닫기" : "차트 전체화면"}
                title={isFullscreen ? "전체화면 닫기" : "전체화면"}
              >
                {isFullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            </div>
          }
        >
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <span className="rounded-lg bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
              현재 주기 ·{" "}
              {TIMEFRAMES.find((item) => item.key === timeframe)?.label ??
                timeframe}
            </span>

            <span className="text-[10px] font-bold text-muted-foreground">
              {chartQuery.isFetching ? "최신 데이터 확인 중" : "전체 조회 범위"}
            </span>
          </div>

          <ProfessionalChart
            candles={candles}
            loading={chartQuery.isLoading}
            timeframe={timeframe}
            indicators={indicators}
            fullscreen={isFullscreen}
            portfolioOverlay={basicOnly ? null : portfolioOverlay}
            autoSignal={showAutoTradingData ? autoSignal : null}
            studyFocus={basicOnly ? null : studyFocus}
            tradeEntries={showAutoTradingData ? tradeEntries : []}
            technicalLevels={technicalChartLevels}
            priceHeight={chartHeight}
            candleSignals={candlePatternSignals}
            chartSignals={chartPatternSignals}
            selectedSignal={selectedPatternSignal}
            onSignalSelect={selectPatternSignal}
            onTechnicalLevelSelect={openTechnicalLevelExplanation}
          />

          {!isFullscreen && (
            <button
              type="button"
              onPointerDown={beginPriceChartResize}
              className="mt-2 flex h-6 w-full touch-none cursor-row-resize items-center justify-center rounded-lg border border-card-border bg-secondary/70"
              aria-label="가격 차트 높이 조절"
              title="위아래로 끌어서 가격 차트 높이 조절"
            >
              <span className="h-1 w-14 rounded-full bg-muted-foreground/40" />
            </button>
          )}

          {!basicOnly && enabledIndicatorPanels.length > 0 && (
            <div className="mt-2 grid grid-cols-3 gap-2">
              {enabledIndicatorPanels.map((item) => (
                <div
                  key={item.label}
                  className="rounded-xl border border-card-border bg-secondary/60 p-2 text-center"
                >
                  <p className="text-[9px] font-bold text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="mt-1 text-xs font-extrabold">{item.value}</p>
                </div>
              ))}
            </div>
          )}

          <p className="mt-2 px-1 text-[10px] font-semibold leading-4 text-muted-foreground">
            차트를 드래그하면 이동하고, 두 손가락으로 확대·축소할 수 있습니다.
          </p>
        </SectionCard>

        {settingsOpen && (
          <Modal title="차트 설정" onClose={() => setSettingsOpen(false)}>
            <p className="mb-2 text-xs font-extrabold text-foreground">
              봉 주기
            </p>
            <div className="grid grid-cols-3 gap-2 rounded-xl border border-card-border p-2">
              {TIMEFRAMES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setTimeframe(item.key)}
                  className={cn(
                    "inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl px-2 py-2.5 text-[10px] font-extrabold",
                    timeframe === item.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <p className="mb-2 mt-5 text-xs font-extrabold text-foreground">
              가격 차트 지표
            </p>
            <div className="space-y-2">
              {(
                [
                  ["sma5", "5 이동평균선"],
                  ["sma20", "20 이동평균선"],
                  ["sma60", "60 이동평균선"],
                  ["sma120", "120 이동평균선"],
                  ["volume", "거래량"],
                  ["priceGrid", "가격 눈금선"],
                  ["bollinger", "볼린저 밴드"],
                  ["vwap", "VWAP 거래량가중평균"],
                  ["ichimoku", "일목균형표"],
                ] as const
              ).map(([key, label]) => (
                <ChartSettingToggle
                  key={key}
                  label={label}
                  enabled={indicators[key]}
                  onClick={() =>
                    setIndicators((current) => ({
                      ...current,
                      [key]: !current[key],
                    }))
                  }
                />
              ))}
            </div>

            <p className="mb-2 mt-5 text-xs font-extrabold text-foreground">
              보조지표 패널
            </p>
            <div className="space-y-2">
              {(
                [
                  ["rsi", "RSI 상대강도지수"],
                  ["macd", "MACD 추세·모멘텀"],
                  ["stochastic", "스토캐스틱"],
                  ["atr", "ATR 변동성"],
                  ["cci", "CCI 추세 강도"],
                  ["obv", "OBV 수급 방향"],
                  ["williamsR", "Williams %R"],
                  ["roc", "ROC 변화율"],
                ] as const
              ).map(([key, label]) => (
                <ChartSettingToggle
                  key={key}
                  label={label}
                  enabled={indicators[key]}
                  onClick={() =>
                    setIndicators((current) => ({
                      ...current,
                      [key]: !current[key],
                    }))
                  }
                />
              ))}
            </div>

            <p className="mb-2 mt-5 text-xs font-extrabold text-foreground">
              차트 높이
            </p>
            <div className="grid grid-cols-3 gap-2">
              {[
                [300, "작게"],
                [360, "기본"],
                [520, "크게"],
              ].map(([height, label]) => (
                <button
                  key={String(height)}
                  type="button"
                  onClick={() => setChartHeight(Number(height))}
                  className={cn(
                    "rounded-xl px-3 py-2.5 text-xs font-extrabold",
                    chartHeight === Number(height)
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[10px] font-semibold leading-4 text-muted-foreground">
              현재 {Math.round(chartHeight)}px · 차트 아래 손잡이를 끌어
              세밀하게 조절할 수 있습니다.
            </p>

            <div className="sticky bottom-0 mt-5 grid grid-cols-2 gap-2 border-t border-card-border bg-card pt-3">
              <button
                type="button"
                onClick={() => setIndicators({ ...DEFAULT_CHART_INDICATORS })}
                className="rounded-xl border border-card-border bg-secondary px-3 py-3 text-xs font-extrabold"
              >
                기본값 복원
              </button>

              <button
                type="button"
                onClick={() => setSettingsOpen(false)}
                className="rounded-xl bg-primary px-3 py-3 text-xs font-extrabold text-primary-foreground"
              >
                설정 완료
              </button>
            </div>
          </Modal>
        )}
      </div>

      {!basicOnly && signalPanelOpen && (
        <Modal
          title="실시간 신호분석"
          subtitle={`${TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe} · 최신 봉 기준`}
          onClose={() => setSignalPanelOpen(false)}
        >
          <div className="space-y-2">
            {liveSignalRows.map((item, index) => (
              <button
                key={item.label}
                type="button"
                onClick={() =>
                  setExplanation({
                    title: item.label,
                    text: `${item.label}: ${item.value}`,
                    focus: technicalSignalFocus(item.label, item.value),
                  })
                }
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border p-3 text-left",
                  item.active
                    ? "border-positive/40 bg-positive/10"
                    : "border-card-border bg-secondary/50",
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-extrabold text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold text-muted-foreground">
                    {item.label}
                  </p>
                  <p className="mt-0.5 break-keep text-xs font-extrabold">
                    {item.value}
                  </p>
                </div>
              </button>
            ))}
          </div>
          <div className="mt-3 rounded-xl bg-primary/10 p-3 text-xs font-bold leading-5">
            종합 판단 ·{" "}
            <span
              className={
                liveDecision === "매수 우위"
                  ? "text-positive"
                  : liveDecision === "매도 우위"
                    ? "text-destructive"
                    : "text-primary"
              }
            >
              {liveDecision}
            </span>
            <p className="mt-1 font-semibold text-muted-foreground">
              봉이 갱신될 때 React Query의 최신 데이터로 다시 계산됩니다.
              표시값은 분석 참고이며 주문 신호가 아닙니다.
            </p>
          </div>
        </Modal>
      )}

      {!basicOnly && historyOpen && (
        <Modal
          title="지난 신호 내역"
          subtitle={`현재 불러온 ${TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe} 범위`}
          onClose={() => setHistoryOpen(false)}
        >
          <div className="space-y-2">
            {signals.filter((item) => item.active).length === 0 ? (
              <p className="rounded-xl bg-secondary/60 p-4 text-center text-xs font-bold text-muted-foreground">
                현재 조회 범위에서 활성화된 주요 신호가 없습니다.
              </p>
            ) : (
              signals
                .filter((item) => item.active)
                .map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() =>
                      setExplanation({
                        title: item.title,
                        text: item.text,
                        focus: technicalSignalFocus(item.title, item.text),
                      })
                    }
                    className="w-full rounded-xl border border-card-border bg-secondary/50 p-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-extrabold">{item.title}</p>
                      <span className="rounded-full bg-positive/10 px-2 py-1 text-[9px] font-extrabold text-positive">
                        활성
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] font-bold text-muted-foreground">
                      {item.value}
                    </p>
                  </button>
                ))
            )}
          </div>
          <p className="mt-3 text-[10px] font-semibold leading-4 text-muted-foreground">
            이번 1차 버전은 현재 로드된 캔들의 신호를 보여줍니다. 서버 저장형
            날짜 검색·상태 병합·페이지네이션은 다음 단계에서 연결합니다.
          </p>
        </Modal>
      )}

      {!basicOnly && (
        <>
          <SectionCard title="실시간 차트분석" defaultOpen>
            <div className="grid grid-cols-3 gap-2">
              <MiniMetric
                label="매수 점수"
                value={`${buyScore}점`}
                valueClassName="text-positive"
              />
              <MiniMetric
                label="매도 점수"
                value={`${sellScore}점`}
                valueClassName="text-destructive"
              />
              <MiniMetric
                label="종합 판단"
                value={liveDecision}
                valueClassName={
                  liveDecision === "매수 우위"
                    ? "text-positive"
                    : liveDecision === "매도 우위"
                      ? "text-destructive"
                      : "text-primary"
                }
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <MiniMetric
                label="매수가"
                value={formatAppPrice(technicalEntry, currency)}
                valueClassName="text-amber-500"
              />
              <MiniMetric
                label="기술적 손절가"
                value={formatAppPrice(technicalStop, currency)}
                valueClassName="text-destructive"
              />
              <MiniMetric
                label="목표가 1"
                value={formatAppPrice(technicalTarget1, currency)}
                valueClassName="text-positive"
              />
              <MiniMetric
                label="목표가 2"
                value={formatAppPrice(technicalTarget2, currency)}
                valueClassName="text-positive"
              />
            </div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <MiniMetric
                label="손익비 1"
                value={
                  technicalRiskReward1 == null
                    ? "산출 불가"
                    : `1 : ${technicalRiskReward1.toFixed(1)}`
                }
              />
              <MiniMetric
                label="손익비 2"
                value={
                  technicalRiskReward2 == null
                    ? "산출 불가"
                    : `1 : ${technicalRiskReward2.toFixed(1)}`
                }
              />
              <MiniMetric
                label="신뢰도"
                value={`${technicalConfidence}%`}
                valueClassName="text-primary"
              />
            </div>
            <button
              type="button"
              onClick={() =>
                setExplanation({
                  title: "실시간 차트분석 근거",
                  text: `${TIMEFRAMES.find((item) => item.key === timeframe)?.label ?? timeframe} 기준 ${stats.trend}, RSI ${stats.rsi?.toFixed(1) ?? "데이터 없음"}, 거래량 ${stats.volumeRatio?.toFixed(1) ?? "-"}배를 종합했습니다. 매수가는 최신 봉 종가 기준이며, 손절·목표가는 ATR 또는 기준가 2% 중 큰 폭을 사용한 기술적 참고값입니다. 신뢰도는 방향 점수 차이와 계산 가능한 지표 수를 반영합니다.`,
                  focus: technicalSignalFocus(
                    "실시간 차트분석",
                    "최신 데이터 기준 분석입니다.",
                  ),
                })
              }
              className="mt-3 w-full rounded-xl bg-secondary/70 p-3 text-left text-xs font-bold leading-5 text-muted-foreground"
            >
              AI 근거 보기 ·{" "}
              {TIMEFRAMES.find((item) => item.key === timeframe)?.label ??
                timeframe}{" "}
              · {stats.trend} · RSI {stats.rsi?.toFixed(1) ?? "-"} · 거래량{" "}
              {stats.volumeRatio?.toFixed(1) ?? "-"}배
            </button>
            <p className="mt-2 text-[10px] font-semibold leading-4 text-muted-foreground">
              매수가·손절가·목표가 1·2는 차트에도 가격선으로 표시됩니다. 실제
              주문값이 아닌 변동성 기반 참고값입니다.
            </p>
          </SectionCard>

          <SectionCard
            title="기술지표"
            defaultOpen
            subtitle="조건이 충족된 지표는 색으로 활성화됩니다"
          >
            <button
              type="button"
              onClick={() => setTechnicalOpen((value) => !value)}
              className="mb-2 flex w-full items-center justify-between rounded-xl bg-secondary px-3 py-2 text-xs font-extrabold"
            >
              <span>
                {technicalOpen ? "기술지표가 펼쳐져 있습니다" : "기술지표 보기"}
              </span>
              <span>{technicalOpen ? "접기 ▲" : "열기 ▼"}</span>
            </button>
            {technicalOpen && (
              <div className="grid grid-cols-2 gap-2">
                {signals.map((item) => (
                  <button
                    key={item.title}
                    type="button"
                    onClick={() =>
                      setExplanation({
                        title: item.title,

                        text: item.text,
                        focus: technicalSignalFocus(item.title, item.text),
                      })
                    }
                    className={cn(
                      "rounded-xl border p-3 text-left transition",
                      item.active
                        ? "border-positive/50 bg-positive/10 shadow-sm"
                        : "border-card-border bg-secondary/50",
                    )}
                  >
                    <p className="text-[10px] font-bold text-muted-foreground">
                      {item.title}
                    </p>

                    <p className="mt-1 text-base font-extrabold">
                      {item.value}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="AI 차트 요약"
            defaultOpen
            subtitle="현재 차트 흐름을 간단히 설명합니다"
          >
            <button
              type="button"
              onClick={() => setSummaryOpen((value) => !value)}
              className="mb-2 flex w-full items-center justify-between rounded-xl bg-secondary px-3 py-2 text-xs font-extrabold"
            >
              <span>
                {summaryOpen ? "차트요약이 펼쳐져 있습니다" : "차트요약 보기"}
              </span>
              <span>{summaryOpen ? "접기 ▲" : "열기 ▼"}</span>
            </button>
            {summaryOpen && (
              <div className="space-y-2">
                {insights.chartSummary.map((item, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() =>
                      setExplanation({
                        title: `AI 차트 요약 ${index + 1}`,
                        text: item,
                        focus: technicalSignalFocus("AI 차트 요약", item),
                      })
                    }
                    className="w-full break-keep rounded-xl bg-secondary/70 px-3 py-2 text-left text-xs font-bold leading-relaxed text-muted-foreground"
                  >
                    {item}
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          <MarketFlowPanel ticker={ticker} />

          <ShortSellingPanel ticker={ticker} />
        </>
      )}

      {!basicOnly && explanation && (
        <Modal
          title={explanation.title}
          subtitle="현재 메인 차트 기준 설명"
          onClose={() => setExplanation(null)}
        >
          <p>{explanation.text}</p>
          <div className="mt-3 rounded-xl bg-primary/10 p-3 text-xs font-semibold leading-5 text-muted-foreground">
            <p className="font-extrabold text-primary">왜 활성화됐나요?</p>
            <p className="mt-1">
              현재 계산값이 해당 지표의 기준 범위에 들어왔기 때문입니다. 팝업
              안에 차트를 새로 만들지 않아 로딩을 줄였으며, 메인 차트의
              봉·거래량·추세를 함께 확인하세요.
            </p>
          </div>
        </Modal>
      )}

      {!basicOnly && patternModalOpen && selectedPatternSignal && (
        <Modal
          title={`${selectedPatternSignal.kind === "candle" ? "봉 신호" : "차트 신호"} · ${selectedPatternSignal.name}`}
          subtitle={`${selectedPatternSignal.dateLabel} · 차트가 해당 구간으로 이동했습니다`}
          onClose={() => setPatternModalOpen(false)}
        >
          <div className="rounded-xl border border-card-border bg-secondary/50 p-3">
            <div className="flex items-center justify-between gap-2">
              <span
                className="rounded-full px-2 py-1 text-[10px] font-extrabold text-white"
                style={{ backgroundColor: selectedPatternSignal.color }}
              >
                {selectedPatternSignal.direction === "up"
                  ? "상승 후보"
                  : selectedPatternSignal.direction === "down"
                    ? "하락 후보"
                    : "중립"}
              </span>
              <span className="text-xs font-extrabold">
                {formatAppPrice(selectedPatternSignal.price, currency)}
              </span>
            </div>
            <p className="mt-3 text-sm font-extrabold text-foreground">
              {selectedPatternSignal.reason}
            </p>
            <p className="mt-2 text-xs font-semibold leading-5 text-muted-foreground">
              {selectedPatternSignal.explanation}
            </p>
          </div>
          <div className="mt-3 rounded-xl bg-primary/10 p-3 text-xs font-semibold leading-5 text-muted-foreground">
            차트에는 선택한 패턴 구간만 굵은 선으로 표시됩니다. 팝업을 닫으면
            이동한 위치를 바로 확인할 수 있습니다.
          </div>
          <button
            type="button"
            onClick={() => setPatternHistoryOpen((value) => !value)}
            className="mt-3 w-full rounded-xl border border-card-border bg-secondary px-3 py-3 text-xs font-extrabold text-foreground"
          >
            지난 차트 보기{" "}
            {patternHistoryOpen
              ? "접기 ▲"
              : `열기 ▼ · ${matchingPatternHistory.length}건`}
          </button>
          {patternHistoryOpen && (
            <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
              {matchingPatternHistory.map((signal) => (
                <button
                  key={signal.id}
                  type="button"
                  onClick={() => setSelectedPatternSignal(signal)}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left",
                    signal.id === selectedPatternSignal.id
                      ? "border-primary bg-primary/10"
                      : "border-card-border bg-secondary/50",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-extrabold">{signal.dateLabel}</p>
                    <span
                      className="text-[10px] font-extrabold"
                      style={{ color: signal.color }}
                    >
                      {formatAppPrice(signal.price, currency)}
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] font-semibold leading-4 text-muted-foreground">
                    {signal.reason}
                  </p>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => {
              setPatternModalOpen(false);
              setSelectedPatternSignal(null);
            }}
            className="mt-3 w-full rounded-xl px-3 py-2 text-xs font-bold text-muted-foreground"
          >
            차트 강조 해제
          </button>
        </Modal>
      )}

      {!basicOnly && levelExplanation && (
        <Modal
          title={levelExplanation.title}
          subtitle="가격선 계산 근거"
          onClose={() => setLevelExplanation(null)}
        >
          <div className="rounded-xl bg-secondary/60 p-4 text-center">
            <p className="text-[10px] font-bold text-muted-foreground">
              현재 표시값
            </p>
            <p className="mt-1 text-xl font-extrabold text-foreground">
              {levelExplanation.value}
            </p>
          </div>
          <p className="mt-3 text-xs font-semibold leading-6 text-muted-foreground">
            {levelExplanation.text}
          </p>
        </Modal>
      )}
    </div>
  );
}

type FlowPeriod = "daily" | "weekly" | "monthly" | "yearly";

const FLOW_PERIOD_TABS: Array<[FlowPeriod, string]> = [
  ["daily", "일별"],
  ["weekly", "주별"],
  ["monthly", "월별"],
  ["yearly", "년별"],
];

const FLOW_PERIOD_LABEL: Record<FlowPeriod, string> = {
  daily: "일별",
  weekly: "주별",
  monthly: "월별",
  yearly: "년별",
};

function flowCompact(value: number): string {
  if (!Number.isFinite(value)) return "제공 불가";
  return Math.abs(value) >= 100_000_000
    ? `${(value / 100_000_000).toFixed(1)}억`
    : Math.round(value).toLocaleString("ko-KR");
}

// 수급현황 — 개인/외국인/기관/프로그램 순매수, 거래량/거래대금, 기준일, 공급자
function MarketFlowPanel({ ticker }: { ticker: string }) {
  const [period, setPeriod] = useState<FlowPeriod>("daily");
  const [selectedActor, setSelectedActor] = useState<string | null>(null);
  const [selectedFlowMetric, setSelectedFlowMetric] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const flow = useQuery<AnyObj>({
    queryKey: ["market-flow", ticker, period],
    queryFn: async () => {
      const response = await authorizedFetch(
        `/api/stocks/${ticker}/market-flow?period=${period}`,
      );
      if (!response.ok) throw new Error("market flow unavailable");
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const totals = flow.data?.totals ?? {};
  const hasProgram = totals.program != null;
  const actors = [
    {
      key: "individual",
      label: "개인",
      value: Number(totals.individual ?? 0),
      has: totals.individual != null,
    },
    {
      key: "foreign",
      label: "외국인",
      value: Number(totals.foreign ?? 0),
      has: totals.foreign != null,
    },
    {
      key: "institution",
      label: "기관",
      value: Number(totals.institution ?? 0),
      has: totals.institution != null,
    },
    {
      key: "program",
      label: "프로그램",
      value: Number(totals.program ?? 0),
      has: hasProgram,
    },
  ];
  const dominant = [...actors]
    .filter((a) => a.has)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  const flowSummary =
    flow.data?.available && dominant
      ? dominant.value >= 0
        ? `${dominant.label} 매수가 가장 많아요. ${dominant.label} 수급이 이어지는지 조금 더 확인해 보세요.`
        : `${dominant.label} 매도가 가장 많아요. 매도세가 이어지면 추가 하락 위험이 있어 주의가 필요합니다.`
      : "투자자별 실제 매매 데이터를 확인 중입니다.";
  const periodLabel = FLOW_PERIOD_LABEL[period];
  const provider = firstText(flow.data?.provider, flow.data?.source);
  const updatedAt = firstText(flow.data?.updatedAt, flow.data?.lastUpdated);
  const baseDate = firstText(flow.data?.rows?.[0]?.date) ?? "집계 중";
  const summaryLine = flow.isLoading
    ? "수급 데이터 확인 중"
    : flow.data?.available
      ? `${periodLabel} 기준 · ${baseDate}`
      : "제공 불가";

  return (
    <SectionCard title="수급현황" subtitle={summaryLine} defaultOpen>
      <div className="grid grid-cols-4 gap-1.5">
        {FLOW_PERIOD_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setPeriod(key)}
            className={cn(
              "inline-flex items-center justify-center break-keep leading-tight rounded-lg px-2 py-2 text-center text-[10px] font-extrabold",
              period === key
                ? "bg-primary/15 text-primary"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <p className="mb-2 text-center text-[10px] font-extrabold text-muted-foreground">
          최신 {periodLabel} 합산 · {baseDate}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {actors.map((actor) => (
            <button
              key={actor.key}
              type="button"
              onClick={() => setSelectedActor(actor.label)}
              className={cn(
                "rounded-xl border p-3 text-center",
                !actor.has
                  ? "border-card-border bg-secondary/50"
                  : actor.value > 0
                    ? "border-positive/40 bg-positive/10"
                    : actor.value < 0
                      ? "border-destructive/40 bg-destructive/10"
                      : "border-card-border bg-secondary/50",
              )}
            >
              <p className="text-[10px] font-bold text-muted-foreground">
                {actor.label}
              </p>
              <p
                className={cn(
                  "mt-1 text-sm font-extrabold",
                  actor.has && actor.value > 0
                    ? "text-positive"
                    : actor.has && actor.value < 0
                      ? "text-destructive"
                      : "",
                )}
              >
                {!actor.has
                  ? "제공 불가"
                  : `${actor.value > 0 ? "+" : ""}${flowCompact(actor.value)}`}
              </p>
              <p className="mt-1 text-[9px] font-bold text-muted-foreground">
                {!actor.has ? "" : actor.value >= 0 ? "순매수" : "순매도"}
              </p>
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <FlowMetric
            label="거래량"
            value={
              totals.volume != null
                ? flowCompact(Number(totals.volume))
                : "제공 불가"
            }
            onClick={() =>
              setSelectedFlowMetric({
                title: "거래량 설명",
                text:
                  totals.volume != null
                    ? `${periodLabel}에 체결된 실제 거래 수량의 합계입니다. 거래량 증가가 가격 방향과 함께 이어지는지 확인합니다.`
                    : "현재 공급자 응답에 거래량 데이터가 없습니다.",
              })
            }
          />
          <FlowMetric
            label="거래대금"
            value={
              totals.value != null || totals.tradeValue != null
                ? flowCompact(Number(totals.value ?? totals.tradeValue))
                : "제공 불가"
            }
            onClick={() =>
              setSelectedFlowMetric({
                title: "거래대금 설명",
                text:
                  totals.value != null || totals.tradeValue != null
                    ? `${periodLabel} 거래량과 가격을 바탕으로 집계한 실제 거래대금입니다. 규모가 커질수록 시장 참여가 활발한지 확인할 수 있습니다.`
                    : "현재 공급자 응답에 거래대금 데이터가 없습니다.",
              })
            }
          />
        </div>

        <p className="mt-3 break-keep rounded-xl bg-secondary/70 p-3 text-center text-xs font-bold leading-relaxed text-muted-foreground">
          {flowSummary}
        </p>

        {Array.isArray(flow.data?.rows) && flow.data.rows.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {flow.data.rows.slice(0, 5).map((row: AnyObj, index: number) => (
              <div
                key={row.date ?? index}
                className="grid grid-cols-4 gap-1 rounded-xl border border-card-border px-2 py-2 text-center text-[10px]"
              >
                <span>{row.date}</span>
                <span
                  className={
                    Number(row.individual) >= 0
                      ? "text-positive"
                      : "text-destructive"
                  }
                >
                  개인 {flowCompact(Number(row.individual))}
                </span>
                <span
                  className={
                    Number(row.institution) >= 0
                      ? "text-positive"
                      : "text-destructive"
                  }
                >
                  기관 {flowCompact(Number(row.institution))}
                </span>
                <span
                  className={
                    Number(row.foreign) >= 0
                      ? "text-positive"
                      : "text-destructive"
                  }
                >
                  외인 {flowCompact(Number(row.foreign))}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">
          데이터 공급자: {provider ?? "제공 불가"}
          {updatedAt
            ? ` · 갱신 ${new Date(updatedAt).toLocaleString("ko-KR")}`
            : ""}
        </p>
      </div>

      {selectedActor && (
        <Modal
          title={`${selectedActor} 수급 설명`}
          onClose={() => setSelectedActor(null)}
        >
          <p>
            {flow.data?.available
              ? flowSummary
              : "현재 API에서 투자자별 순매매 데이터가 제공되지 않았습니다."}
          </p>
        </Modal>
      )}
      {selectedFlowMetric && (
        <Modal
          title={selectedFlowMetric.title}
          onClose={() => setSelectedFlowMetric(null)}
        >
          <p>{selectedFlowMetric.text}</p>
        </Modal>
      )}
    </SectionCard>
  );
}

// 공매도현황 — 공매도 거래량/거래대금/비중/잔고, 대차잔고/변화량/이자율, 기준일, 공급자
function ShortSellingPanel({ ticker }: { ticker: string }) {
  const [period, setPeriod] = useState<FlowPeriod>("daily");
  const [selectedShortMetric, setSelectedShortMetric] = useState<{
    title: string;
    text: string;
  } | null>(null);
  const shortSelling = useQuery<AnyObj>({
    queryKey: ["short-selling", ticker, period],
    queryFn: async () => {
      const response = await authorizedFetch(
        `/api/stocks/${ticker}/short-selling?period=${period}`,
      );
      if (!response.ok) throw new Error("short selling unavailable");
      return response.json();
    },
    staleTime: 60_000,
    retry: false,
  });

  const latest = shortSelling.data?.latest ?? {};
  const available = Boolean(shortSelling.data?.available);
  const shortRatio = Number(latest.ratio ?? 0);
  const balanceRatio = Number(latest.balanceRatio ?? 0);
  const borrowRate = Number(latest.borrowRate ?? 0);
  const squeezeScore = Math.min(
    100,
    Math.round(shortRatio * 4 + balanceRatio * 6 + borrowRate * 3),
  );
  const squeezeText = !available
    ? shortSelling.isLoading
      ? "공매도 최신 데이터를 확인 중입니다."
      : String(
          shortSelling.data?.message ??
            "현재 제공처에서 공매도 데이터가 내려오지 않았습니다. 새로고침해 다시 확인해 주세요.",
        )
    : squeezeScore >= 70
      ? "공매도 부담이 높아 주가가 급등하면 숏스퀴즈 가능성도 큽니다."
      : squeezeScore >= 40
        ? "공매도 잔고가 다소 있어 거래량 증가 여부를 함께 보세요."
        : "현재 수치만 보면 숏스퀴즈 가능성은 높지 않습니다.";
  const periodLabel = FLOW_PERIOD_LABEL[period];
  const provider = firstText(
    shortSelling.data?.provider,
    shortSelling.data?.source,
  );
  const updatedAt = firstText(
    shortSelling.data?.updatedAt,
    shortSelling.data?.lastUpdated,
  );
  const baseDate = firstText(shortSelling.data?.rows?.[0]?.date) ?? "집계 중";
  const summaryLine = shortSelling.isLoading
    ? "공매도 데이터 확인 중"
    : available
      ? `${periodLabel} 기준 · 비중 ${shortRatio.toFixed(2)}%`
      : "제공 불가";

  const metric = (value: unknown, suffix = "", digits = 0): string => {
    if (value == null) return "제공 불가";
    const n = Number(value);
    if (!Number.isFinite(n)) return "제공 불가";
    return suffix === "%" ? `${n.toFixed(2)}%` : `${flowCompact(n)}${suffix}`;
  };

  return (
    <SectionCard title="공매도현황" subtitle={summaryLine} defaultOpen>
      <div className="grid grid-cols-4 gap-1.5">
        {FLOW_PERIOD_TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setPeriod(key)}
            className={cn(
              "inline-flex items-center justify-center break-keep leading-tight rounded-lg px-2 py-2 text-center text-[10px] font-extrabold",
              period === key
                ? "bg-primary/15 text-primary"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-3">
        <p className="mb-2 text-center text-[10px] font-extrabold text-muted-foreground">
          최신 {periodLabel} 합산 · {baseDate}
        </p>

        <div className="grid grid-cols-2 gap-2">
          <FlowMetric
            label="공매도 거래량"
            value={available ? metric(latest.shortVolume) : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "공매도 거래량 설명",
                text: available
                  ? "선택 기간에 공매도로 체결된 주식 수량입니다. 증가세가 이어지는지 가격 흐름과 함께 확인합니다."
                  : "현재 공급자에서 공매도 거래량을 제공하지 않았습니다.",
              })
            }
          />
          <FlowMetric
            label="공매도 거래대금"
            value={available ? metric(latest.shortValue) : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "공매도 거래대금 설명",
                text: available
                  ? "공매도 체결금액의 합계입니다. 거래량뿐 아니라 실제 금액 규모를 확인하는 항목입니다."
                  : "현재 공급자에서 공매도 거래대금을 제공하지 않았습니다.",
              })
            }
          />
          <FlowMetric
            label="공매도 비중"
            value={available ? metric(latest.ratio, "%") : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "공매도 비중 설명",
                text: available
                  ? `전체 거래 중 공매도가 차지한 비율은 ${metric(latest.ratio, "%")}입니다. 단독 수치보다 추세와 잔고를 함께 확인합니다.`
                  : "현재 공급자에서 공매도 비중을 제공하지 않았습니다.",
              })
            }
          />
          <FlowMetric
            label="공매도 잔고"
            value={
              available
                ? metric(latest.balance ?? latest.shortBalance)
                : "제공 불가"
            }
            onClick={() =>
              setSelectedShortMetric({
                title: "공매도 잔고 설명",
                text: available
                  ? "아직 상환되지 않은 공매도 잔량입니다. 잔고가 크면 향후 환매수 압력이 생길 수 있지만 즉시 상승을 뜻하지는 않습니다."
                  : "현재 공급자에서 공매도 잔고를 제공하지 않았습니다.",
              })
            }
          />
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          <FlowMetric
            label="대차잔고"
            value={available ? metric(latest.loanBalance) : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "대차잔고 설명",
                text: available
                  ? "주식을 빌린 뒤 아직 상환하지 않은 수량입니다. 공매도 가능 물량과 관련되지만 모두 공매도로 사용되는 것은 아닙니다."
                  : "현재 공급자에서 대차잔고를 제공하지 않았습니다.",
              })
            }
          />
          <FlowMetric
            label="대차 변화량"
            value={available ? metric(latest.loanChange) : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "대차 변화량 설명",
                text: available
                  ? "직전 집계 대비 대차잔고 증감입니다. 증가하면 빌린 주식이 늘었고 감소하면 상환이 진행됐을 가능성이 있습니다."
                  : "현재 공급자에서 대차 변화량을 제공하지 않았습니다.",
              })
            }
          />
          <FlowMetric
            label="대차 이자율"
            value={available ? metric(latest.borrowRate, "%") : "제공 불가"}
            onClick={() =>
              setSelectedShortMetric({
                title: "대차 이자율 설명",
                text: available
                  ? "주식을 빌리는 비용입니다. 이자율이 높으면 차입 수요 또는 물량 부족이 반영됐을 수 있습니다."
                  : "현재 공급자에서 대차 이자율을 제공하지 않았습니다.",
              })
            }
          />
        </div>

        <button
          type="button"
          onClick={() =>
            setSelectedShortMetric({
              title: "숏스퀴즈 가능성 설명",
              text: squeezeText,
            })
          }
          className="mt-3 w-full rounded-xl bg-secondary/70 p-3 text-center"
        >
          <div className="flex items-center justify-center gap-2">
            <p className="text-xs font-extrabold">숏스퀴즈 가능성</p>
            <p className="text-sm font-black text-primary">
              {available ? `${squeezeScore}점` : "제공 불가"}
            </p>
          </div>
          <p className="mt-2 break-keep text-xs font-bold leading-relaxed text-muted-foreground">
            {squeezeText}
          </p>
        </button>

        {!shortSelling.isLoading && !available && (
          <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-center">
            <p className="break-keep text-xs font-bold leading-relaxed text-amber-700 dark:text-amber-300">
              {String(
                shortSelling.data?.message ??
                  "공매도 원천 데이터가 비어 있습니다.",
              )}
            </p>
            <button
              type="button"
              onClick={() => void shortSelling.refetch()}
              className="mt-2 rounded-full bg-amber-500 px-3 py-1.5 text-[10px] font-extrabold text-white"
            >
              공매도 다시 불러오기
            </button>
          </div>
        )}

        {Array.isArray(shortSelling.data?.rows) &&
          shortSelling.data.rows.length > 0 && (
            <div className="mt-3 space-y-1.5">
              {shortSelling.data.rows
                .slice(0, 7)
                .map((row: AnyObj, index: number) => (
                  <div
                    key={row.date ?? index}
                    className="grid grid-cols-3 gap-2 rounded-xl border border-card-border px-3 py-2 text-center text-[10px] font-bold"
                  >
                    <span>{row.date}</span>
                    <span>
                      공매도 {flowCompact(Number(row.shortVolume ?? 0))}
                    </span>
                    <span>비중 {Number(row.ratio ?? 0).toFixed(2)}%</span>
                  </div>
                ))}
            </div>
          )}

        <p className="mt-3 text-center text-[10px] font-bold text-muted-foreground">
          데이터 공급자: {provider ?? "제공 불가"}
          {updatedAt
            ? ` · 갱신 ${new Date(updatedAt).toLocaleString("ko-KR")}`
            : ""}
        </p>
      </div>
      {selectedShortMetric && (
        <Modal
          title={selectedShortMetric.title}
          onClose={() => setSelectedShortMetric(null)}
        >
          <p>{selectedShortMetric.text}</p>
        </Modal>
      )}
    </SectionCard>
  );
}

function FlowMetric({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const className =
    "rounded-xl border border-card-border bg-secondary/50 p-3 text-center";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(className, "transition active:scale-[0.98]")}
      >
        <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
        <p className="mt-1 text-sm font-extrabold">{value}</p>
      </button>
    );
  }
  return (
    <div className={className}>
      <p className="text-[10px] font-bold text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-extrabold">{value}</p>
    </div>
  );
}

interface ChartCandleRow extends CandlePoint {
  time: UTCTimestamp;
}

interface ChartLineData {
  time: Time;
  value: number;
}

interface ChartHistogramData extends ChartLineData {
  color?: string;
}

interface AutoTradeChartEntry {
  id: string;
  ticker: string;
  name: string;
  market: "KR" | "US";
  currency: "KRW" | "USD";
  status: "OPEN" | "TAKE_PROFIT" | "STOP_LOSS" | "MANUAL_CLOSE";
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  entryOrderNo: string | null;
  exitOrderNo: string | null;
  openedAt: string;
  closedAt: string | null;
  profitPercent: number | null;
}

type IndicatorPanelKind =
  | "rsi"
  | "macd"
  | "stochastic"
  | "atr"
  | "cci"
  | "obv"
  | "williamsR"
  | "roc";

interface IndicatorPanelSeries {
  label: string;
  color: string;
  data: ChartLineData[];
  lineStyle?: LineStyle;
}

interface IndicatorPanelModel {
  title: string;
  latest: string;
  lines: IndicatorPanelSeries[];
  histogram?: ChartHistogramData[];
}

interface SupportResistanceLevels {
  support: number | null;
  resistance: number | null;
  supportBasis: string;
  resistanceBasis: string;
}

interface TechnicalChartLevels {
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
}

function chartTimestamp(
  value: string,
  index: number,
  total: number,
): UTCTimestamp {
  const raw = String(value ?? "").trim();
  const digitsOnly = raw.replace(/\D/g, "");

  if (/^\d{14}$/.test(digitsOnly)) {
    const year = Number(digitsOnly.slice(0, 4));
    const month = Number(digitsOnly.slice(4, 6)) - 1;
    const day = Number(digitsOnly.slice(6, 8));
    const hour = Number(digitsOnly.slice(8, 10));
    const minute = Number(digitsOnly.slice(10, 12));
    const second = Number(digitsOnly.slice(12, 14));

    return Math.floor(
      new Date(year, month, day, hour, minute, second).getTime() / 1000,
    ) as UTCTimestamp;
  }

  if (/^\d{12}$/.test(digitsOnly)) {
    const year = Number(digitsOnly.slice(0, 4));
    const month = Number(digitsOnly.slice(4, 6)) - 1;
    const day = Number(digitsOnly.slice(6, 8));
    const hour = Number(digitsOnly.slice(8, 10));
    const minute = Number(digitsOnly.slice(10, 12));

    return Math.floor(
      new Date(year, month, day, hour, minute).getTime() / 1000,
    ) as UTCTimestamp;
  }

  if (/^\d{8}$/.test(digitsOnly)) {
    const year = Number(digitsOnly.slice(0, 4));
    const month = Number(digitsOnly.slice(4, 6)) - 1;
    const day = Number(digitsOnly.slice(6, 8));

    return Math.floor(
      new Date(year, month, day).getTime() / 1000,
    ) as UTCTimestamp;
  }

  const numeric = Number(raw);

  if (Number.isFinite(numeric) && numeric > 1_000_000_000_000) {
    return Math.floor(numeric / 1000) as UTCTimestamp;
  }

  if (Number.isFinite(numeric) && numeric > 1_000_000_000) {
    return Math.floor(numeric) as UTCTimestamp;
  }

  if (!raw || /^\d{1,6}$/.test(raw)) {
    return Math.floor(Date.now() / 1000 - (total - index) * 60) as UTCTimestamp;
  }

  const parsed = Date.parse(raw);

  if (Number.isFinite(parsed)) {
    return Math.floor(parsed / 1000) as UTCTimestamp;
  }

  return Math.floor(Date.now() / 1000 - (total - index) * 60) as UTCTimestamp;
}

function buildChartRows(candles: CandlePoint[]): ChartCandleRow[] {
  const sorted = candles
    .map((item, index) => ({
      ...item,
      time: chartTimestamp(item.date, index, candles.length),
    }))
    .sort((a, b) => Number(a.time) - Number(b.time));

  let previous = 0;

  return sorted.map((item) => {
    const raw = Number(item.time);
    const next = raw <= previous ? previous + 1 : raw;
    previous = next;

    return {
      ...item,
      time: next as UTCTimestamp,
    };
  });
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function smaArray(values: number[], period: number): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  let sum = 0;

  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];

    if (index >= period) {
      sum -= values[index - period];
    }

    if (index >= period - 1) {
      result[index] = sum / period;
    }
  }

  return result;
}

function emaArray(
  values: Array<number | null>,
  period: number,
): Array<number | null> {
  const result = Array<number | null>(values.length).fill(null);
  const seed: number[] = [];
  const multiplier = 2 / (period + 1);
  let previous: number | null = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value == null) continue;

    if (previous == null) {
      seed.push(value);

      if (seed.length === period) {
        previous = average(seed);
        result[index] = previous;
      }

      continue;
    }

    previous = (value - previous) * multiplier + previous;
    result[index] = previous;
  }

  return result;
}

function lineDataFromValues(
  rows: ChartCandleRow[],
  values: Array<number | null>,
): ChartLineData[] {
  return values.flatMap((value, index) =>
    value == null || !Number.isFinite(value)
      ? []
      : [{ time: rows[index].time as Time, value }],
  );
}

function movingAverageData(
  rows: ChartCandleRow[],
  period: number,
): ChartLineData[] {
  return lineDataFromValues(
    rows,
    smaArray(
      rows.map((item) => item.close),
      period,
    ),
  );
}

function bollingerData(rows: ChartCandleRow[], period = 20) {
  const upper = Array<number | null>(rows.length).fill(null);
  const middle = Array<number | null>(rows.length).fill(null);
  const lower = Array<number | null>(rows.length).fill(null);

  for (let index = period - 1; index < rows.length; index += 1) {
    const values = rows
      .slice(index + 1 - period, index + 1)
      .map((item) => item.close);
    const mean = average(values);
    const deviation = Math.sqrt(
      average(values.map((value) => Math.pow(value - mean, 2))),
    );

    middle[index] = mean;
    upper[index] = mean + deviation * 2;
    lower[index] = mean - deviation * 2;
  }

  return {
    upper: lineDataFromValues(rows, upper),
    middle: lineDataFromValues(rows, middle),
    lower: lineDataFromValues(rows, lower),
  };
}

function vwapData(rows: ChartCandleRow[]): ChartLineData[] {
  let cumulativeValue = 0;
  let cumulativeVolume = 0;

  return rows.map((item) => {
    const volume = Math.max(item.volume, 0);
    const typicalPrice = (item.high + item.low + item.close) / 3;
    cumulativeValue += typicalPrice * volume;
    cumulativeVolume += volume;

    return {
      time: item.time as Time,
      value:
        cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : item.close,
    };
  });
}

function ichimokuData(rows: ChartCandleRow[]) {
  const conversion = Array<number | null>(rows.length).fill(null);
  const base = Array<number | null>(rows.length).fill(null);
  const spanA = Array<number | null>(rows.length).fill(null);
  const spanB = Array<number | null>(rows.length).fill(null);

  const midpoint = (index: number, period: number) => {
    if (index < period - 1) return null;
    const range = rows.slice(index + 1 - period, index + 1);
    return (
      (Math.max(...range.map((item) => item.high)) +
        Math.min(...range.map((item) => item.low))) /
      2
    );
  };

  for (let index = 0; index < rows.length; index += 1) {
    conversion[index] = midpoint(index, 9);
    base[index] = midpoint(index, 26);
    spanB[index] = midpoint(index, 52);

    if (conversion[index] != null && base[index] != null) {
      spanA[index] = (conversion[index]! + base[index]!) / 2;
    }
  }

  return {
    conversion: lineDataFromValues(rows, conversion),
    base: lineDataFromValues(rows, base),
    spanA: lineDataFromValues(rows, spanA),
    spanB: lineDataFromValues(rows, spanB),
  };
}

function rsiValues(rows: ChartCandleRow[], period = 14): Array<number | null> {
  const values = rows.map((item) => item.close);
  const result = Array<number | null>(values.length).fill(null);
  if (values.length <= period) return result;

  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain += Math.max(change, 0);
    averageLoss += Math.max(-change, 0);
  }

  averageGain /= period;
  averageLoss /= period;
  result[period] =
    averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[index] =
      averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }

  return result;
}

function stochasticValues(
  rows: ChartCandleRow[],
  period = 14,
): Array<number | null> {
  const result = Array<number | null>(rows.length).fill(null);

  for (let index = period - 1; index < rows.length; index += 1) {
    const window = rows.slice(index + 1 - period, index + 1);
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    result[index] =
      high === low ? 50 : ((rows[index].close - low) / (high - low)) * 100;
  }

  return result;
}

function atrValues(rows: ChartCandleRow[], period = 14): Array<number | null> {
  const trueRanges = rows.map((item, index) => {
    if (index === 0) return item.high - item.low;
    const previousClose = rows[index - 1].close;
    return Math.max(
      item.high - item.low,
      Math.abs(item.high - previousClose),
      Math.abs(item.low - previousClose),
    );
  });

  const result = Array<number | null>(rows.length).fill(null);
  if (trueRanges.length < period) return result;

  let current = average(trueRanges.slice(0, period));
  result[period - 1] = current;

  for (let index = period; index < trueRanges.length; index += 1) {
    current = (current * (period - 1) + trueRanges[index]) / period;
    result[index] = current;
  }

  return result;
}

function cciValues(rows: ChartCandleRow[], period = 20): Array<number | null> {
  const typical = rows.map((item) => (item.high + item.low + item.close) / 3);
  const result = Array<number | null>(rows.length).fill(null);

  for (let index = period - 1; index < rows.length; index += 1) {
    const values = typical.slice(index + 1 - period, index + 1);
    const mean = average(values);
    const deviation = average(values.map((value) => Math.abs(value - mean)));
    result[index] =
      deviation === 0 ? 0 : (typical[index] - mean) / (0.015 * deviation);
  }

  return result;
}

function obvValues(rows: ChartCandleRow[]): Array<number | null> {
  const result = Array<number | null>(rows.length).fill(null);
  if (!rows.length) return result;

  let value = 0;
  result[0] = value;

  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].close > rows[index - 1].close) value += rows[index].volume;
    if (rows[index].close < rows[index - 1].close) value -= rows[index].volume;
    result[index] = value;
  }

  return result;
}

function williamsRValues(
  rows: ChartCandleRow[],
  period = 14,
): Array<number | null> {
  const result = Array<number | null>(rows.length).fill(null);

  for (let index = period - 1; index < rows.length; index += 1) {
    const window = rows.slice(index + 1 - period, index + 1);
    const high = Math.max(...window.map((item) => item.high));
    const low = Math.min(...window.map((item) => item.low));
    result[index] =
      high === low ? -50 : ((high - rows[index].close) / (high - low)) * -100;
  }

  return result;
}

function rocValues(rows: ChartCandleRow[], period = 10): Array<number | null> {
  const result = Array<number | null>(rows.length).fill(null);

  for (let index = period; index < rows.length; index += 1) {
    const previous = rows[index - period].close;
    result[index] =
      previous === 0 ? 0 : (rows[index].close / previous - 1) * 100;
  }

  return result;
}

function constantLine(rows: ChartCandleRow[], value: number): ChartLineData[] {
  if (!rows.length) return [];

  return [
    { time: rows[0].time as Time, value },
    { time: rows[rows.length - 1].time as Time, value },
  ];
}

function latestLineValue(data: ChartLineData[]): number | null {
  const value = data[data.length - 1]?.value;
  return Number.isFinite(value) ? value : null;
}

function calculateSupportResistance(
  rows: ChartCandleRow[],
  indicators: ChartIndicatorSettings,
): SupportResistanceLevels {
  if (rows.length < 2) {
    return {
      support: null,
      resistance: null,
      supportBasis: "데이터 부족",
      resistanceBasis: "데이터 부족",
    };
  }

  const recent = rows.slice(-Math.min(rows.length, 240));
  const latestClose = recent[recent.length - 1].close;
  const candidates: Array<{ value: number; basis: string }> = [];

  for (let index = 2; index < recent.length - 2; index += 1) {
    const row = recent[index];
    const neighbors = [
      recent[index - 2],
      recent[index - 1],
      recent[index + 1],
      recent[index + 2],
    ];

    if (neighbors.every((item) => row.low <= item.low)) {
      candidates.push({ value: row.low, basis: "스윙 저점" });
    }
    if (neighbors.every((item) => row.high >= item.high)) {
      candidates.push({ value: row.high, basis: "스윙 고점" });
    }
  }

  const closes = rows.map((item) => item.close);
  const addLatestAverage = (enabled: boolean, period: number) => {
    if (!enabled) return;
    const value = smaArray(closes, period)[rows.length - 1];
    if (value != null) candidates.push({ value, basis: `${period}봉 평균선` });
  };

  addLatestAverage(indicators.sma5, 5);
  addLatestAverage(indicators.sma20, 20);
  addLatestAverage(indicators.sma60, 60);
  addLatestAverage(indicators.sma120, 120);

  if (indicators.bollinger) {
    const band = bollingerData(rows);
    const lower = latestLineValue(band.lower);
    const upper = latestLineValue(band.upper);
    if (lower != null) candidates.push({ value: lower, basis: "볼린저 하단" });
    if (upper != null) candidates.push({ value: upper, basis: "볼린저 상단" });
  }

  if (indicators.vwap) {
    const value = latestLineValue(vwapData(rows));
    if (value != null) candidates.push({ value, basis: "VWAP" });
  }

  if (indicators.ichimoku) {
    const cloud = ichimokuData(rows);
    for (const [data, basis] of [
      [cloud.base, "일목 기준선"],
      [cloud.spanA, "일목 선행스팬1"],
      [cloud.spanB, "일목 선행스팬2"],
    ] as Array<[ChartLineData[], string]>) {
      const value = latestLineValue(data);
      if (value != null) candidates.push({ value, basis });
    }
  }

  const valid = candidates.filter(
    (item) => Number.isFinite(item.value) && item.value > 0,
  );
  const supportCandidates = valid
    .filter((item) => item.value < latestClose)
    .sort((a, b) => b.value - a.value);
  const resistanceCandidates = valid
    .filter((item) => item.value > latestClose)
    .sort((a, b) => a.value - b.value);
  const fallbackSupport = Math.min(...recent.map((item) => item.low));
  const fallbackResistance = Math.max(...recent.map((item) => item.high));
  const support = supportCandidates[0] ?? {
    value: fallbackSupport,
    basis: "조회 구간 저점",
  };
  const resistance = resistanceCandidates[0] ?? {
    value: fallbackResistance,
    basis: "조회 구간 고점",
  };

  return {
    support: Number.isFinite(support.value) ? support.value : null,
    resistance: Number.isFinite(resistance.value) ? resistance.value : null,
    supportBasis: support.basis,
    resistanceBasis: resistance.basis,
  };
}

function mergeChartMarkers(markers: AnyObj[]): AnyObj[] {
  const grouped = new Map<string, AnyObj>();

  for (const marker of markers) {
    const key = `${Number(marker.time)}:${marker.position}`;
    const existing = grouped.get(key);
    if (existing) {
      const labels = new Set(
        `${existing.text} · ${marker.text}`.split(" · ").filter(Boolean),
      );
      existing.text = [...labels].join(" · ");
      continue;
    }
    grouped.set(key, { ...marker });
  }

  return [...grouped.values()].sort(
    (a, b) =>
      Number(a.time) - Number(b.time) ||
      String(a.position).localeCompare(String(b.position)),
  );
}

function buildTechnicalSignalMarkers(
  rows: ChartCandleRow[],
  indicators: ChartIndicatorSettings,
): AnyObj[] {
  if (rows.length < 3) return [];

  const markers: AnyObj[] = [];
  const closes = rows.map((item) => item.close);
  const add = (
    index: number,
    direction: "up" | "down",
    text: string,
    color = direction === "up" ? "#22c55e" : "#ef4444",
    basis?: string,
  ) => {
    const row = rows[index];
    if (!row) return;
    const occurredAt = new Date(Number(row.time) * 1000).toLocaleString(
      "ko-KR",
    );
    markers.push({
      time: row.time,
      position: direction === "up" ? "belowBar" : "aboveBar",
      color,
      shape: direction === "up" ? "arrowUp" : "arrowDown",
      text,
      kind: "analysis",
      title: text,
      detail: `${occurredAt} · ${basis ?? "지표 조건 전환"} · 시가 ${row.open.toLocaleString("ko-KR")} · 고가 ${row.high.toLocaleString("ko-KR")} · 저가 ${row.low.toLocaleString("ko-KR")} · 종가 ${row.close.toLocaleString("ko-KR")} · 거래량 ${row.volume.toLocaleString("ko-KR")}`,
    });
  };

  if (indicators.sma5 && indicators.sma20) {
    const short = smaArray(closes, 5);
    const long = smaArray(closes, 20);
    for (let index = 20; index < rows.length; index += 1) {
      if (
        short[index - 1] == null ||
        long[index - 1] == null ||
        short[index] == null ||
        long[index] == null
      )
        continue;
      if (short[index - 1]! <= long[index - 1]! && short[index]! > long[index]!)
        add(
          index,
          "up",
          "골든크로스",
          "#22c55e",
          `5선 ${short[index]!.toFixed(2)}가 20선 ${long[index]!.toFixed(2)}를 상향 돌파`,
        );
      if (short[index - 1]! >= long[index - 1]! && short[index]! < long[index]!)
        add(
          index,
          "down",
          "데드크로스",
          "#ef4444",
          `5선 ${short[index]!.toFixed(2)}가 20선 ${long[index]!.toFixed(2)}를 하향 이탈`,
        );
    }
  }

  if (indicators.volume) {
    for (let index = 20; index < rows.length; index += 1) {
      const base = average(
        rows.slice(index - 20, index).map((item) => item.volume),
      );
      if (base > 0 && rows[index].volume >= base * 2) {
        add(
          index,
          rows[index].close >= rows[index].open ? "up" : "down",
          rows[index].close >= rows[index].open
            ? "매수 거래량 증가"
            : "매도 거래량 증가",
          "#f59e0b",
          `현재 거래량 ${rows[index].volume.toLocaleString("ko-KR")} · 20봉 평균 ${Math.round(base).toLocaleString("ko-KR")} · ${(rows[index].volume / base).toFixed(2)}배`,
        );
      }
    }
  }

  if (indicators.rsi) {
    const values = rsiValues(rows);
    for (let index = 15; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= 30 && values[index]! > 30)
        add(
          index,
          "up",
          "RSI 과매도 탈출",
          "#a855f7",
          `RSI ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 기준 30 상향 돌파`,
        );
      if (values[index - 1]! >= 70 && values[index]! < 70)
        add(
          index,
          "down",
          "RSI 과매수 이탈",
          "#a855f7",
          `RSI ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 기준 70 하향 이탈`,
        );
    }
  }

  if (indicators.macd) {
    const fast = emaArray(closes, 12);
    const slow = emaArray(closes, 26);
    const macd = closes.map((_, index) =>
      fast[index] != null && slow[index] != null
        ? fast[index]! - slow[index]!
        : null,
    );
    const signal = emaArray(macd, 9);
    for (let index = 1; index < rows.length; index += 1) {
      if (
        macd[index - 1] == null ||
        signal[index - 1] == null ||
        macd[index] == null ||
        signal[index] == null
      )
        continue;
      if (
        macd[index - 1]! <= signal[index - 1]! &&
        macd[index]! > signal[index]!
      )
        add(
          index,
          "up",
          "MACD 매수 전환",
          "#3b82f6",
          `MACD ${macd[index]!.toFixed(4)} · Signal ${signal[index]!.toFixed(4)} · 상향 교차`,
        );
      if (
        macd[index - 1]! >= signal[index - 1]! &&
        macd[index]! < signal[index]!
      )
        add(
          index,
          "down",
          "MACD 매도 전환",
          "#3b82f6",
          `MACD ${macd[index]!.toFixed(4)} · Signal ${signal[index]!.toFixed(4)} · 하향 교차`,
        );
    }
  }

  if (indicators.stochastic) {
    const values = stochasticValues(rows);
    for (let index = 15; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= 20 && values[index]! > 20)
        add(
          index,
          "up",
          "스토캐스틱 반등",
          "#06b6d4",
          `스토캐스틱 ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 기준 20 상향 돌파`,
        );
      if (values[index - 1]! >= 80 && values[index]! < 80)
        add(
          index,
          "down",
          "스토캐스틱 하락",
          "#06b6d4",
          `스토캐스틱 ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 기준 80 하향 이탈`,
        );
    }
  }

  if (indicators.bollinger) {
    const band = bollingerData(rows);
    const upper = new Map(
      band.upper.map((item) => [Number(item.time), item.value]),
    );
    const lower = new Map(
      band.lower.map((item) => [Number(item.time), item.value]),
    );
    for (let index = 1; index < rows.length; index += 1) {
      const previousUpper = upper.get(Number(rows[index - 1].time));
      const currentUpper = upper.get(Number(rows[index].time));
      const previousLower = lower.get(Number(rows[index - 1].time));
      const currentLower = lower.get(Number(rows[index].time));
      if (
        previousLower != null &&
        currentLower != null &&
        rows[index - 1].close <= previousLower &&
        rows[index].close > currentLower
      )
        add(
          index,
          "up",
          "볼린저 하단 복귀",
          "#14b8a6",
          `종가 ${rows[index].close.toFixed(2)} · 하단밴드 ${currentLower.toFixed(2)} 위로 복귀`,
        );
      if (
        previousUpper != null &&
        currentUpper != null &&
        rows[index - 1].close >= previousUpper &&
        rows[index].close < currentUpper
      )
        add(
          index,
          "down",
          "볼린저 상단 이탈",
          "#14b8a6",
          `종가 ${rows[index].close.toFixed(2)} · 상단밴드 ${currentUpper.toFixed(2)} 아래로 이탈`,
        );
    }
  }

  if (indicators.vwap) {
    const values = vwapData(rows).map((item) => item.value);
    for (let index = 1; index < rows.length; index += 1) {
      if (
        closes[index - 1] <= values[index - 1] &&
        closes[index] > values[index]
      )
        add(
          index,
          "up",
          "VWAP 상향 돌파",
          "#06b6d4",
          `종가 ${closes[index].toFixed(2)} · VWAP ${values[index].toFixed(2)} 상향 돌파`,
        );
      if (
        closes[index - 1] >= values[index - 1] &&
        closes[index] < values[index]
      )
        add(
          index,
          "down",
          "VWAP 하향 이탈",
          "#06b6d4",
          `종가 ${closes[index].toFixed(2)} · VWAP ${values[index].toFixed(2)} 하향 이탈`,
        );
    }
  }

  if (indicators.cci) {
    const values = cciValues(rows);
    for (let index = 1; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= -100 && values[index]! > -100)
        add(
          index,
          "up",
          "CCI 약세 탈출",
          "#22c55e",
          `CCI ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · -100 상향 돌파`,
        );
      if (values[index - 1]! >= 100 && values[index]! < 100)
        add(
          index,
          "down",
          "CCI 강세 이탈",
          "#22c55e",
          `CCI ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 100 하향 이탈`,
        );
    }
  }

  if (indicators.williamsR) {
    const values = williamsRValues(rows);
    for (let index = 1; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= -80 && values[index]! > -80)
        add(
          index,
          "up",
          "Williams %R 반등",
          "#ec4899",
          `Williams %R ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · -80 상향 돌파`,
        );
      if (values[index - 1]! >= -20 && values[index]! < -20)
        add(
          index,
          "down",
          "Williams %R 하락",
          "#ec4899",
          `Williams %R ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · -20 하향 이탈`,
        );
    }
  }

  if (indicators.roc) {
    const values = rocValues(rows);
    for (let index = 1; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= 0 && values[index]! > 0)
        add(
          index,
          "up",
          "ROC 상승 전환",
          "#8b5cf6",
          `ROC ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 0 상향 돌파`,
        );
      if (values[index - 1]! >= 0 && values[index]! < 0)
        add(
          index,
          "down",
          "ROC 하락 전환",
          "#8b5cf6",
          `ROC ${values[index - 1]!.toFixed(2)} → ${values[index]!.toFixed(2)} · 0 하향 이탈`,
        );
    }
  }

  return mergeChartMarkers(markers);
}

type PatternSignalKind = "candle" | "chart";
type PatternSignalDirection = "up" | "down" | "neutral";

interface PatternSignalOccurrence {
  id: string;
  kind: PatternSignalKind;
  name: string;
  direction: PatternSignalDirection;
  color: string;
  startIndex: number;
  endIndex: number;
  startTime: Time;
  endTime: Time;
  dateLabel: string;
  price: number;
  reason: string;
  explanation: string;
}

type TechnicalLevelKey = "entry" | "sell" | "stop" | "target1" | "target2";

function patternDirectionColor(direction: PatternSignalDirection): string {
  if (direction === "up") return "#22c55e";
  if (direction === "down") return "#ef4444";
  return "#a855f7";
}

function patternDateLabel(row: ChartCandleRow): string {
  return new Date(Number(row.time) * 1000).toLocaleString("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildCandlePatternSignals(
  rows: ChartCandleRow[],
): PatternSignalOccurrence[] {
  if (rows.length < 2) return [];
  const results: PatternSignalOccurrence[] = [];
  const seen = new Set<string>();
  const add = (
    name: string,
    direction: PatternSignalDirection,
    startIndex: number,
    endIndex: number,
    reason: string,
    explanation: string,
  ) => {
    const start = rows[Math.max(0, startIndex)];
    const end = rows[Math.min(rows.length - 1, endIndex)];
    if (!start || !end) return;
    const id = `candle:${name}:${Number(start.time)}:${Number(end.time)}`;
    if (seen.has(id)) return;
    seen.add(id);
    results.push({
      id,
      kind: "candle",
      name,
      direction,
      color: patternDirectionColor(direction),
      startIndex: Math.max(0, startIndex),
      endIndex: Math.min(rows.length - 1, endIndex),
      startTime: start.time,
      endTime: end.time,
      dateLabel: patternDateLabel(end),
      price: end.close,
      reason,
      explanation,
    });
  };

  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const body = Math.abs(current.close - current.open);
    const range = Math.max(current.high - current.low, Number.EPSILON);
    const upperWick = current.high - Math.max(current.open, current.close);
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const previousBody = Math.abs(previous.close - previous.open);

    if (
      previous.close < previous.open &&
      current.close > current.open &&
      current.open <= previous.close &&
      current.close >= previous.open
    ) {
      add(
        "상승장악형",
        "up",
        index - 1,
        index,
        "현재 양봉 몸통이 직전 음봉 몸통을 감쌌습니다.",
        "매도 우위였던 직전 봉을 다음 양봉이 완전히 덮은 반전 후보입니다. 다음 봉의 고점 돌파와 거래량 증가가 함께 나오면 신뢰도가 높아집니다.",
      );
    }
    if (
      previous.close > previous.open &&
      current.close < current.open &&
      current.open >= previous.close &&
      current.close <= previous.open
    ) {
      add(
        "하락장악형",
        "down",
        index - 1,
        index,
        "현재 음봉 몸통이 직전 양봉 몸통을 감쌌습니다.",
        "매수 우위였던 직전 봉을 다음 음봉이 완전히 덮은 하락 반전 후보입니다. 다음 봉의 저점 이탈과 거래량 증가를 함께 확인해야 합니다.",
      );
    }

    if (body / range <= 0.1) {
      add(
        "도지",
        "neutral",
        index,
        index,
        "시가와 종가가 매우 가까워 매수·매도 힘이 균형을 이뤘습니다.",
        "도지는 방향 확정 신호가 아니라 추세가 잠시 멈춘 상태입니다. 다음 봉이 도지의 고가 또는 저가 중 어느 쪽을 돌파하는지 확인합니다.",
      );
    }
    if (
      lowerWick >= Math.max(body * 2, range * 0.45) &&
      upperWick <= range * 0.2
    ) {
      add(
        "망치형",
        "up",
        index,
        index,
        "긴 아래꼬리 뒤 종가가 저가에서 회복했습니다.",
        "장중 매도 압력이 강했지만 저가 매수가 들어와 가격을 끌어올린 봉입니다. 하락 추세 말미와 지지선 부근에서 의미가 커집니다.",
      );
    }
    if (
      upperWick >= Math.max(body * 2, range * 0.45) &&
      lowerWick <= range * 0.2
    ) {
      add(
        "역망치형",
        current.close >= current.open ? "up" : "down",
        index,
        index,
        "긴 위꼬리가 만들어져 장중 상단 가격에서 강한 공방이 있었습니다.",
        "역망치형은 위치에 따라 반등 후보 또는 상승 실패 신호가 될 수 있습니다. 다음 봉의 고가 돌파 여부로 확인합니다.",
      );
    }

    if (index >= 2) {
      const first = rows[index - 2];
      const middle = rows[index - 1];
      const firstBody = Math.abs(first.close - first.open);
      const middleBody = Math.abs(middle.close - middle.open);
      if (
        first.close < first.open &&
        middleBody <= firstBody * 0.5 &&
        current.close > current.open &&
        current.close >= (first.open + first.close) / 2
      ) {
        add(
          "샛별형",
          "up",
          index - 2,
          index,
          "큰 음봉 뒤 작은 몸통과 강한 양봉이 이어졌습니다.",
          "3개 봉으로 구성된 상승 반전 후보입니다. 세 번째 양봉이 첫 번째 음봉 몸통의 절반 이상을 회복할 때 의미가 커집니다.",
        );
      }
      if (
        first.close > first.open &&
        middleBody <= firstBody * 0.5 &&
        current.close < current.open &&
        current.close <= (first.open + first.close) / 2
      ) {
        add(
          "석별형",
          "down",
          index - 2,
          index,
          "큰 양봉 뒤 작은 몸통과 강한 음봉이 이어졌습니다.",
          "3개 봉으로 구성된 하락 반전 후보입니다. 세 번째 음봉이 첫 번째 양봉 몸통의 절반 이상을 되돌릴 때 의미가 커집니다.",
        );
      }
      if (
        first.close > first.open &&
        middle.close > middle.open &&
        current.close > current.open &&
        first.close < middle.close &&
        middle.close < current.close
      ) {
        add(
          "적삼병",
          "up",
          index - 2,
          index,
          "종가가 연속으로 높아지는 3개의 양봉이 나타났습니다.",
          "매수세가 3개 봉 동안 이어진 추세 강화 패턴입니다. 이미 급등한 자리에서는 추격매수 위험도 함께 확인합니다.",
        );
      }
      if (
        first.close < first.open &&
        middle.close < middle.open &&
        current.close < current.open &&
        first.close > middle.close &&
        middle.close > current.close
      ) {
        add(
          "흑삼병",
          "down",
          index - 2,
          index,
          "종가가 연속으로 낮아지는 3개의 음봉이 나타났습니다.",
          "매도세가 3개 봉 동안 이어진 추세 약화 패턴입니다. 지지선과 과매도 구간에서는 반등 가능성도 함께 확인합니다.",
        );
      }
    }
  }

  return results.sort((a, b) => Number(a.endTime) - Number(b.endTime));
}

function buildChartPatternSignals(
  rows: ChartCandleRow[],
): PatternSignalOccurrence[] {
  if (rows.length < 21) return [];
  const results: PatternSignalOccurrence[] = [];
  const seen = new Set<string>();
  const closes = rows.map((row) => row.close);
  const add = (
    name: string,
    direction: PatternSignalDirection,
    startIndex: number,
    endIndex: number,
    reason: string,
    explanation: string,
  ) => {
    const start = rows[Math.max(0, startIndex)];
    const end = rows[Math.min(rows.length - 1, endIndex)];
    if (!start || !end) return;
    const id = `chart:${name}:${Number(start.time)}:${Number(end.time)}`;
    if (seen.has(id)) return;
    seen.add(id);
    results.push({
      id,
      kind: "chart",
      name,
      direction,
      color: patternDirectionColor(direction),
      startIndex: Math.max(0, startIndex),
      endIndex: Math.min(rows.length - 1, endIndex),
      startTime: start.time,
      endTime: end.time,
      dateLabel: patternDateLabel(end),
      price: end.close,
      reason,
      explanation,
    });
  };

  const short = smaArray(closes, 5);
  const long = smaArray(closes, 20);
  for (let index = 20; index < rows.length; index += 1) {
    if (
      short[index - 1] != null &&
      long[index - 1] != null &&
      short[index] != null &&
      long[index] != null
    ) {
      if (
        short[index - 1]! <= long[index - 1]! &&
        short[index]! > long[index]!
      ) {
        add(
          "골든크로스",
          "up",
          Math.max(0, index - 8),
          Math.min(rows.length - 1, index + 3),
          `5선 ${short[index]!.toFixed(2)}가 20선 ${long[index]!.toFixed(2)}를 상향 돌파했습니다.`,
          "단기 이동평균선이 중기 이동평균선을 위로 통과한 추세 전환 후보입니다. 거래량과 상위 시간봉 방향이 같을수록 신뢰도가 높아집니다.",
        );
      }
      if (
        short[index - 1]! >= long[index - 1]! &&
        short[index]! < long[index]!
      ) {
        add(
          "데드크로스",
          "down",
          Math.max(0, index - 8),
          Math.min(rows.length - 1, index + 3),
          `5선 ${short[index]!.toFixed(2)}가 20선 ${long[index]!.toFixed(2)}를 하향 이탈했습니다.`,
          "단기 이동평균선이 중기 이동평균선을 아래로 통과한 약세 전환 후보입니다. 지지선 이탈과 거래량 증가가 함께 나오는지 확인합니다.",
        );
      }
    }

    const priorRows = rows.slice(index - 20, index);
    const priorHigh = Math.max(...priorRows.map((row) => row.high));
    const priorLow = Math.min(...priorRows.map((row) => row.low));
    const averageVolume = average(priorRows.map((row) => row.volume));
    if (rows[index].close > priorHigh) {
      add(
        averageVolume > 0 && rows[index].volume >= averageVolume * 1.5
          ? "거래량 동반 돌파"
          : "고점 돌파",
        "up",
        index - 20,
        index,
        `직전 20봉 고점 ${priorHigh.toLocaleString("ko-KR")}을 종가로 돌파했습니다.`,
        "박스권 또는 이전 고점을 종가로 넘어선 추세 신호입니다. 돌파 후 이전 고점이 지지선으로 유지되는지 확인합니다.",
      );
    }
    if (rows[index].close < priorLow) {
      add(
        averageVolume > 0 && rows[index].volume >= averageVolume * 1.5
          ? "거래량 동반 이탈"
          : "지지선 이탈",
        "down",
        index - 20,
        index,
        `직전 20봉 저점 ${priorLow.toLocaleString("ko-KR")}을 종가로 이탈했습니다.`,
        "박스권 또는 이전 지지선을 종가로 내려간 약세 신호입니다. 이탈한 지지선이 저항선으로 바뀌는지 확인합니다.",
      );
    }
  }

  return results.sort((a, b) => Number(a.endTime) - Number(b.endTime));
}

function applyPatternSignalFocus(
  chart: AnyObj | null,
  focusSeries: AnyObj | null,
  rows: ChartCandleRow[],
  signal: PatternSignalOccurrence | null,
) {
  if (!chart || !focusSeries) return;
  if (!signal || rows.length === 0) {
    focusSeries.setData([]);
    return;
  }
  const start = Math.max(0, Math.min(rows.length - 1, signal.startIndex));
  const end = Math.max(start, Math.min(rows.length - 1, signal.endIndex));
  let from = start;
  let to = end;
  if (from === to) {
    from = Math.max(0, from - 1);
    to = Math.min(rows.length - 1, to + 1);
  }
  focusSeries.applyOptions({ color: signal.color, lineWidth: 4 });
  focusSeries.setData(
    rows
      .slice(from, to + 1)
      .map((row) => ({ time: row.time, value: row.close })),
  );
  chart.timeScale().setVisibleLogicalRange({
    from: Math.max(-0.5, start - 7),
    to: Math.min(rows.length - 0.5, end + 7),
  });
}

function PatternSignalPanel({
  title,
  subtitle,
  signals,
  selectedId,
  onSelect,
}: {
  title: string;
  subtitle: string;
  signals: PatternSignalOccurrence[];
  selectedId?: string;
  onSelect: (signal: PatternSignalOccurrence) => void;
}) {
  const recent = signals.slice(-10).reverse();
  return (
    <section className="rounded-xl border border-card-border bg-background/70 p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-extrabold">{title}</p>
          <p className="mt-0.5 text-[9px] font-semibold text-muted-foreground">
            {subtitle}
          </p>
        </div>
        <span className="rounded-full bg-primary/10 px-2 py-1 text-[9px] font-extrabold text-primary">
          {signals.length}개
        </span>
      </div>
      {recent.length === 0 ? (
        <p className="mt-2 rounded-lg bg-secondary/60 px-3 py-3 text-center text-[10px] font-bold text-muted-foreground">
          현재 조회 범위에서 감지된 신호가 없습니다.
        </p>
      ) : (
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {recent.map((signal) => (
            <button
              key={signal.id}
              type="button"
              onClick={() => onSelect(signal)}
              className={cn(
                "min-w-[132px] rounded-xl border px-3 py-2.5 text-left transition active:scale-[0.98]",
                selectedId === signal.id
                  ? "border-primary bg-primary/10 shadow-sm"
                  : "border-card-border bg-secondary/50",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: signal.color }}
                />
                <p className="truncate text-[10px] font-extrabold">
                  {signal.name}
                </p>
              </div>
              <p className="mt-1 text-[9px] font-semibold text-muted-foreground">
                {signal.dateLabel}
              </p>
              <p className="mt-1 line-clamp-2 text-[9px] font-bold leading-4">
                {signal.reason}
              </p>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

interface NumberedSignal {
  number: number;
  time: Time;
  name: string;
  direction: "up" | "down";
  color: string;
  dateLabel: string;
  price: number;
  reason: string;
}

// 실제 로드된 캔들만으로 계산하는 결정적(deterministic) 신호 목록.
// 지표 토글과 무관하게 항상 동일한 조건으로 계산합니다.
function buildNumberedSignals(rows: ChartCandleRow[]): NumberedSignal[] {
  if (rows.length < 21) return [];
  const closes = rows.map((r) => r.close);
  const raw: Array<Omit<NumberedSignal, "number">> = [];

  const push = (
    index: number,
    direction: "up" | "down",
    name: string,
    reason: string,
  ) => {
    const row = rows[index];
    if (!row) return;
    raw.push({
      time: row.time,
      name,
      direction,
      color: direction === "up" ? "#ef4444" : "#3b82f6",
      dateLabel: new Date(Number(row.time) * 1000).toLocaleDateString("ko-KR"),
      price: row.close,
      reason,
    });
  };

  // 거래량 급증 — 20봉 평균의 2.5배 초과
  for (let index = 20; index < rows.length; index += 1) {
    const base = average(rows.slice(index - 20, index).map((r) => r.volume));
    if (base > 0 && rows[index].volume > base * 2.5) {
      const up = rows[index].close >= rows[index].open;
      push(
        index,
        up ? "up" : "down",
        "거래량 급증",
        `거래량이 20봉 평균의 ${(rows[index].volume / base).toFixed(1)}배`,
      );
    }
  }

  // 골든크로스 / 데드크로스 — MA5 vs MA20
  {
    const short = smaArray(closes, 5);
    const long = smaArray(closes, 20);
    for (let index = 20; index < rows.length; index += 1) {
      if (
        short[index - 1] == null ||
        long[index - 1] == null ||
        short[index] == null ||
        long[index] == null
      )
        continue;
      if (short[index - 1]! <= long[index - 1]! && short[index]! > long[index]!)
        push(index, "up", "골든크로스", "5일선이 20일선을 상향 돌파");
      if (short[index - 1]! >= long[index - 1]! && short[index]! < long[index]!)
        push(index, "down", "데드크로스", "5일선이 20일선을 하향 이탈");
    }
  }

  // RSI 과매수(>70) / 과매도(<30) 진입
  {
    const values = rsiValues(rows);
    for (let index = 15; index < rows.length; index += 1) {
      if (values[index - 1] == null || values[index] == null) continue;
      if (values[index - 1]! <= 70 && values[index]! > 70)
        push(
          index,
          "down",
          "RSI 과매수",
          `RSI ${values[index]!.toFixed(0)} · 70 상회`,
        );
      if (values[index - 1]! >= 30 && values[index]! < 30)
        push(
          index,
          "up",
          "RSI 과매도",
          `RSI ${values[index]!.toFixed(0)} · 30 하회`,
        );
    }
  }

  // MACD(12/26/9) 매수/매도 전환
  {
    const fast = emaArray(closes, 12);
    const slow = emaArray(closes, 26);
    const macd = closes.map((_, index) =>
      fast[index] != null && slow[index] != null
        ? fast[index]! - slow[index]!
        : null,
    );
    const signal = emaArray(macd, 9);
    for (let index = 1; index < rows.length; index += 1) {
      if (
        macd[index - 1] == null ||
        signal[index - 1] == null ||
        macd[index] == null ||
        signal[index] == null
      )
        continue;
      if (
        macd[index - 1]! <= signal[index - 1]! &&
        macd[index]! > signal[index]!
      )
        push(index, "up", "MACD 매수 전환", "MACD가 시그널선 상향 교차");
      if (
        macd[index - 1]! >= signal[index - 1]! &&
        macd[index]! < signal[index]!
      )
        push(index, "down", "MACD 매도 전환", "MACD가 시그널선 하향 교차");
    }
  }

  // 박스권 돌파 — 직전 20봉 최고가 상향 돌파
  for (let index = 20; index < rows.length; index += 1) {
    const priorHigh = Math.max(
      ...rows.slice(index - 20, index).map((r) => r.high),
    );
    if (rows[index].close > priorHigh)
      push(
        index,
        "up",
        "박스권 돌파",
        `직전 20봉 고점 ${Math.round(priorHigh).toLocaleString("ko-KR")} 돌파`,
      );
  }

  // 발생 봉 시간 기준 정렬 후 최신 12건만
  raw.sort((a, b) => Number(a.time) - Number(b.time));
  const recent = raw.slice(-12);
  return recent.map((item, i) => ({ ...item, number: i + 1 }));
}

function indicatorPanelModel(
  rows: ChartCandleRow[],
  kind: IndicatorPanelKind,
): IndicatorPanelModel {
  if (kind === "rsi") {
    const values = rsiValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "RSI (14)",
      latest: latest == null ? "-" : latest.toFixed(1),
      lines: [
        {
          label: "RSI",
          color: "#a855f7",
          data: lineDataFromValues(rows, values),
        },
        {
          label: "70",
          color: "#ef4444",
          data: constantLine(rows, 70),
          lineStyle: LineStyle.Dashed,
        },
        {
          label: "30",
          color: "#3b82f6",
          data: constantLine(rows, 30),
          lineStyle: LineStyle.Dashed,
        },
      ],
    };
  }

  if (kind === "macd") {
    const closes = rows.map((item) => item.close);
    const fast = emaArray(closes, 12);
    const slow = emaArray(closes, 26);
    const macd = closes.map((_, index) =>
      fast[index] != null && slow[index] != null
        ? fast[index]! - slow[index]!
        : null,
    );
    const signal = emaArray(macd, 9);
    const histogram = macd.map((value, index) =>
      value != null && signal[index] != null ? value - signal[index]! : null,
    );
    const latest = [...macd].reverse().find((value) => value != null) ?? null;
    const latestClose = rows[rows.length - 1]?.close ?? 0;
    const scale = latestClose > 0 ? latestClose : 1;
    const displayMacd = macd.map((value) =>
      value == null ? null : (value / scale) * 100,
    );
    const displaySignal = signal.map((value) =>
      value == null ? null : (value / scale) * 100,
    );
    const displayHistogram = histogram.map((value) =>
      value == null ? null : (value / scale) * 100,
    );
    const latestPercent = latest == null ? null : (latest / scale) * 100;

    return {
      title: "MACD (12·26·9 · 현재가 대비 %)",
      latest:
        latestPercent == null
          ? "-"
          : `${latestPercent >= 0 ? "+" : ""}${latestPercent.toFixed(3)}%`,
      lines: [
        {
          label: "MACD",
          color: "#3b82f6",
          data: lineDataFromValues(rows, displayMacd),
        },
        {
          label: "Signal",
          color: "#f59e0b",
          data: lineDataFromValues(rows, displaySignal),
        },
        {
          label: "0",
          color: "#64748b",
          data: constantLine(rows, 0),
          lineStyle: LineStyle.Dashed,
        },
      ],
      histogram: displayHistogram.flatMap((value, index) =>
        value == null
          ? []
          : [
              {
                time: rows[index].time as Time,
                value,
                color:
                  value >= 0 ? "rgba(239,68,68,0.55)" : "rgba(59,130,246,0.55)",
              },
            ],
      ),
    };
  }

  if (kind === "stochastic") {
    const values = stochasticValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "스토캐스틱 (14)",
      latest: latest == null ? "-" : latest.toFixed(1),
      lines: [
        {
          label: "%K",
          color: "#06b6d4",
          data: lineDataFromValues(rows, values),
        },
        {
          label: "80",
          color: "#ef4444",
          data: constantLine(rows, 80),
          lineStyle: LineStyle.Dashed,
        },
        {
          label: "20",
          color: "#3b82f6",
          data: constantLine(rows, 20),
          lineStyle: LineStyle.Dashed,
        },
      ],
    };
  }

  if (kind === "atr") {
    const values = atrValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "ATR (14)",
      latest:
        latest == null
          ? "-"
          : latest.toLocaleString(undefined, { maximumFractionDigits: 2 }),
      lines: [
        {
          label: "ATR",
          color: "#f97316",
          data: lineDataFromValues(rows, values),
        },
      ],
    };
  }

  if (kind === "cci") {
    const values = cciValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "CCI (20)",
      latest: latest == null ? "-" : latest.toFixed(0),
      lines: [
        {
          label: "CCI",
          color: "#22c55e",
          data: lineDataFromValues(rows, values),
        },
        {
          label: "+100",
          color: "#ef4444",
          data: constantLine(rows, 100),
          lineStyle: LineStyle.Dashed,
        },
        {
          label: "-100",
          color: "#3b82f6",
          data: constantLine(rows, -100),
          lineStyle: LineStyle.Dashed,
        },
      ],
    };
  }

  if (kind === "obv") {
    const values = obvValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "OBV",
      latest:
        latest == null
          ? "-"
          : latest.toLocaleString("ko-KR", { notation: "compact" }),
      lines: [
        {
          label: "OBV",
          color: "#14b8a6",
          data: lineDataFromValues(rows, values),
        },
      ],
    };
  }

  if (kind === "williamsR") {
    const values = williamsRValues(rows);
    const latest = [...values].reverse().find((value) => value != null) ?? null;
    return {
      title: "Williams %R (14)",
      latest: latest == null ? "-" : latest.toFixed(1),
      lines: [
        {
          label: "%R",
          color: "#ec4899",
          data: lineDataFromValues(rows, values),
        },
        {
          label: "-20",
          color: "#ef4444",
          data: constantLine(rows, -20),
          lineStyle: LineStyle.Dashed,
        },
        {
          label: "-80",
          color: "#3b82f6",
          data: constantLine(rows, -80),
          lineStyle: LineStyle.Dashed,
        },
      ],
    };
  }

  const values = rocValues(rows);
  const latest = [...values].reverse().find((value) => value != null) ?? null;
  return {
    title: "ROC (10)",
    latest:
      latest == null ? "-" : `${latest >= 0 ? "+" : ""}${latest.toFixed(1)}%`,
    lines: [
      {
        label: "ROC",
        color: "#8b5cf6",
        data: lineDataFromValues(rows, values),
      },
      {
        label: "0",
        color: "#64748b",
        data: constantLine(rows, 0),
        lineStyle: LineStyle.Dashed,
      },
    ],
  };
}

function chartBaseOptions(height: number, showGrid: boolean) {
  return {
    width: 0,
    height,
    layout: {
      background: { type: ColorType.Solid, color: "transparent" },
      textColor: "#94a3b8",
      fontFamily: "inherit",
    },
    grid: {
      vertLines: {
        visible: showGrid,
        color: "rgba(148,163,184,0.12)",
      },
      horzLines: {
        visible: showGrid,
        color: "rgba(148,163,184,0.12)",
      },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: "rgba(148,163,184,0.6)",
        labelBackgroundColor: "#334155",
      },
      horzLine: {
        color: "rgba(148,163,184,0.6)",
        labelBackgroundColor: "#334155",
      },
    },
    rightPriceScale: {
      borderColor: "rgba(148,163,184,0.25)",
    },
    timeScale: {
      borderColor: "rgba(148,163,184,0.25)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 8,
      minBarSpacing: 2,
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true,
    },
    localization: {
      locale: "ko-KR",
    },
  };
}

function attachChartResize(
  chart: IChartApi | null,
  container: HTMLDivElement | null,
  height: number,
) {
  if (!chart || !container) return () => undefined;

  const resize = () => {
    chart.applyOptions({
      width: Math.max(container.clientWidth, 1),
      height,
    });
  };

  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  return () => observer.disconnect();
}

function pickStudyMarkerRow(
  rows: ChartCandleRow[],
  strategy: StudyMarkerStrategy,
) {
  if (!rows.length) return null;
  const recent = rows.slice(-60);

  if (strategy === "highest-volume") {
    return [...recent].sort((a, b) => b.volume - a.volume)[0] ?? null;
  }
  if (strategy === "recent-low") {
    return [...recent].sort((a, b) => a.low - b.low)[0] ?? null;
  }
  if (strategy === "recent-high") {
    return [...recent].sort((a, b) => b.high - a.high)[0] ?? null;
  }
  if (strategy === "breakout") {
    for (
      let index = Math.max(1, recent.length - 20);
      index < recent.length;
      index += 1
    ) {
      const previousHigh = Math.max(
        ...recent.slice(0, index).map((row) => row.high),
      );
      if (recent[index].close > previousHigh) return recent[index];
    }
  }

  return recent[recent.length - 1] ?? null;
}

function nearestChartRow(rows: ChartCandleRow[], iso: string | null) {
  if (!iso || rows.length === 0) return null;
  const target = Date.parse(iso) / 1000;
  if (!Number.isFinite(target)) return null;
  return rows.reduce(
    (best, row) =>
      Math.abs(Number(row.time) - target) < Math.abs(Number(best.time) - target)
        ? row
        : best,
    rows[0],
  );
}

function buildActualTradeMarkers(
  rows: ChartCandleRow[],
  entries: AutoTradeChartEntry[],
): AnyObj[] {
  const markers: AnyObj[] = [];
  for (const entry of entries) {
    if (entry.entryOrderNo) {
      const row = nearestChartRow(rows, entry.openedAt);
      if (row) {
        markers.push({
          time: row.time,
          position: "belowBar",
          color: "#16a34a",
          shape: "circle",
          text: "BUY",
          kind: "trade",
          title: `실제 BUY · ${entry.name}`,
          detail: `체결기준가 ${entry.entryPrice.toLocaleString("ko-KR")} · ${entry.quantity}주 · 주문번호 ${entry.entryOrderNo} · 자동주문`,
        });
      }
    }
    if (entry.closedAt && entry.exitOrderNo && entry.exitPrice != null) {
      const row = nearestChartRow(rows, entry.closedAt);
      if (row) {
        markers.push({
          time: row.time,
          position: "aboveBar",
          color: "#dc2626",
          shape: "square",
          text: "SELL",
          kind: "trade",
          title: `실제 SELL · ${entry.name}`,
          detail: `체결기준가 ${entry.exitPrice.toLocaleString("ko-KR")} · ${entry.quantity}주 · 주문번호 ${entry.exitOrderNo} · 손익 ${entry.profitPercent == null ? "확인 중" : `${entry.profitPercent >= 0 ? "+" : ""}${entry.profitPercent.toFixed(2)}%`} · 자동주문`,
        });
      }
    }
  }
  return markers.sort((a, b) => Number(a.time) - Number(b.time));
}

function ProfessionalChart({
  candles,
  loading,
  timeframe,
  indicators,
  fullscreen,
  portfolioOverlay,
  autoSignal,
  studyFocus,
  tradeEntries,
  technicalLevels,
  priceHeight,
  candleSignals,
  chartSignals,
  selectedSignal,
  onSignalSelect,
  onTechnicalLevelSelect,
}: {
  candles: CandlePoint[];
  loading: boolean;
  timeframe: ChartTimeframe;
  indicators: ChartIndicatorSettings;
  fullscreen: boolean;
  portfolioOverlay: PortfolioChartOverlay | null;
  autoSignal: ReturnType<typeof getAutoTradeSignal>;
  studyFocus: StudyChartFocus | null;
  tradeEntries: AutoTradeChartEntry[];
  technicalLevels: TechnicalChartLevels | null;
  priceHeight: number;
  candleSignals: PatternSignalOccurrence[];
  chartSignals: PatternSignalOccurrence[];
  selectedSignal: PatternSignalOccurrence | null;
  onSignalSelect: (signal: PatternSignalOccurrence) => void;
  onTechnicalLevelSelect: (level: TechnicalLevelKey) => void;
}) {
  const rows = useMemo(() => buildChartRows(candles), [candles]);
  const [priceChart, setPriceChart] = useState<IChartApi | null>(null);
  const [volumeChart, setVolumeChart] = useState<IChartApi | null>(null);
  const [volumeHeight, setVolumeHeight] = useState(() => {
    const stored = Number(
      localStorage.getItem("sa-chart-volume-height-v1") ?? 140,
    );
    return Number.isFinite(stored) ? Math.min(300, Math.max(90, stored)) : 140;
  });
  const enabledPanels = (
    [
      ["rsi", indicators.rsi],
      ["macd", indicators.macd],
      ["stochastic", indicators.stochastic],
      ["atr", indicators.atr],
      ["cci", indicators.cci],
      ["obv", indicators.obv],
      ["williamsR", indicators.williamsR],
      ["roc", indicators.roc],
    ] as Array<[IndicatorPanelKind, boolean]>
  ).filter(([, enabled]) => enabled);

  useEffect(() => {
    localStorage.setItem("sa-chart-volume-height-v1", String(volumeHeight));
  }, [volumeHeight]);

  useEffect(() => {
    if (!priceChart || !volumeChart || !indicators.volume) return;
    let syncing = false;
    const priceToVolume = (range: AnyObj | null) => {
      if (syncing || !range) return;
      syncing = true;
      volumeChart.timeScale().setVisibleLogicalRange(range as any);
      syncing = false;
    };
    const volumeToPrice = (range: AnyObj | null) => {
      if (syncing || !range) return;
      syncing = true;
      priceChart.timeScale().setVisibleLogicalRange(range as any);
      syncing = false;
    };
    priceChart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(priceToVolume as any);
    volumeChart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(volumeToPrice as any);
    const initial = priceChart.timeScale().getVisibleLogicalRange();
    if (initial) volumeChart.timeScale().setVisibleLogicalRange(initial);
    return () => {
      priceChart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(priceToVolume as any);
      volumeChart
        .timeScale()
        .unsubscribeVisibleLogicalRangeChange(volumeToPrice as any);
    };
  }, [priceChart, volumeChart, indicators.volume]);

  const beginVolumeResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = volumeHeight;
      const maximum = fullscreen ? 420 : 300;
      const move = (moveEvent: PointerEvent) => {
        setVolumeHeight(
          Math.min(
            maximum,
            Math.max(90, startHeight + startY - moveEvent.clientY),
          ),
        );
      };
      const finish = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", finish);
        document.body.style.userSelect = "";
      };
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", finish, { once: true });
    },
    [fullscreen, volumeHeight],
  );

  if (loading && rows.length < 2) {
    return <ChartPlaceholder text="실제 봉 데이터를 불러오는 중..." />;
  }
  if (rows.length < 2) {
    return (
      <ChartPlaceholder text="표시할 시가·고가·저가·종가 데이터가 부족합니다." />
    );
  }

  return (
    <div className="space-y-2">
      <PriceChartCanvas
        rows={rows}
        timeframe={timeframe}
        indicators={indicators}
        fullscreen={fullscreen}
        portfolioOverlay={portfolioOverlay}
        autoSignal={autoSignal}
        studyFocus={studyFocus}
        tradeEntries={tradeEntries}
        technicalLevels={technicalLevels}
        priceHeight={priceHeight}
        selectedSignal={selectedSignal}
        onTechnicalLevelSelect={onTechnicalLevelSelect}
        onChartReady={setPriceChart}
      />

      {indicators.volume && (
        <>
          <button
            type="button"
            onPointerDown={beginVolumeResize}
            className="flex h-5 w-full touch-none cursor-row-resize items-center justify-center rounded-lg border border-card-border bg-secondary/70"
            aria-label="거래량 창 높이 조절"
            title="위아래로 끌어서 거래량 창 높이 조절"
          >
            <span className="h-1 w-12 rounded-full bg-muted-foreground/40" />
          </button>
          <VolumeChartCanvas
            rows={rows}
            timeframe={timeframe}
            height={volumeHeight}
            onChartReady={setVolumeChart}
          />
        </>
      )}

      {enabledPanels.map(([kind]) => (
        <IndicatorPanel
          key={kind}
          kind={kind}
          rows={rows}
          fullscreen={fullscreen}
        />
      ))}

      <PatternSignalPanel
        title="봉 신호"
        subtitle="신호를 누르면 해당 봉으로 이동하고 설명창이 열립니다"
        signals={candleSignals}
        selectedId={selectedSignal?.id}
        onSelect={onSignalSelect}
      />
      <PatternSignalPanel
        title="차트 신호"
        subtitle="선택한 패턴 구간만 메인 차트에 굵은 선으로 표시합니다"
        signals={chartSignals}
        selectedId={selectedSignal?.id}
        onSelect={onSignalSelect}
      />
    </div>
  );
}

function PriceChartCanvas({
  rows,
  timeframe,
  indicators,
  fullscreen,
  portfolioOverlay,
  autoSignal,
  studyFocus,
  tradeEntries,
  technicalLevels,
  priceHeight,
  selectedSignal,
  onTechnicalLevelSelect,
  onChartReady,
}: {
  rows: ChartCandleRow[];
  timeframe: ChartTimeframe;
  indicators: ChartIndicatorSettings;
  fullscreen: boolean;
  portfolioOverlay: PortfolioChartOverlay | null;
  autoSignal: ReturnType<typeof getAutoTradeSignal>;
  studyFocus: StudyChartFocus | null;
  tradeEntries: AutoTradeChartEntry[];
  technicalLevels: TechnicalChartLevels | null;
  priceHeight: number;
  selectedSignal: PatternSignalOccurrence | null;
  onTechnicalLevelSelect: (level: TechnicalLevelKey) => void;
  onChartReady: (chart: IChartApi | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [signalLegendOpen, setSignalLegendOpen] = useState(false);
  const [analysisMarkersVisible, setAnalysisMarkersVisible] = useState(false);
  const chartApiRef = useRef<AnyObj | null>(null);
  const focusSeriesRef = useRef<AnyObj | null>(null);
  const selectedSignalRef = useRef<PatternSignalOccurrence | null>(
    selectedSignal,
  );
  selectedSignalRef.current = selectedSignal;
  const [selectedMarkerDetails, setSelectedMarkerDetails] = useState<AnyObj[]>(
    [],
  );
  const height = fullscreen
    ? Math.max(430, Math.floor(window.innerHeight * 0.62))
    : priceHeight;
  const technicalMarkers = useMemo(
    () => buildTechnicalSignalMarkers(rows, indicators),
    [rows, indicators],
  );
  const numberedSignals = useMemo(() => buildNumberedSignals(rows), [rows]);
  const actualTradeMarkers = useMemo(
    () => buildActualTradeMarkers(rows, tradeEntries),
    [rows, tradeEntries],
  );
  const signalLegendItems = useMemo(() => {
    const unique = new Map<
      string,
      { text: string; direction: "up" | "down"; color: string }
    >();
    for (const marker of technicalMarkers) {
      const text = String(marker.text ?? "기술지표 신호");
      const direction = marker.position === "belowBar" ? "up" : "down";
      const key = `${text}:${direction}`;
      if (!unique.has(key))
        unique.set(key, {
          text,
          direction,
          color: String(marker.color ?? "#64748b"),
        });
    }
    return [...unique.values()].slice(0, 20);
  }, [technicalMarkers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || rows.length < 2) return;

    const chart = createChart(container, {
      ...chartBaseOptions(height, indicators.priceGrid),
      width: Math.max(container.clientWidth, 1),
      timeScale: {
        ...chartBaseOptions(height, indicators.priceGrid).timeScale,
        timeVisible: /m|H/.test(timeframe),
      },
    } as AnyObj);
    onChartReady(chart);

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ef4444",
      downColor: "#3b82f6",
      wickUpColor: "#ef4444",
      wickDownColor: "#3b82f6",
      borderUpColor: "#ef4444",
      borderDownColor: "#3b82f6",
      priceLineVisible: true,
      lastValueVisible: true,
    });

    candleSeries.setData(
      rows.map((item) => ({
        time: item.time,
        open: item.open,
        high: item.high,
        low: item.low,
        close: item.close,
      })),
    );

    const focusSeries = chart.addLineSeries({
      color: selectedSignalRef.current?.color ?? "#a855f7",
      lineWidth: 4,
      lineStyle: LineStyle.Solid,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chartApiRef.current = chart;
    focusSeriesRef.current = focusSeries;

    if (portfolioOverlay?.averagePrice && portfolioOverlay.averagePrice > 0) {
      candleSeries.createPriceLine({
        price: portfolioOverlay.averagePrice,
        color: "#f59e0b",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "내 평단",
      });
      const purchaseTime = Date.parse(portfolioOverlay.purchaseDate);
      const sincePurchase = rows.filter(
        (row) =>
          !Number.isFinite(purchaseTime) ||
          Number(row.time) * 1000 >= purchaseTime,
      );
      const highestSincePurchase = sincePurchase.length
        ? Math.max(...sincePurchase.map((row) => row.high))
        : null;
      if (highestSincePurchase && highestSincePurchase > 0) {
        candleSeries.createPriceLine({
          price: highestSincePurchase,
          color: "#a855f7",
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: "매수후 최고",
        });
      }
    }

    if (autoSignal?.candidate.price && autoSignal.candidate.price > 0) {
      const basePrice = autoSignal.candidate.price;
      candleSeries.createPriceLine({
        price: basePrice * (1 - autoSignal.settings.stopLossPercent / 100),
        color: "#3b82f6",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "자동 손절",
      });
      candleSeries.createPriceLine({
        price: basePrice * (1 + autoSignal.settings.takeProfitPercent / 100),
        color: "#ef4444",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "자동 목표",
      });
    }

    if (technicalLevels?.entry != null && technicalLevels.entry > 0) {
      candleSeries.createPriceLine({
        price: technicalLevels.entry,
        color: "#f59e0b",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "매수가",
      });
    }
    if (technicalLevels?.stop != null && technicalLevels.stop > 0) {
      candleSeries.createPriceLine({
        price: technicalLevels.stop,
        color: "#ef4444",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "손절가",
      });
    }
    if (technicalLevels?.target1 != null && technicalLevels.target1 > 0) {
      candleSeries.createPriceLine({
        price: technicalLevels.target1,
        color: "#22c55e",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "목표 1",
      });
    }
    if (technicalLevels?.target2 != null && technicalLevels.target2 > 0) {
      candleSeries.createPriceLine({
        price: technicalLevels.target2,
        color: "#10b981",
        lineWidth: 2,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: "목표 2",
      });
    }

    const analysisMarkers: AnyObj[] = [...technicalMarkers];
    if (studyFocus) {
      const studyRow = pickStudyMarkerRow(rows, studyFocus.markerStrategy);
      if (studyRow) {
        analysisMarkers.push({
          time: studyRow.time,
          position: "belowBar",
          color: "#a855f7",
          shape: "arrowUp",
          text: studyFocus.markerText,
          kind: "analysis",
          title: studyFocus.title,
          detail: `${studyFocus.summary} · 종가 ${studyRow.close.toLocaleString("ko-KR")} · 거래량 ${studyRow.volume.toLocaleString("ko-KR")}`,
        });
      }
    }
    if (autoSignal && rows.length) {
      analysisMarkers.push({
        time: rows[rows.length - 1].time,
        position: "aboveBar",
        color: "#f97316",
        shape: "arrowDown",
        text: `자동후보 ${autoSignal.candidate.probability}점`,
        kind: "analysis",
        title: "자동매매 후보 모델신호",
        detail: `모델점수 ${autoSignal.candidate.probability}점 · 위험 ${autoSignal.candidate.riskScore}점 · 데이터 ${autoSignal.candidate.dataCompleteness}% · 실제 주문/체결이 아닙니다.`,
      });
    }

    // 차트 위 모든 마커를 완전히 제거합니다.
    // 시작/진행/현재/완성/이탈 텍스트, 패턴명, 숫자, 점, 화살표,
    // 실제 체결 BUY/SELL 마커까지 캔들 위에는 렌더링하지 않습니다.
    candleSeries.setMarkers([] as any);

    const clickHandler = (param: AnyObj) => {
      if (param.point?.y != null && technicalLevels) {
        const levelCandidates: Array<
          [TechnicalLevelKey, number | null | undefined]
        > = [
          ["entry", technicalLevels.entry],
          ["stop", technicalLevels.stop],
          ["target1", technicalLevels.target1],
          ["target2", technicalLevels.target2],
        ];
        for (const [key, price] of levelCandidates) {
          if (price == null || price <= 0) continue;
          const coordinate = candleSeries.priceToCoordinate(price);
          if (
            coordinate != null &&
            Math.abs(coordinate - Number(param.point.y)) <= 12
          ) {
            onTechnicalLevelSelect(key);
            return;
          }
        }
      }
    };
    chart.subscribeClick(clickHandler as any);

    const addLine = (
      data: ChartLineData[],
      color: string,
      lineWidth: 1 | 2 = 1,
      lineStyle: LineStyle = LineStyle.Solid,
    ) => {
      if (!data.length) return;
      const series = chart.addLineSeries({
        color,
        lineWidth,
        lineStyle,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(data);
    };

    if (indicators.sma5) addLine(movingAverageData(rows, 5), "#f59e0b", 2);
    if (indicators.sma20) addLine(movingAverageData(rows, 20), "#22c55e", 2);
    if (indicators.sma60) addLine(movingAverageData(rows, 60), "#a855f7", 2);
    if (indicators.sma120) addLine(movingAverageData(rows, 120), "#ec4899", 2);
    if (indicators.bollinger) {
      const band = bollingerData(rows);
      addLine(band.upper, "#14b8a6", 1, LineStyle.Dashed);
      addLine(band.middle, "#14b8a6", 1, LineStyle.Dotted);
      addLine(band.lower, "#14b8a6", 1, LineStyle.Dashed);
    }
    if (indicators.vwap) addLine(vwapData(rows), "#06b6d4", 2);
    if (indicators.ichimoku) {
      const cloud = ichimokuData(rows);
      addLine(cloud.conversion, "#ef4444", 1);
      addLine(cloud.base, "#3b82f6", 1);
      addLine(cloud.spanA, "#22c55e", 1, LineStyle.Dashed);
      addLine(cloud.spanB, "#f97316", 1, LineStyle.Dashed);
    }

    chart.timeScale().fitContent();
    applyPatternSignalFocus(
      chart,
      focusSeries,
      rows,
      selectedSignalRef.current,
    );
    const stopResize = attachChartResize(chart, container, height);
    return () => {
      chart.unsubscribeClick(clickHandler as any);
      chartApiRef.current = null;
      focusSeriesRef.current = null;
      onChartReady(null);
      stopResize();
      chart.remove();
    };
  }, [
    rows,
    timeframe,
    indicators,
    height,
    portfolioOverlay,
    autoSignal,
    studyFocus,
    technicalLevels,
    technicalMarkers,
    numberedSignals,
    actualTradeMarkers,
    analysisMarkersVisible,
    onChartReady,
    onTechnicalLevelSelect,
  ]);

  useEffect(() => {
    applyPatternSignalFocus(
      chartApiRef.current,
      focusSeriesRef.current,
      rows,
      selectedSignal,
    );
  }, [rows, selectedSignal]);

  return (
    <div className="overflow-hidden rounded-xl border border-card-border bg-secondary/20">
      <div ref={containerRef} className="w-full" style={{ height }} />
      {technicalLevels && (
        <div className="grid grid-cols-5 gap-1 border-t border-card-border bg-background/80 p-2">
          {[
            ["entry", "매수가", technicalLevels.entry, "text-amber-500"],
            ["sell", "매도", null, "text-blue-500"],
            ["stop", "손절가", technicalLevels.stop, "text-red-500"],
            ["target1", "목표 1", technicalLevels.target1, "text-green-500"],
            ["target2", "목표 2", technicalLevels.target2, "text-emerald-500"],
          ].map(([key, label, value, textClass]) => (
            <button
              key={String(key)}
              type="button"
              onClick={() => onTechnicalLevelSelect(key as TechnicalLevelKey)}
              className="min-w-0 rounded-lg bg-secondary/70 px-1 py-2 text-center transition active:scale-95"
            >
              <p
                className={cn(
                  "truncate text-[9px] font-extrabold",
                  String(textClass),
                )}
              >
                {String(label)}
              </p>
              <p className="mt-0.5 truncate text-[8px] font-bold text-muted-foreground">
                {value == null
                  ? "근거 보기"
                  : Number(value).toLocaleString("ko-KR")}
              </p>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 border-t border-card-border px-3 py-2 text-[9px] font-bold text-muted-foreground">
        <span className="text-red-500">■ 상승봉</span>
        <span className="text-blue-500">■ 하락봉</span>
        {indicators.sma5 && <span className="text-amber-500">━ 5일선</span>}
        {indicators.sma20 && <span className="text-green-500">━ 20일선</span>}
        {indicators.sma60 && <span className="text-purple-500">━ 60일선</span>}
        {indicators.sma120 && <span className="text-pink-500">━ 120일선</span>}
        {indicators.bollinger && (
          <span className="text-teal-500">┄ 볼린저</span>
        )}
        {indicators.vwap && <span className="text-cyan-500">━ VWAP</span>}
        {technicalLevels?.entry != null && (
          <span className="text-amber-500">┄ 매수가</span>
        )}
        {technicalLevels?.stop != null && (
          <span className="text-red-500">┄ 손절가</span>
        )}
        {technicalLevels?.target1 != null && (
          <span className="text-green-500">┄ 목표 1</span>
        )}
        {technicalLevels?.target2 != null && (
          <span className="text-emerald-500">┈ 목표 2</span>
        )}
        {actualTradeMarkers.length > 0 && (
          <span className="text-emerald-600">● BUY / ■ SELL 실제 체결</span>
        )}
        {(technicalMarkers.length > 0 || numberedSignals.length > 0) && (
          <button
            type="button"
            onClick={() => setAnalysisMarkersVisible((v) => !v)}
            aria-pressed={analysisMarkersVisible}
            className="rounded-full bg-primary/10 px-2 py-1 text-primary"
          >
            분석 화살표 {analysisMarkersVisible ? "숨기기" : "표시"}
          </button>
        )}
        {technicalMarkers.length > 0 && (
          <button
            type="button"
            onClick={() => setSignalLegendOpen((open) => !open)}
            aria-expanded={signalLegendOpen}
            className="rounded-full bg-primary/10 px-2 py-1 text-primary"
          >
            신호 설명 {signalLegendOpen ? "접기 ▲" : "보기 ▼"} ·{" "}
            {technicalMarkers.length}곳
          </button>
        )}
      </div>
      {signalLegendOpen && technicalMarkers.length > 0 && (
        <div className="border-t border-card-border bg-background/80 px-3 py-3">
          <p className="break-keep text-[10px] font-bold leading-4 text-muted-foreground">
            ↑·↓는 분석 조건이며 주문이 아닙니다. 봉의 화살표를 누르면
            발생시각·실제 값·판정근거를 확인할 수 있습니다. BUY/SELL 글자가 있는
            원·사각형만 실제 체결입니다.
          </p>
          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {signalLegendItems.map((item) => (
              <div
                key={`${item.text}:${item.direction}`}
                className="flex items-center gap-2 rounded-lg bg-secondary/60 px-2.5 py-2 text-[10px] font-bold"
              >
                <span
                  className="text-base font-black"
                  style={{ color: item.color }}
                >
                  {item.direction === "up" ? "↑" : "↓"}
                </span>
                <span>{item.text}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {analysisMarkersVisible && numberedSignals.length > 0 && (
        <div className="border-t border-card-border bg-background/80 px-3 py-3">
          <p className="mb-2 text-center text-[11px] font-extrabold">
            신호 목록 · 최근 {numberedSignals.length}개
          </p>
          <div className="space-y-1.5">
            {numberedSignals.map((signal) => (
              <div
                key={`${signal.number}:${String(signal.time)}`}
                className="flex items-center gap-2 rounded-lg bg-secondary/60 px-2.5 py-2 text-[10px] font-bold"
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white"
                  style={{ backgroundColor: signal.color }}
                >
                  {signal.number}
                </span>
                <div className="min-w-0 flex-1 text-center">
                  <p className="break-keep">
                    <span style={{ color: signal.color }}>{signal.name}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      · {signal.direction === "up" ? "상승" : "하락"}
                    </span>
                  </p>
                  <p className="mt-0.5 break-keep text-[9px] font-semibold leading-4 text-muted-foreground">
                    {signal.dateLabel} · 당시가{" "}
                    {Math.round(signal.price).toLocaleString("ko-KR")} ·{" "}
                    {signal.reason}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {selectedMarkerDetails.length > 0 && (
        <div className="border-t border-card-border bg-background px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-extrabold">선택한 봉의 신호 상세</p>
            <button
              type="button"
              onClick={() => setSelectedMarkerDetails([])}
              className="text-[10px] font-bold text-muted-foreground"
            >
              닫기
            </button>
          </div>
          <div className="mt-2 space-y-2">
            {selectedMarkerDetails.map((marker, index) => (
              <div
                key={`${marker.title ?? marker.text}:${index}`}
                className={cn(
                  "rounded-xl border p-2.5",
                  marker.kind === "trade"
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-card-border bg-secondary/50",
                )}
              >
                <p className="text-[10px] font-extrabold">
                  {marker.title ?? marker.text}
                </p>
                <p className="mt-1 break-keep text-[10px] font-semibold leading-4 text-muted-foreground">
                  {marker.detail ??
                    "해당 봉에서 지표 전환 조건이 감지됐습니다."}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function VolumeChartCanvas({
  rows,
  timeframe,
  height,
  onChartReady,
}: {
  rows: ChartCandleRow[];
  timeframe: ChartTimeframe;
  height: number;
  onChartReady: (chart: IChartApi | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || rows.length < 2) return;
    const chart = createChart(container, {
      ...chartBaseOptions(height, true),
      width: Math.max(container.clientWidth, 1),
      timeScale: {
        ...chartBaseOptions(height, true).timeScale,
        timeVisible: /m|H/.test(timeframe),
      },
      rightPriceScale: {
        borderColor: "rgba(148,163,184,0.25)",
        scaleMargins: { top: 0.12, bottom: 0.05 },
      },
    } as AnyObj);
    onChartReady(chart);
    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: true,
    });
    volumeSeries.setData(
      rows.map((item) => ({
        time: item.time,
        value: item.volume,
        color:
          item.close >= item.open
            ? "rgba(239,68,68,0.55)"
            : "rgba(59,130,246,0.55)",
      })),
    );
    chart.timeScale().fitContent();
    const stopResize = attachChartResize(chart, container, height);
    return () => {
      onChartReady(null);
      stopResize();
      chart.remove();
    };
  }, [rows, timeframe, height, onChartReady]);

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-secondary/20">
      <div className="flex items-center justify-between border-b border-card-border px-3 py-2">
        <p className="text-[11px] font-extrabold">거래량</p>
        <p className="text-[10px] font-bold text-muted-foreground">
          높이 {Math.round(height)}px · 가격 차트와 이동·확대 동기화
        </p>
      </div>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </section>
  );
}

function IndicatorPanel({
  kind,
  rows,
  fullscreen,
}: {
  kind: IndicatorPanelKind;
  rows: ChartCandleRow[];
  fullscreen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const model = useMemo(() => indicatorPanelModel(rows, kind), [rows, kind]);
  const height = fullscreen ? 190 : 155;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || rows.length < 2) return;

    const chart = createChart(container, {
      ...chartBaseOptions(height, true),
      width: Math.max(container.clientWidth, 1),
      rightPriceScale: {
        borderColor: "rgba(148,163,184,0.25)",
        scaleMargins: { top: 0.12, bottom: 0.12 },
      },
    } as AnyObj);

    if (model.histogram?.length) {
      const histogram = chart.addHistogramSeries({
        priceLineVisible: false,
        lastValueVisible: false,
      });
      histogram.setData(model.histogram);
    }

    for (const line of model.lines) {
      const series = chart.addLineSeries({
        color: line.color,
        lineWidth: 2,
        lineStyle: line.lineStyle ?? LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      series.setData(line.data);
    }

    chart.timeScale().fitContent();
    const stopResize = attachChartResize(chart, container, height);

    return () => {
      stopResize();
      chart.remove();
    };
  }, [rows, model, height]);

  return (
    <section className="overflow-hidden rounded-xl border border-card-border bg-secondary/20">
      <div className="flex items-center justify-between border-b border-card-border px-3 py-2">
        <p className="text-[11px] font-extrabold">{model.title}</p>
        <p className="text-xs font-black text-primary">{model.latest}</p>
      </div>
      <div ref={containerRef} className="w-full" style={{ height }} />
    </section>
  );
}

function ChartSettingToggle({
  label,
  enabled,
  onClick,
}: {
  label: string;
  enabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl bg-secondary/60 p-3 text-left text-xs font-bold"
    >
      <span>{label}</span>
      <span
        className={cn(
          "relative h-6 w-11 rounded-full transition",
          enabled ? "bg-primary" : "bg-muted",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            enabled ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}

function ChartPlaceholder({ text }: { text: string }) {
  return (
    <div className="mt-3 flex h-[360px] items-center justify-center rounded-xl bg-secondary/50">
      <p className="text-sm font-bold text-muted-foreground">{text}</p>
    </div>
  );
}

function FinancialTab({
  financials,
  currency,
}: {
  financials: AnyObj | null;
  currency: Currency;
}) {
  const [period, setPeriod] = useState<FinancialPeriod>("quarterly");

  const [selectedMetricKey, setSelectedMetricKey] =
    useState<FinancialMetricKey>("roe");
  const [metricModalOpen, setMetricModalOpen] = useState(false);
  const [financialDetail, setFinancialDetail] = useState<{
    title: string;
    text: string;
  } | null>(null);

  // KR 주식은 백만원, US 주식은 USD 백만 단위로 표기합니다(원↔달러 환산 없음).
  const financialUnitLabel =
    currency === "USD" ? "단위: USD million" : "단위: 백만원";

  const ratios = financials?.ratios ?? financials?.metrics ?? {};

  const metrics = [
    evaluateFinancialMetric(
      "roe",

      firstNumber(ratios.roe, ratios.returnOnEquity, financials?.roe),
    ),

    evaluateFinancialMetric(
      "pbr",

      firstNumber(
        ratios.pbr,
        ratios.priceToBook,
        ratios.priceBookRatio,
        financials?.pbr,
      ),
    ),

    evaluateFinancialMetric(
      "per",

      firstNumber(
        ratios.per,
        ratios.pe,
        ratios.priceToEarnings,
        financials?.per,
      ),
    ),

    evaluateFinancialMetric(
      "psr",

      firstNumber(
        ratios.psr,
        ratios.priceToSales,
        ratios.priceSalesRatio,
        financials?.psr,
      ),
    ),
  ];

  const selectedMetric =
    metrics.find((metric) => metric.key === selectedMetricKey) ?? metrics[0];

  const rows = financialRows(financials, period).slice(0, 4);

  const annualRows = financialRows(financials, "annual").slice(0, 5).reverse();

  const performanceCards = [
    {
      label: "자본금",
      color: "bg-violet-500",
      values: annualRows.map((row) =>
        financialValue(
          row.capitalStock,
          row.paidInCapital,
          row.capital,
          row.equityCapital,
        ),
      ),
    },
    {
      label: "매출액",
      color: "bg-blue-500",
      values: annualRows.map((row) =>
        financialValue(row.revenue, row.sales, row.totalRevenue),
      ),
    },
    {
      label: "영업이익",
      color: "bg-emerald-500",
      values: annualRows.map((row) =>
        financialValue(row.operatingIncome, row.operatingProfit, row.opIncome),
      ),
    },
    {
      label: "순이익",
      color: "bg-cyan-500",
      values: annualRows.map((row) =>
        financialValue(row.netIncome, row.netProfit, row.profit),
      ),
    },
    {
      label: "총자산",
      color: "bg-amber-500",
      values: annualRows.map((row) =>
        financialValue(row.assets, row.totalAssets),
      ),
    },
    {
      label: "총부채",
      color: "bg-rose-500",
      values: annualRows.map((row) =>
        financialValue(row.debt, row.totalLiabilities, row.liabilities),
      ),
    },
    {
      label: "자본총계",
      color: "bg-indigo-500",
      values: annualRows.map((row) =>
        financialValue(row.equity, row.totalEquity, row.stockholdersEquity),
      ),
    },
    {
      label: "영업현금흐름",
      color: "bg-teal-500",
      values: annualRows.map((row) =>
        financialValue(
          row.operatingCashFlow,
          row.cashFromOperations,
          row.netCashProvidedByOperatingActivities,
        ),
      ),
    },
    {
      label: "현금성자산",
      color: "bg-sky-500",
      values: annualRows.map((row) =>
        financialValue(
          row.cash,
          row.cashAndCashEquivalents,
          row.cashEquivalents,
        ),
      ),
    },
  ];

  const periodLabels = annualRows.map((row, index) =>
    String(row.period ?? row.year ?? `${index + 1}년`),
  );

  return (
    <div className="flex flex-col gap-3">
      <SectionCard
        title="핵심 지표"
        subtitle="지표를 누르면 자세한 설명이 나옵니다"
      >
        <div className="grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <button
              key={metric.key}
              type="button"
              aria-pressed={selectedMetric.key === metric.key}
              onClick={() => {
                setSelectedMetricKey(metric.key);
                setMetricModalOpen(true);
              }}
              className={cn(
                "rounded-xl border p-3 text-center transition-all active:scale-[0.98]",

                metricBorder(metric.tone),

                selectedMetric.key === metric.key &&
                  "ring-2 ring-primary ring-offset-2 ring-offset-card",
              )}
            >
              <p className="text-xs font-extrabold">{metric.label}</p>

              <p
                className={cn(
                  "mt-3 text-xl font-extrabold",

                  metricText(metric.tone),
                )}
              >
                {metric.valueText}
              </p>

              <p className="mt-1 text-sm font-extrabold text-muted-foreground">
                {metric.status}
              </p>
            </button>
          ))}
        </div>

        {metricModalOpen && (
          <Modal
            title={`${selectedMetric.label} · ${selectedMetric.status}`}
            onClose={() => setMetricModalOpen(false)}
          >
            <div className="mb-3 rounded-xl bg-primary/10 p-3 text-center text-lg font-extrabold text-primary">
              {selectedMetric.valueText}
            </div>
            <div className="space-y-2">
              <ExplanationBlock label="지표 뜻" text={selectedMetric.meaning} />
              <ExplanationBlock
                label="현재 수치 해석"
                text={selectedMetric.interpretation}
              />
              <ExplanationBlock
                label="주의할 점"
                text={selectedMetric.caution}
              />
            </div>
          </Modal>
        )}
      </SectionCard>

      <div className="order-3">
        <SectionCard
          title="재무 실적"
          subtitle={`막대가 높을수록 금액이 큽니다 · ${currency === "USD" ? "단위: USD million" : "단위: 백만원"}`}
        >
          {annualRows.length ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {performanceCards
                .filter((card) => card.values.some((value) => value != null))
                .map((card) => (
                  <FinancialTrendCard
                    key={card.label}
                    label={card.label}
                    values={card.values}
                    periods={periodLabels}
                    currency={currency}
                    color={card.color}
                    onOpen={() => {
                      const availableValues = card.values.filter(
                        (value): value is number =>
                          value != null && Number.isFinite(value),
                      );
                      const first = availableValues[0];
                      const latest =
                        availableValues[availableValues.length - 1];
                      const direction =
                        first == null || latest == null
                          ? "흐름을 계산할 데이터가 부족합니다."
                          : latest >= first
                            ? "최근 값이 과거 값보다 증가하는 흐름입니다."
                            : "최근 값이 과거 값보다 감소하는 흐름입니다.";
                      setFinancialDetail({
                        title: `${card.label} 설명`,
                        text: `${card.label}의 연도별 실제 제공값을 비교한 차트입니다. ${direction} 단일 항목만으로 판단하지 말고 매출·이익·부채·현금흐름을 함께 확인하세요.`,
                      });
                    }}
                  />
                ))}
            </div>
          ) : (
            <p className="text-sm font-bold text-muted-foreground">
              실제 재무 데이터 제공기관의 응답이 지연되고 있습니다. 잠시 후 다시
              확인해 주세요.
            </p>
          )}
        </SectionCard>
      </div>

      <div className="order-2">
        <SectionCard title="실적" subtitle="기간별 매출과 이익">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPeriod("quarterly")}
              className={cn(
                "inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl px-3 py-2 text-xs font-extrabold",

                period === "quarterly"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground",
              )}
            >
              분기별
            </button>

            <button
              type="button"
              onClick={() => setPeriod("annual")}
              className={cn(
                "inline-flex items-center justify-center text-center break-keep leading-tight rounded-xl px-3 py-2 text-xs font-extrabold",

                period === "annual"
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary text-muted-foreground",
              )}
            >
              연별
            </button>
          </div>

          <p className="mb-2 text-center text-[10px] font-bold text-muted-foreground">
            {financialUnitLabel} · 최신 기간 우선
          </p>

          {rows.length ? (
            <button
              type="button"
              onClick={() =>
                setFinancialDetail({
                  title: `${period === "quarterly" ? "분기별" : "연별"} 실적 설명`,
                  text: "매출액·영업이익·순이익의 실제 기간별 값을 비교합니다. 매출이 늘어도 이익이 줄 수 있으므로 세 항목의 방향과 일회성 요인을 함께 확인하세요.",
                })
              }
              className="w-full text-left"
            >
              <FinancialPerformanceChart rows={rows} currency={currency} />
            </button>
          ) : (
            <p className="text-sm font-bold text-muted-foreground">
              선택한 기간의 실제 재무 데이터가 아직 확인되지 않았습니다.
            </p>
          )}
        </SectionCard>
      </div>

      {financialDetail && (
        <Modal
          title={financialDetail.title}
          onClose={() => setFinancialDetail(null)}
        >
          <p>{financialDetail.text}</p>
        </Modal>
      )}
    </div>
  );
}

function formatContentDate(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw || raw === "날짜 확인") return "날짜 확인";
  if (/^\d{8}$/.test(raw)) {
    return raw.slice(0, 4) + "." + raw.slice(4, 6) + "." + raw.slice(6, 8);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return (
    parsed.getFullYear() +
    "." +
    String(parsed.getMonth() + 1).padStart(2, "0") +
    "." +
    String(parsed.getDate()).padStart(2, "0")
  );
}

function cleanContentTitle(value: unknown, source = "") {
  let title = translateMarketText(
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  title = title.replace(/^\[[^\]]+\]\s*/, "").trim();
  if (source) {
    const suffix = " - " + source;
    if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  }
  return title || "제목 확인 필요";
}

function filingPlainSummary(item: AnyObj | undefined) {
  if (!item) return "최근 확인된 공시가 없습니다.";
  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.documentSummary,
    item.summary,
    item.message,
  );
  if (bodySummary) return bodySummary;
  const title = String(
    item.title ?? item.report_nm ?? item.report ?? item.form ?? "",
  ).trim();
  if (title.includes("공시 전체보기") || title.includes("공식 전자공시 검색")) {
    return "DART에서 이 종목의 전체 공시 원문을 확인할 수 있습니다.";
  }
  if (/주주총회|주총/.test(title))
    return "주주총회 개최 또는 관련 일정이 공시되었습니다.";
  if (/현금.*배당|배당.*결정|배당금/.test(title))
    return "주주 배당과 관련된 내용이 공시되었습니다.";
  if (/유상증자/.test(title))
    return "유상증자 계획 또는 진행 내용이 공시되었습니다.";
  if (/무상증자/.test(title))
    return "무상증자 계획 또는 진행 내용이 공시되었습니다.";
  if (/자기주식|자사주/.test(title))
    return "자사주 취득·처분과 관련된 내용이 공시되었습니다.";
  if (/단일판매|공급계약|수주/.test(title))
    return "신규 계약 또는 수주 관련 내용이 공시되었습니다.";
  if (/잠정.*실적|영업.*실적|매출액.*손익/.test(title))
    return "최근 경영실적과 관련된 내용이 공시되었습니다.";
  if (/사업보고서/.test(title))
    return "사업보고서가 제출되어 회사의 주요 실적과 현황을 확인할 수 있습니다.";
  if (/분기보고서/.test(title))
    return "분기보고서가 제출되어 최근 분기 실적을 확인할 수 있습니다.";
  if (/반기보고서/.test(title))
    return "반기보고서가 제출되어 상반기 실적을 확인할 수 있습니다.";
  if (/최대주주/.test(title))
    return "최대주주 또는 주요 지분 변동 내용이 공시되었습니다.";
  if (/소송|가처분/.test(title))
    return "소송 또는 법적 절차와 관련된 내용이 공시되었습니다.";
  const shortTitle = title.length > 58 ? title.slice(0, 58) + "…" : title;
  return shortTitle
    ? shortTitle + " 관련 공시가 등록되었습니다."
    : "최근 공시 원문이 등록되었습니다.";
}

function newsPlainSummary(item: AnyObj | undefined) {
  if (!item) return "최근 확인된 관련 뉴스가 없습니다.";
  const bodySummary = firstText(
    item.bodySummary,
    item.contentSummary,
    item.articleSummary,
    item.summary,
    item.description,
    item.message,
  );
  if (bodySummary) return bodySummary;
  const source = String(
    item.source ?? item.publisher ?? item.provider ?? "",
  ).trim();
  const title = cleanContentTitle(
    item.translatedTitle ?? item.title ?? item.headline,
    source,
  );
  const shortTitle = title.length > 68 ? title.slice(0, 68) + "…" : title;
  if (/성과급|임단협|노사|임금/.test(title))
    return "노사 협상과 성과급·보상 정책의 변화를 다룬 보도입니다.";
  if (/실적|영업이익|영업익|매출|순이익/.test(title))
    return "최근 실적과 수익성 변화가 주가에 미치는 영향을 다룬 보도입니다.";
  if (/주가|급등|폭락|상승|하락|매도|매수/.test(title))
    return "주가 변동과 투자자 매매·수급 흐름을 다룬 보도입니다.";
  if (/HBM|반도체|AI|생산|공장|투자/.test(title))
    return "반도체 수요와 생산·투자 계획의 영향을 다룬 보도입니다.";
  if (/상품|거래소|상장/.test(title))
    return "국내외 거래시장과 관련 상품 확대 흐름을 다룬 보도입니다.";
  return shortTitle + " 관련 핵심 내용을 다룬 보도입니다.";
}

function contentTimestamp(item: AnyObj): number {
  const raw = String(
    item.date ??
      item.filingDate ??
      item.rcept_dt ??
      item.publishedAt ??
      item.published_at ??
      item.time ??
      item.acceptedAt ??
      "",
  ).trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8) {
    const year = Number(digits.slice(0, 4));
    const month = Number(digits.slice(4, 6));
    const day = Number(digits.slice(6, 8));
    const hour = Number(digits.slice(8, 10) || 0);
    const minute = Number(digits.slice(10, 12) || 0);
    const parsedDigits = new Date(
      year,
      Math.max(0, month - 1),
      day,
      hour,
      minute,
    ).getTime();
    if (Number.isFinite(parsedDigits)) return parsedDigits;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortContentNewest(items: AnyObj[]) {
  return [...items].sort((a, b) => contentTimestamp(b) - contentTimestamp(a));
}

function FilingTab({
  ticker,
  market,
  filings,
  summary,
}: {
  ticker: string;
  market: Market;
  filings: AnyObj[];
  summary: string;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<AnyObj[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const source = market === "KR" ? "DART" : "SEC EDGAR";
  const sorted = sortContentNewest(filings);
  const historySorted = sortContentNewest(history ?? filings);
  const recentSummary = sorted[0]
    ? filingPlainSummary(sorted[0])
    : summary || "최근 공시 요약 데이터가 부족합니다.";
  const pageCount = Math.max(1, Math.ceil(historySorted.length / 10));
  const pageItems = historySorted.slice((page - 1) * 10, page * 10);

  const openHistory = async () => {
    setPage(1);
    setMoreOpen(true);
    if (history || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await tryJson<AnyObj>(
        [`/api/stocks/${ticker}/filings?all=1`],
        {},
      );
      const loaded = collectFilings(response);
      if (!loaded.length) throw new Error("EMPTY_FILING_HISTORY");
      setHistory(loaded);
    } catch {
      setHistoryError(
        "이전 공시를 불러오지 못했습니다. 잠시 후 다시 눌러 주세요.",
      );
    } finally {
      setHistoryLoading(false);
    }
  };
  const renderItems = (items: AnyObj[]) => (
    <div className="space-y-2">
      {items.map((item, index) => {
        const title = cleanContentTitle(
          item.translatedTitle ??
            item.title ??
            item.report_nm ??
            item.report ??
            item.form ??
            "공시 제목 확인 필요",
        );
        const form = String(
          item.form ?? item.formType ?? item.reportType ?? "",
        ).trim();
        const date = formatContentDate(
          item.date ?? item.filingDate ?? item.rcept_dt ?? item.acceptedAt,
        );
        const url = filingOriginalUrl(item, market);
        return (
          <article
            key={`${String(item.rcept_no ?? item.accessionNumber ?? url ?? title)}:${index}`}
            className="rounded-xl border border-card-border bg-secondary/50 p-3"
          >
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="block break-words text-sm font-extrabold leading-6 text-primary underline-offset-2 hover:underline"
              >
                {title}
              </a>
            ) : (
              <p className="break-words text-sm font-extrabold leading-6">
                {title}
              </p>
            )}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold text-muted-foreground">
                {date}
              </span>
              <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
                {source}
              </span>
              {Number(item.relatedCount ?? 1) > 1 && (
                <span className="rounded-full bg-positive/10 px-2 py-1 text-[10px] font-extrabold text-positive">
                  (중복 {Number(item.relatedCount)}건)
                </span>
              )}
              {form && (
                <span className="rounded-full bg-background px-2 py-1 text-[10px] font-bold text-muted-foreground">
                  {form}
                </span>
              )}
            </div>
            <p className="mt-2 break-words rounded-lg bg-background/70 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground">
              {filingPlainSummary(item)}
            </p>
          </article>
        );
      })}
    </div>
  );
  return (
    <div className="space-y-3">
      <SectionCard title="최근 공시 요약" subtitle={`${source} 최신 공시 기준`}>
        <InfoBox>{recentSummary}</InfoBox>
      </SectionCard>
      <SectionCard
        title="공시 원문"
        subtitle="최근 공시 5건을 표시합니다. 제목을 누르면 원문으로 이동합니다."
        actions={
          <button
            type="button"
            onClick={() => void openHistory()}
            className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary"
          >
            더보기
          </button>
        }
      >
        {sorted.length ? (
          renderItems(sorted.slice(0, 5))
        ) : (
          <p className="text-sm font-bold text-muted-foreground">
            최근 확인된 공시가 없습니다.
          </p>
        )}
      </SectionCard>
      {moreOpen && (
        <Modal
          title="전체 공시"
          subtitle={
            historyLoading
              ? "이전 공시를 불러오는 중"
              : `${historySorted.length}건 · 전체 이력 · 최신순`
          }
          onClose={() => setMoreOpen(false)}
        >
          {historyLoading ? (
            <p className="rounded-xl bg-secondary/60 p-4 text-center text-sm font-extrabold text-primary">
              DART 이전 공시를 불러오고 있습니다…
            </p>
          ) : historyError ? (
            <p className="rounded-xl bg-destructive/10 p-4 text-center text-sm font-bold text-destructive">
              {historyError}
            </p>
          ) : (
            <>
              {renderItems(pageItems)}
              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  className="rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold disabled:opacity-40"
                >
                  이전
                </button>
                <span className="text-xs font-extrabold">
                  {page} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() =>
                    setPage((value) => Math.min(pageCount, value + 1))
                  }
                  className="rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold disabled:opacity-40"
                >
                  다음
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function NewsTab({
  ticker,
  news,
  summary,
}: {
  ticker: string;
  news: AnyObj[];
  summary: string;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<AnyObj[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const sorted = sortContentNewest(news);
  const historySorted = sortContentNewest(history ?? news);
  const recentSummary = sorted[0]
    ? newsPlainSummary(sorted[0])
    : summary || "최근 뉴스 요약 데이터가 부족합니다.";
  const pageCount = Math.max(1, Math.ceil(historySorted.length / 10));
  const pageItems = historySorted.slice((page - 1) * 10, page * 10);

  const openHistory = async () => {
    setPage(1);
    setMoreOpen(true);
    if (history || historyLoading) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await tryJson<AnyObj>(
        [`/api/stocks/${ticker}/news?all=1`],
        {},
      );
      const loaded = collectNews(response);
      if (!loaded.length) throw new Error("EMPTY_NEWS_HISTORY");
      setHistory(loaded);
    } catch {
      setHistoryError(
        "이전 뉴스를 불러오지 못했습니다. 잠시 후 다시 눌러 주세요.",
      );
    } finally {
      setHistoryLoading(false);
    }
  };
  const renderItems = (items: AnyObj[]) => (
    <div className="space-y-2">
      {items.map((item, index) => {
        const source = String(
          item.source ?? item.publisher ?? item.provider ?? "출처 확인",
        ).trim();
        const title = cleanContentTitle(
          item.translatedTitle ??
            item.title ??
            item.headline ??
            "뉴스 제목 확인 필요",
          source,
        );
        const url = articleOriginalUrl(item);
        const date = formatContentDate(
          item.date ?? item.time ?? item.publishedAt ?? item.published_at,
        );
        const brief = newsPlainSummary(item);
        return (
          <article
            key={`${String(url ?? title)}:${index}`}
            className="rounded-xl border border-card-border bg-secondary/50 p-3"
          >
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="block break-words text-[15px] font-extrabold leading-6 text-primary underline-offset-2 hover:underline"
              >
                {title}
              </a>
            ) : (
              <p className="break-words text-[15px] font-extrabold leading-6">
                {title}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-bold text-muted-foreground">
                {source} · {date}
              </span>
              <span className="max-w-full truncate rounded-full bg-primary/10 px-2 py-1 text-[10px] font-extrabold text-primary">
                {eventLabelKo(title)}
              </span>
              {Number(item.relatedCount ?? 1) > 1 && (
                <span className="rounded-full bg-positive/10 px-2 py-1 text-[10px] font-extrabold text-positive">
                  (중복 {Number(item.relatedCount)}건)
                </span>
              )}
            </div>
            <p className="mt-2 break-words rounded-lg bg-background/70 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground">
              <span className="font-extrabold text-foreground">
                간단 브리핑 ·{" "}
              </span>
              {brief}
            </p>
          </article>
        );
      })}
    </div>
  );
  return (
    <div className="space-y-3">
      <SectionCard title="최근 뉴스 요약" subtitle="해당 종목 최신 기사 기준">
        <InfoBox>{recentSummary}</InfoBox>
      </SectionCard>
      <SectionCard
        title="뉴스 원문"
        subtitle="최근 뉴스 5건을 표시합니다. 제목을 누르면 원문으로 이동합니다."
        actions={
          <button
            type="button"
            onClick={() => void openHistory()}
            className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-extrabold text-primary"
          >
            더보기
          </button>
        }
      >
        {sorted.length ? (
          renderItems(sorted.slice(0, 5))
        ) : (
          <p className="text-sm font-bold text-muted-foreground">
            최근 관련 뉴스가 없습니다.
          </p>
        )}
      </SectionCard>
      {moreOpen && (
        <Modal
          title="전체 뉴스"
          subtitle={
            historyLoading
              ? "이전 뉴스를 불러오는 중"
              : `${historySorted.length}건 · 제공처 전체 이력 · 최신순`
          }
          onClose={() => setMoreOpen(false)}
        >
          {historyLoading ? (
            <p className="rounded-xl bg-secondary/60 p-4 text-center text-sm font-extrabold text-primary">
              이전 뉴스 전체를 불러오고 있습니다…
            </p>
          ) : historyError ? (
            <p className="rounded-xl bg-destructive/10 p-4 text-center text-sm font-bold text-destructive">
              {historyError}
            </p>
          ) : (
            <>
              {renderItems(pageItems)}
              <div className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                  className="rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold disabled:opacity-40"
                >
                  이전
                </button>
                <span className="text-xs font-extrabold">
                  {page} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={page >= pageCount}
                  onClick={() =>
                    setPage((value) => Math.min(pageCount, value + 1))
                  }
                  className="rounded-xl border border-card-border px-4 py-2 text-xs font-extrabold disabled:opacity-40"
                >
                  다음
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="min-w-0 rounded-xl bg-secondary/70 px-2 py-2 text-center">
      <p className="truncate text-[9px] font-bold text-muted-foreground">
        {label}
      </p>

      <p className={cn("mt-1 truncate text-xs font-extrabold", valueClassName)}>
        {value}
      </p>
    </div>
  );
}

function SignalBox({
  label,
  text,
  positive = false,
  compact = false,
  onClick,
}: {
  label: string;
  text: string;
  positive?: boolean;
  compact?: boolean;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "rounded-xl border px-2.5 py-2",
        compact && "min-w-0 px-2 py-2 text-center",

        positive
          ? "border-positive/30 bg-positive/5"
          : "border-destructive/30 bg-destructive/5",
      )}
    >
      <p
        className={cn(
          "text-[9px] font-extrabold",

          positive ? "text-positive" : "text-destructive",
        )}
      >
        {label}
      </p>

      <p
        className={cn(
          "mt-1 break-keep text-[10px] font-semibold leading-4 text-muted-foreground",
          compact && "line-clamp-3 text-[9px] leading-3.5",
        )}
      >
        {text}
      </p>
    </Tag>
  );
}

function SummaryCard({ title, items }: { title: string; items: string[] }) {
  return (
    <SectionCard title={title}>
      <SummaryItems items={items} />
    </SectionCard>
  );
}

function SummaryItems({ items }: { items: string[] }) {
  return items?.length ? (
    <div className="space-y-2">
      {items.slice(0, 5).map((item, index) => (
        <p
          key={`${item}:${index}`}
          className="rounded-xl bg-secondary/60 px-3 py-2 text-xs font-semibold leading-5 text-muted-foreground"
        >
          {item}
        </p>
      ))}
    </div>
  ) : (
    <p className="text-sm font-bold text-muted-foreground">
      분석 데이터가 부족합니다.
    </p>
  );
}

function CollapsibleSection({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-base font-extrabold">{title}</span>
        <span className="flex items-center gap-2 text-[10px] font-extrabold text-primary">
          {open ? "접기" : "열기"}
          <span
            className={cn(
              "text-base transition-transform",
              open && "rotate-180",
            )}
          >
            ⌄
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-card-border p-3">{children}</div>
      )}
    </section>
  );
}

function PlanRow({
  label,
  value,
  negative = false,
  onClick,
}: {
  label: string;
  value: string;
  negative?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-xl border border-card-border bg-secondary/55 p-3 text-left transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-extrabold">{label}</p>

        <p
          className={cn(
            "shrink-0 text-sm font-extrabold",

            negative ? "text-destructive" : "text-primary",
          )}
        >
          {value}
        </p>
      </div>

      <p className="mt-2 break-keep text-[10px] font-semibold leading-4 text-muted-foreground">
        눌러서 진입 근거와 확인 조건 보기
      </p>
    </button>
  );
}

function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 break-keep rounded-xl bg-secondary/70 p-3 text-xs font-semibold leading-5 text-muted-foreground">
      {children}
    </div>
  );
}

function FinancialPerformanceChart({
  rows,
  currency,
}: {
  rows: AnyObj[];
  currency: Currency;
}) {
  const chartRows = [...rows].reverse();
  const series = [
    {
      key: "revenue",
      label: "매출",
      color: "#3b82f6",
      value: (row: AnyObj) =>
        financialValue(row.revenue, row.sales, row.totalRevenue),
    },
    {
      key: "operatingIncome",
      label: "영업이익",
      color: "#10b981",
      value: (row: AnyObj) =>
        financialValue(row.operatingIncome, row.operatingProfit, row.opIncome),
    },
    {
      key: "netIncome",
      label: "순이익",
      color: "#06b6d4",
      value: (row: AnyObj) =>
        financialValue(row.netIncome, row.netProfit, row.profit),
    },
    {
      key: "liabilities",
      label: "부채",
      color: "#f43f5e",
      value: (row: AnyObj) =>
        financialValue(row.debt, row.totalLiabilities, row.liabilities),
    },
  ];
  const allValues = chartRows.flatMap((row) =>
    series
      .map((item) => item.value(row))
      .filter(
        (value): value is number => value != null && Number.isFinite(value),
      ),
  );
  const maximum = Math.max(...allValues.map((value) => Math.abs(value)), 1);
  const width = 560;
  const height = 260;
  const baseline = 150;
  const groupWidth = (width - 48) / Math.max(chartRows.length, 1);
  const barWidth = Math.min(19, Math.max(9, (groupWidth - 20) / series.length));
  const latestRow = rows[0];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-x-3 gap-y-1">
        {series.map((item) => (
          <span
            key={item.key}
            className="flex items-center gap-1 text-[10px] font-extrabold text-muted-foreground"
          >
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-card-border bg-secondary/35 p-2">
        <svg
          role="img"
          aria-label="기간별 매출, 영업이익, 순이익, 부채 비교 그래프"
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full"
        >
          <line
            x1="36"
            x2={width - 8}
            y1={baseline}
            y2={baseline}
            stroke="currentColor"
            strokeOpacity="0.28"
            strokeWidth="1"
          />
          <text
            x="8"
            y={baseline + 4}
            fill="currentColor"
            fillOpacity="0.55"
            fontSize="10"
          >
            0
          </text>

          {chartRows.map((row, rowIndex) => {
            const centerX = 48 + groupWidth * rowIndex + groupWidth / 2;
            const barsWidth = barWidth * series.length;
            const startX = centerX - barsWidth / 2;
            const periodLabel = String(
              row.period ?? row.date ?? row.year ?? "기간",
            );

            return (
              <g key={`${periodLabel}:${rowIndex}`}>
                {series.map((item, seriesIndex) => {
                  const value = item.value(row);
                  if (value == null) return null;
                  const positive = value >= 0;
                  const scaled = Math.max(
                    3,
                    (Math.abs(value) / maximum) * (positive ? 105 : 55),
                  );

                  return (
                    <rect
                      key={item.key}
                      x={startX + seriesIndex * barWidth + 1}
                      y={positive ? baseline - scaled : baseline}
                      width={Math.max(5, barWidth - 2)}
                      height={scaled}
                      rx="3"
                      fill={item.color}
                      opacity={positive ? 0.9 : 0.68}
                    >
                      <title>{`${periodLabel} ${item.label} ${formatCompactMoney(value, currency)}`}</title>
                    </rect>
                  );
                })}
                <text
                  x={centerX}
                  y="229"
                  textAnchor="middle"
                  fill="currentColor"
                  fillOpacity="0.72"
                  fontSize="10"
                  fontWeight="700"
                >
                  {periodLabel}
                </text>
              </g>
            );
          })}

          <text
            x="44"
            y="18"
            fill="currentColor"
            fillOpacity="0.55"
            fontSize="10"
            fontWeight="700"
          >
            금액 규모 비교
          </text>
          <text
            x="44"
            y="250"
            fill="currentColor"
            fillOpacity="0.5"
            fontSize="9"
          >
            기준선 아래 막대는 적자입니다
          </text>
        </svg>
      </div>

      {latestRow && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {series.map((item) => (
            <div
              key={item.key}
              className="rounded-xl bg-secondary/60 px-3 py-2"
            >
              <p className="text-[9px] font-extrabold text-muted-foreground">
                최근 {item.label}
              </p>
              <p className="mt-1 text-xs font-extrabold">
                {formatMillions(item.value(latestRow))}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FinancialTrendCard({
  label,
  values,
  periods,
  currency,
  color,
  onOpen,
}: {
  label: string;
  values: Array<number | null>;
  periods: string[];
  currency: Currency;
  color: string;
  onOpen?: () => void;
}) {
  const available = values.filter(
    (value): value is number => value != null && Number.isFinite(value),
  );
  const maximum = Math.max(...available.map((value) => Math.abs(value)), 1);
  const latest = [...values].reverse().find((value) => value != null) ?? null;
  const first = values.find((value) => value != null) ?? null;
  const growing = latest != null && first != null && latest >= first;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-2xl border border-card-border bg-secondary/35 p-3 text-left transition active:scale-[0.99]"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-extrabold">{label}</p>
          <p className="mt-1 text-base font-extrabold">
            {formatMillions(latest)}
          </p>
          <p className="text-[8px] font-bold text-muted-foreground">
            {currency === "USD" ? "USD million" : "백만원"}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-[9px] font-extrabold",
            growing
              ? "bg-positive/10 text-positive"
              : "bg-destructive/10 text-destructive",
          )}
        >
          {growing ? "↗ 증가 흐름" : "↘ 감소 흐름"}
        </span>
      </div>

      <div className="mt-4 flex h-28 items-end gap-2">
        {values.map((value, index) => {
          const height =
            value == null ? 4 : Math.max(10, (Math.abs(value) / maximum) * 88);

          return (
            <div
              key={`${periods[index]}:${index}`}
              className="flex min-w-0 flex-1 flex-col items-center justify-end"
            >
              <p className="mb-1 max-w-full truncate text-[8px] font-bold text-muted-foreground">
                {formatMillions(value)}
              </p>
              <div
                className={cn("w-full rounded-t-lg opacity-85", color)}
                style={{ height: `${height}px` }}
              />
              <p className="mt-1 max-w-full truncate text-[8px] font-bold text-muted-foreground">
                {periods[index]}
              </p>
            </div>
          );
        })}
      </div>
    </button>
  );
}

function ExplanationBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-xl bg-secondary/60 p-3">
      <p className="text-[10px] font-extrabold text-primary">{label}</p>

      <p className="mt-1 break-keep text-xs font-semibold leading-5 text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

function Modal({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4">
      <button
        type="button"
        aria-label="닫기"
        onClick={onClose}
        className="absolute inset-0"
      />

      <section className="relative z-10 flex max-h-[92dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-card-border bg-card p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold">{title}</h3>
            {subtitle && (
              <p className="mt-1 break-keep text-[11px] font-bold leading-4 text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-lg font-bold text-muted-foreground"
          >
            ×
          </button>
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain break-keep pr-1 text-sm font-semibold leading-6 text-muted-foreground">
          {children}
        </div>
      </section>
    </div>
  );
}
