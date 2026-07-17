import { authorizedFetch } from '@/lib/auth-fetch';
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, TrendingDown, TrendingUp, X, Star } from "lucide-react";
import { BottomNav } from "@/components/bottom-nav";
import {
  displayStockName,
  formatAppPercent,
  formatAppPrice,
} from "@/lib/stock-display";
import { classifyStock, stockClassBadgeClass } from "@/lib/stock-classifier";
import { readWatchlistItems, WATCHLIST_CHANGE_EVENT } from "@/lib/stock-display";
import { cn } from "@/lib/utils";

type AnyObj = Record<string, any>;
type Market = "KR" | "US";
type Currency = "KRW" | "USD";

type RankType =
  | "recommended"
  | "volume"
  | "tradingValue"
  | "marketCap"
  | "gainers"
  | "losers";

type ClassificationLabel = "우량주" | "보통주" | "저평가주" | "잡주";

interface StockRow {
  ticker: string;
  name: string;
  market: Market;
  currency: Currency;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  tradingValue: number | null;
  marketCap: number | null;
  rank: number;
  sourceRank: number;
  reason: string;
  provider: string;

  rating: {
    score: number | null;
    rating?: string;
    confidence?: number | null;
  } | null;

  classification: ClassificationLabel;
  raw?: AnyObj;
}

const MARKET_TABS: Array<{
  key: Market;
  label: string;
}> = [
  {
    key: "KR",
    label: "국내주식",
  },
  {
    key: "US",
    label: "해외주식",
  },
];

const RANK_TABS: Array<{
  key: RankType;
  label: string;
}> = [
  {
    key: "marketCap",
    label: "시총",
  },
  {
    key: "volume",
    label: "거래량",
  },
  {
    key: "tradingValue",
    label: "거래대금",
  },
  {
    key: "recommended",
    label: "AI추천",
  },
  {
    key: "gainers",
    label: "급상승",
  },
  {
    key: "losers",
    label: "급하락",
  },
];

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/,/g, "")
    .replace(/%/g, "")
    .replace(/[₩$원]/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed) ? parsed : null;
}

function absoluteNumber(value: unknown): number | null {
  const parsed = toNumber(value);

  return parsed == null ? null : Math.abs(parsed);
}

function firstValue(row: AnyObj, keys: string[]): unknown {
  for (const key of keys) {
    if (row?.[key] != null && row[key] !== "") {
      return row[key];
    }
  }

  return undefined;
}

function firstArray(data: AnyObj, keys: string[]): AnyObj[] {
  for (const key of keys) {
    if (Array.isArray(data?.[key])) {
      return data[key];
    }
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.rows)) {
    return data.rows;
  }

  if (Array.isArray(data?.items)) {
    return data.items;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  return [];
}

function marketFromRow(row: AnyObj, fallback: Market): Market {
  const raw = String(
    row?.market ??
      row?.marketType ??
      row?.country ??
      row?.exchangeCountry ??
      "",
  ).toUpperCase();

  if (
    raw === "US" ||
    raw.includes("NASDAQ") ||
    raw.includes("NYSE") ||
    raw.includes("AMEX") ||
    raw.includes("USA")
  ) {
    return "US";
  }

  if (
    raw === "KR" ||
    raw.includes("KOSPI") ||
    raw.includes("KOSDAQ") ||
    raw.includes("KRX") ||
    raw.includes("KOREA")
  ) {
    return "KR";
  }

  const ticker = String(
    firstValue(row, [
      "ticker",
      "symbol",
      "stk_cd",
      "stk_code",
      "code",
      "item_cd",
      "ovrs_pdno",
    ]) ?? "",
  ).trim();

  return /^\d/.test(ticker) ? "KR" : fallback;
}

function scoreOf(row: AnyObj): number | null {
  return toNumber(
    row?.rating?.score ??
      row?.aiRating?.score ??
      row?.analysis?.score ??
      row?.score ??
      row?.aiScore,
  );
}

function explicitClassification(row: AnyObj): ClassificationLabel | null {
  const value = String(
    row?.classification?.label ??
      row?.stockClassification?.label ??
      row?.stockClass ??
      row?.classLabel ??
      "",
  ).trim();

  if (
    value === "우량주" ||
    value === "중립" ||
    value === "보통주" ||
    value === "저평가주" ||
    value === "잡주"
  ) {
    return value === "중립" ? "보통주" : value;
  }

  return null;
}

function classifyRow(row: AnyObj, score: number | null): ClassificationLabel {
  const explicit = explicitClassification(row);
  if (explicit) return explicit;

  return classifyStock({
    ticker: String(row?.ticker ?? row?.symbol ?? row?.stk_cd ?? row?.code ?? ""),
    name: String(row?.name ?? row?.stockName ?? row?.item_name ?? ""),
    score,
    aiScore: score,
    marketCap: toNumber(row?.marketCap ?? row?.market_cap ?? row?.marketValue),
    per: toNumber(row?.per),
    pbr: toNumber(row?.pbr),
    roe: toNumber(row?.roe),
    debtRatio: toNumber(row?.debtRatio),
    operatingIncome: toNumber(row?.operatingIncome),
    netIncome: toNumber(row?.netIncome),
    equity: toNumber(row?.equity),
    reasons: [String(row?.reason ?? row?.recommendationReason ?? "")],
    risks: Array.isArray(row?.risks) ? row.risks.map(String) : [],
    currency: /^\d/.test(String(row?.ticker ?? row?.symbol ?? "")) ? "KRW" : "USD",
  }).label;
}

function normalizeStockRow(
  row: AnyObj,
  fallbackMarket: Market,
  fallbackRank: number,
): StockRow | null {
  const ticker = String(
    firstValue(row, [
      "ticker",
      "symbol",
      "stk_cd",
      "stk_code",
      "code",
      "item_cd",
      "item_code",
      "ovrs_pdno",
      "eng_stk_cd",
    ]) ?? "",
  )
    .trim()
    .toUpperCase();

  if (!ticker) {
    return null;
  }

  const market = marketFromRow(row, fallbackMarket);

  const currency: Currency = market === "KR" ? "KRW" : "USD";

  const score = scoreOf(row);

  const sourceRankValue = toNumber(
    firstValue(row, ["sourceRank", "rank", "rnk", "kw_high_rank"]),
  );

  const sourceRank =
    sourceRankValue == null
      ? fallbackRank
      : Math.max(1, Math.trunc(Math.abs(sourceRankValue)));

  const ratingText = String(
    row?.rating?.rating ?? row?.aiRating?.rating ?? row?.opinion ?? "",
  ).trim();

  return {
    ticker,

    name: String(
      firstValue(row, [
        "name",
        "stk_nm",
        "stk_name",
        "kor_nm",
        "item_nm",
        "item_name",
        "ovrs_item_name",
        "companyName",
      ]) ?? ticker,
    ).trim(),

    market,
    currency,

    price: absoluteNumber(
      firstValue(row, [
        "price",
        "cur_prc",
        "now_pric",
        "curr_pric",
        "last",
        "last_pric",
        "close",
        "prpr",
        "ovrs_nmix_prpr",
      ]),
    ),

    changePercent: toNumber(
      firstValue(row, [
        "changePercent",
        "flu_rt",
        "chg_rt",
        "change_rate",
        "prdy_ctrt",
        "rate",
        "diff_rate",
        "fluctuation_rate",
      ]),
    ),

    volume: absoluteNumber(
      firstValue(row, [
        "volume",
        "trde_qty",
        "now_trde_qty",
        "acc_trde_qty",
        "acml_vol",
        "acml_volum",
        "trade_volume",
        "tvol",
      ]),
    ),

    tradingValue: absoluteNumber(
      firstValue(row, [
        "tradingValue",
        "trde_amt",
        "trde_prica",
        "trading_value",
        "acml_tr_pbmn",
        "trade_amount",
        "turnover",
      ]),
    ),

    marketCap: absoluteNumber(
      firstValue(row, [
        "marketCap",
        "market_cap",
        "mrkt_cap",
        "marketValue",
        "totalMarketValue",
        "mktcap",
      ]),
    ),

    rank: fallbackRank,

    sourceRank,

    reason: String(
      row?.reason ?? row?.recommendationReason ?? row?.opinionReason ?? "",
    ).trim(),

    provider: String(row?.provider ?? row?.source ?? ""),

    rating:
      score != null || ratingText
        ? {
            score,

            rating: ratingText || undefined,

            confidence: toNumber(
              row?.rating?.confidence ??
                row?.aiRating?.confidence ??
                row?.confidence,
            ),
          }
        : null,

    classification: classifyRow(row, score),

    raw: row,
  };
}

function normalizeRows(rows: AnyObj[], market: Market): StockRow[] {
  const seen = new Set<string>();

  const result: StockRow[] = [];

  rows.forEach((row, index) => {
    const normalized = normalizeStockRow(row, market, index + 1);

    if (!normalized || seen.has(normalized.ticker)) {
      return;
    }

    seen.add(normalized.ticker);

    result.push(normalized);
  });

  return result.map((row, index) => ({
    ...row,
    rank: index + 1,
  }));
}

async function fetchJson(url: string): Promise<AnyObj> {
  const response = await authorizedFetch(url, {
    cache: "no-store",
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;

    try {
      const body = (await response.json()) as AnyObj;

      message = String(body?.error ?? body?.message ?? message);
    } catch {
      // 기본 오류 문구를 사용합니다.
    }

    throw new Error(message);
  }

  return (await response.json()) as AnyObj;
}

async function enrichRowsWithQuotes(rows: StockRow[]): Promise<StockRow[]> {
  if (!rows.length) return rows;
  try {
    const tickers = rows.map((row) => row.ticker).join(",");
    const data = await fetchJson(
      `/api/quotes?tickers=${encodeURIComponent(tickers)}`,
    );
    const quoteRows = firstArray(data, [
      "quotes",
      "rows",
      "items",
      "results",
      "data",
    ]);
    const quoteMap = new Map<string, StockRow>();
    quoteRows.forEach((quote, index) => {
      const normalized = normalizeStockRow(
        quote,
        rows[0]?.market ?? "KR",
        index + 1,
      );
      if (normalized) quoteMap.set(normalized.ticker, normalized);
    });
    return rows.map((row) => {
      const quote = quoteMap.get(row.ticker);
      if (!quote) return row;
      return {
        ...row,
        name: quote.name || row.name,
        price: quote.price ?? row.price,
        changePercent: quote.changePercent ?? row.changePercent,
        volume: quote.volume ?? row.volume,
        tradingValue: quote.tradingValue ?? row.tradingValue,
        marketCap: quote.marketCap ?? row.marketCap,
        raw: { ...(row.raw ?? {}), ...(quote.raw ?? {}) },
      };
    });
  } catch (error) {
    console.error("공통 시세 보강 실패", error);
    return rows;
  }
}

async function fetchKiwoomRankingRows(
  market: Market,
  rank: Exclude<RankType, "recommended" | "marketCap">,
  limit = 30,
): Promise<StockRow[]> {
  const params = new URLSearchParams({
    market,
    type: rank,
    limit: String(limit),
    assetFilter: "stocks",
    excludeHighRisk: "true",
  });

  const data = await fetchJson(`/api/kiwoom/rankings?${params.toString()}`);

  const rows = firstArray(data, [
    "rows",
    "rankings",
    "items",
    "results",
    "data",
  ]);

  const normalized = normalizeRows(rows, market).slice(0, limit);

  if (!normalized.length) {
    throw new Error("키움 랭킹 종목이 없습니다.");
  }

  return normalized;
}

function moverRowsForRank(data: AnyObj, rank: RankType): AnyObj[] {
  if (rank === "recommended") {
    return firstArray(data, ["recommended", "picks", "aiRecommended"]);
  }

  if (rank === "volume") {
    const rows = firstArray(data, ["volume", "volumeLeaders"]);

    return rows.length ? rows : firstArray(data, ["popular"]);
  }

  if (rank === "marketCap") {
    return firstArray(data, [
      "recommended",
      "popular",
      "volume",
      "tradingValue",
      "gainers",
      "losers",
    ]);
  }

  if (rank === "tradingValue") {
    const rows = firstArray(data, [
      "tradingValue",
      "tradingValueLeaders",
      "amount",
    ]);

    return rows.length ? rows : firstArray(data, ["popular"]);
  }

  return rank === "gainers"
    ? firstArray(data, ["gainers", "rising"])
    : firstArray(data, ["losers", "falling"]);
}

async function fetchFallbackMoverRows(
  market: Market,
  rank: RankType,
): Promise<StockRow[]> {
  const data = await fetchJson(`/api/market/movers?market=${market}`);

  return normalizeRows(moverRowsForRank(data, rank), market).slice(0, 30);
}

async function fetchAiScorePool(market: Market): Promise<StockRow[]> {
  const data = await fetchJson(`/api/market/movers?market=${market}`);

  const merged = [
    ...firstArray(data, ["recommended"]),

    ...firstArray(data, ["popular"]),

    ...firstArray(data, ["volume"]),

    ...firstArray(data, ["tradingValue"]),

    ...firstArray(data, ["gainers"]),

    ...firstArray(data, ["losers"]),

    ...firstArray(data, ["risky"]),
  ];

  return normalizeRows(merged, market).filter(
    (row) => row.rating?.score != null,
  );
}

async function fetchExistingAiRecommendedRows(
  market: Market,
  limit = 30,
): Promise<StockRow[]> {
  const data = await fetchJson(`/api/market/movers?market=${market}`);

  const rows = normalizeRows(
    firstArray(data, ["recommended", "picks", "aiRecommended"]),
    market,
  )
    .filter((row) => row.rating?.score != null)
    .sort(
      (a, b) => (b.rating?.score ?? -Infinity) - (a.rating?.score ?? -Infinity),
    )
    .slice(0, limit)
    .map((row, index) => ({
      ...row,

      rank: index + 1,

      reason:
        row.reason ||
        `AI 점수 ${Math.round(row.rating?.score ?? 0)}점 기준 추천 종목입니다.`,
    }));

  if (!rows.length) {
    throw new Error("기존 AI 추천 종목이 없습니다.");
  }

  return rows;
}

async function fetchKiwoomAiRecommendedRows(
  market: Market,
  limit = 30,
): Promise<StockRow[]> {
  const [tradingValueRows, volumeRows, gainerRows, aiPool] = await Promise.all([
    fetchKiwoomRankingRows(market, "tradingValue", 100).catch(() => []),

    fetchKiwoomRankingRows(market, "volume", 100).catch(() => []),

    fetchKiwoomRankingRows(market, "gainers", 100).catch(() => []),

    fetchAiScorePool(market),
  ]);

  const candidateMap = new Map<string, StockRow>();

  for (const row of [...tradingValueRows, ...volumeRows, ...gainerRows]) {
    if (!candidateMap.has(row.ticker)) {
      candidateMap.set(row.ticker, row);
    }
  }

  const aiMap = new Map<string, StockRow>();

  for (const row of aiPool) {
    if (row.rating?.score != null) {
      aiMap.set(row.ticker, row);
    }
  }

  const recommended: StockRow[] = [];

  for (const candidate of candidateMap.values()) {
    const scored = aiMap.get(candidate.ticker);

    if (!scored) {
      continue;
    }

    const score = scored.rating?.score;

    if (score == null || !Number.isFinite(score)) {
      continue;
    }

    recommended.push({
      ...candidate,

      name: scored.name || candidate.name,

      price: candidate.price ?? scored.price,

      changePercent: candidate.changePercent ?? scored.changePercent,

      rating: {
        score,

        rating: scored.rating?.rating,

        confidence: scored.rating?.confidence ?? null,
      },

      classification: scored.classification,

      reason: `AI 점수 ${Math.round(
        score,
      )}점 · 키움증권 거래대금·거래량·급상승 후보입니다.`,
    });
  }

  recommended.sort(
    (a, b) => (b.rating?.score ?? -Infinity) - (a.rating?.score ?? -Infinity),
  );

  const used = new Set(recommended.map((row) => row.ticker));

  for (const row of aiPool
    .filter((item) => item.rating?.score != null && !used.has(item.ticker))
    .sort(
      (a, b) => (b.rating?.score ?? -Infinity) - (a.rating?.score ?? -Infinity),
    )) {
    if (recommended.length >= limit) {
      break;
    }

    used.add(row.ticker);

    recommended.push({
      ...row,

      reason:
        row.reason ||
        `AI 점수 ${Math.round(
          row.rating?.score ?? 0,
        )}점 기준 보충 추천 종목입니다.`,
    });
  }

  const result = recommended.slice(0, limit).map((row, index) => ({
    ...row,

    rank: index + 1,
  }));

  if (!result.length) {
    throw new Error("키움 후보와 AI 점수가 일치하는 종목이 없습니다.");
  }

  return result;
}

async function fetchSingleMarketAiRecommendedRows(
  market: Market,
  limit = 30,
): Promise<StockRow[]> {
  try {
    return await fetchKiwoomAiRecommendedRows(market, limit);
  } catch (error) {
    console.error(`${market} 키움 AI 추천 실패`, error);

    try {
      return await fetchExistingAiRecommendedRows(market, limit);
    } catch (fallbackError) {
      console.error(`${market} 기존 AI 추천 실패`, fallbackError);

      return fetchFallbackMoverRows(market, "recommended");
    }
  }
}

async function fetchMoverRows(
  market: Market,
  rank: RankType,
): Promise<StockRow[]> {
  let rows: StockRow[] = [];
  if (rank === "recommended") {
    rows = await fetchSingleMarketAiRecommendedRows(market, 30);
  } else if (rank === "marketCap") {
    rows = await fetchAiScorePool(market);
  } else {
    try {
      rows = await fetchKiwoomRankingRows(market, rank, 30);
    } catch (error) {
      console.error(`${market} ${rank} 키움 랭킹 실패`, error);
      rows = await fetchFallbackMoverRows(market, rank);
    }
  }
  const enriched = await enrichRowsWithQuotes(rows);
  const sorted = [...enriched];
  if (rank === "volume")
    sorted.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0));
  if (rank === "tradingValue")
    sorted.sort((a, b) => (b.tradingValue ?? 0) - (a.tradingValue ?? 0));
  if (rank === "marketCap")
    sorted.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));
  if (rank === "gainers")
    sorted.sort((a, b) => (b.changePercent ?? 0) - (a.changePercent ?? 0));
  if (rank === "losers")
    sorted.sort((a, b) => (a.changePercent ?? 0) - (b.changePercent ?? 0));
  return sorted.slice(0, 30).map((row, index) => ({ ...row, rank: index + 1 }));
}

async function fetchSearchRows(
  query: string,
  market: Market,
): Promise<StockRow[]> {
  const data = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);

  const rows = firstArray(data, ["results", "items", "rows", "data"]);

  return normalizeRows(rows, market)
    .filter((row) => row.market === market)
    .slice(0, 30);
}

function initialMarket(): Market {
  return new URLSearchParams(window.location.search).get("market") === "US"
    ? "US"
    : "KR";
}

function initialRank(): RankType {
  const value = new URLSearchParams(window.location.search).get("rank");

  return value === "volume" ||
    value === "tradingValue" ||
    value === "marketCap" ||
    value === "gainers" ||
    value === "losers" ||
    value === "recommended"
    ? value
    : "recommended";
}

function formatLargeNumber(value: number | null, market: Market): string {
  if (value == null || !Number.isFinite(value)) {
    return "확인 필요";
  }

  const absolute = Math.abs(value);

  if (market === "KR") {
    if (absolute >= 1_000_000_000_000) {
      return `${(absolute / 1_000_000_000_000).toFixed(1)}조`;
    }

    if (absolute >= 100_000_000) {
      return `${(absolute / 100_000_000).toFixed(0)}억`;
    }

    if (absolute >= 10_000) {
      return `${(absolute / 10_000).toFixed(0)}만`;
    }
  } else {
    if (absolute >= 1_000_000_000) {
      return `${(absolute / 1_000_000_000).toFixed(1)}B`;
    }

    if (absolute >= 1_000_000) {
      return `${(absolute / 1_000_000).toFixed(1)}M`;
    }

    if (absolute >= 1_000) {
      return `${(absolute / 1_000).toFixed(1)}K`;
    }
  }

  return Math.round(absolute).toLocaleString();
}

function rowDescription(row: StockRow, rank: RankType): string {
  if (row.reason) {
    return row.reason;
  }

  if (rank === "recommended") {
    return row.rating?.score != null
      ? `AI 점수 ${Math.round(row.rating.score)}점 기준 추천 종목입니다.`
      : "AI 분석 기준 추천 종목입니다.";
  }

  if (rank === "volume") {
    return `거래량 ${formatLargeNumber(
      row.volume,
      row.market,
    )} · 키움증권 거래량 상위 종목입니다.`;
  }

  if (rank === "tradingValue") {
    return `거래대금 ${formatLargeNumber(
      row.tradingValue,
      row.market,
    )} · 키움증권 거래대금 상위 종목입니다.`;
  }

  if (rank === "marketCap") {
    return (
      "시가총액 " +
      formatLargeNumber(row.marketCap, row.market) +
      " 기준 상위 종목입니다."
    );
  }

  return rank === "gainers"
    ? "키움증권 등락률 기준 급상승 종목입니다."
    : "키움증권 등락률 기준 급하락 종목입니다.";
}

function rankTitle(rank: RankType): string {
  if (rank === "recommended") {
    return "AI 추천 종목";
  }

  if (rank === "volume") {
    return "거래량 상위";
  }

  if (rank === "tradingValue") {
    return "거래대금 상위";
  }

  if (rank === "marketCap") {
    return "시가총액 상위";
  }

  if (rank === "gainers") {
    return "급상승 종목";
  }

  return "급하락 종목";
}

async function fetchWatchlistRows(items: ReturnType<typeof readWatchlistItems>): Promise<StockRow[]> {
  const tickers = items.map((item) => item.ticker).filter(Boolean);
  if (!tickers.length) return [];
  try {
    const response = await authorizedFetch(`/api/quotes?tickers=${encodeURIComponent(tickers.join(","))}&_ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const raw = await response.json();
    const rows = Array.isArray(raw?.quotes) ? raw.quotes : Array.isArray(raw?.items) ? raw.items : [];
    const normalized = rows.map((row: AnyObj, index: number) => normalizeStockRow(row, /^\d/.test(String(row?.ticker ?? "")) ? "KR" : "US", index + 1)).filter(Boolean) as StockRow[];
    const byTicker = new Map(normalized.map((row) => [row.ticker, row]));
    return items.map((item, index) => byTicker.get(item.ticker.toUpperCase()) ?? normalizeStockRow({ ...item, rank: index + 1 }, /^\d/.test(item.ticker) ? "KR" : "US", index + 1)).filter(Boolean) as StockRow[];
  } catch {
    return items.map((item, index) => normalizeStockRow({ ...item, rank: index + 1 }, /^\d/.test(item.ticker) ? "KR" : "US", index + 1)).filter(Boolean) as StockRow[];
  }
}

export default function SearchPage() {
  const [, navigate] = useLocation();

  const [market, setMarket] = useState<Market>(initialMarket);

  const [rank, setRank] = useState<RankType>(initialRank);

  const [query, setQuery] = useState("");
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [watchMarket, setWatchMarket] = useState<Market>("KR");
  const [watchItems, setWatchItems] = useState(() => readWatchlistItems());

  useEffect(() => {
    const refresh = () => setWatchItems(readWatchlistItems());
    window.addEventListener("storage", refresh);
    window.addEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(WATCHLIST_CHANGE_EVENT, refresh);
    };
  }, []);

  const watchlistQuery = useQuery({
    queryKey: ["search-watchlist-live", watchItems.map((item) => item.ticker).join(",")],
    queryFn: () => fetchWatchlistRows(watchItems),
    enabled: watchlistOpen && watchItems.length > 0,
    staleTime: 0,
    refetchInterval: watchlistOpen ? 15_000 : false,
    refetchOnWindowFocus: true,
  });

  const trimmedQuery = query.trim();

  const rankingQuery = useQuery<StockRow[]>({
    queryKey: ["stock-list-page-v5", market, rank],

    queryFn: () => fetchMoverRows(market, rank),

    staleTime: 0,

    gcTime: 5 * 60_000,

    refetchInterval: 10_000,

    refetchOnWindowFocus: true,
  });

  const searchQuery = useQuery<StockRow[]>({
    queryKey: ["stock-search-page-v2", market, trimmedQuery],

    queryFn: () => fetchSearchRows(trimmedQuery, market),

    enabled: trimmedQuery.length > 0,

    staleTime: 30_000,

    gcTime: 5 * 60_000,

    refetchOnWindowFocus: true,
  });

  const rows = useMemo(
    () => (trimmedQuery ? (searchQuery.data ?? []) : (rankingQuery.data ?? [])),
    [trimmedQuery, searchQuery.data, rankingQuery.data],
  );

  const isLoading = trimmedQuery
    ? searchQuery.isLoading
    : rankingQuery.isLoading;

  const isError = trimmedQuery ? searchQuery.isError : rankingQuery.isError;

  const handleMarketChange = (nextMarket: Market) => {
    setMarket(nextMarket);

    navigate(`/search?market=${nextMarket}&rank=${rank}`);
  };

  const handleRankChange = (nextRank: RankType) => {
    setRank(nextRank);

    navigate(`/search?market=${market}&rank=${nextRank}`);
  };

  const openDetail = (row: StockRow) => {
    const back = encodeURIComponent(`/search?market=${market}&rank=${rank}`);

    navigate(`/stock/${encodeURIComponent(row.ticker)}?back=${back}`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain bg-background">
      <header className="relative z-30 shrink-0 border-b border-card-border bg-background/95 px-4 pb-3 pt-5 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold">주식</h1>

            <p className="mt-1 text-xs font-bold text-muted-foreground">
              키움증권 랭킹과 AI 점수를 함께 확인합니다.
            </p>
          </div>

          <button
            type="button"
            aria-label="새로고침"
            onClick={() => {
              void rankingQuery.refetch();

              if (trimmedQuery) {
                void searchQuery.refetch();
              }
            }}
            className="flex h-10 w-10 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground"
          >
            <RefreshCw
              className={cn(
                "h-4 w-4",

                (rankingQuery.isFetching || searchQuery.isFetching) &&
                  "animate-spin",
              )}
            />
          </button>
        </div>

        <div className="relative mt-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />

          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              market === "KR"
                ? "국내 종목명 또는 종목코드 검색"
                : "미국 종목명 또는 티커 검색"
            }
            className="h-12 w-full rounded-2xl border border-card-border bg-card pl-10 pr-4 text-sm font-bold outline-none placeholder:text-muted-foreground focus:border-primary"
          />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          {MARKET_TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => handleMarketChange(item.key)}
              className={cn(
                "rounded-2xl border px-3 py-2.5 text-sm font-extrabold",

                market === item.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-card-border bg-card text-muted-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { setWatchMarket(market); setWatchlistOpen(true); }}
            className="rounded-2xl border border-card-border bg-card px-2 py-2.5 text-sm font-extrabold text-muted-foreground"
          >
            관심종목
          </button>
        </div>

        {!trimmedQuery && (
          <div className="mt-3 grid grid-cols-3 gap-2">
            {RANK_TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => handleRankChange(item.key)}
                className={cn(
                  "min-w-0 rounded-2xl border px-2 py-2.5 text-[11px] font-extrabold",

                  rank === item.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-card-border bg-card text-muted-foreground",
                )}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </header>

      <main className="flex-none px-4 pb-24 pt-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold">
              {trimmedQuery ? "검색 결과" : rankTitle(rank)}
            </h2>

            <p className="mt-1 text-xs font-bold text-muted-foreground">
              {market === "KR" ? "국내주식" : "해외주식"} · {rows.length}개
            </p>
          </div>

          {!trimmedQuery && (
            <p className="text-[10px] font-bold text-muted-foreground">
              30초마다 갱신
            </p>
          )}
        </div>

        {isLoading && (
          <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="text-sm font-bold text-muted-foreground">
              종목 데이터를 불러오는 중...
            </p>
          </section>
        )}

        {isError && (
          <section className="rounded-3xl border border-destructive/30 bg-card p-8 text-center">
            <p className="break-keep text-sm font-bold text-destructive">
              종목 데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.
            </p>
          </section>
        )}

        {!isLoading && !isError && !rows.length && (
          <section className="rounded-3xl border border-card-border bg-card p-8 text-center">
            <p className="text-sm font-bold text-muted-foreground">
              표시할 종목이 없습니다.
            </p>
          </section>
        )}

        <div className="space-y-3">
          {rows.map((row) => {
            const stockName = displayStockName(
              row.ticker,
              row.name,
              row.market,
            );

            const positive = (row.changePercent ?? 0) >= 0;

            return (
              <button
                key={`${row.market}:${row.ticker}`}
                type="button"
                onClick={() => openDetail(row)}
                className="w-full rounded-3xl border border-card-border bg-card p-4 text-left shadow-sm transition active:scale-[0.99]"
              >
                <div className="grid grid-cols-[36px_minmax(0,1fr)_auto] items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-extrabold text-primary">
                    {row.rank}
                  </div>

                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <p className="truncate text-base font-extrabold">
                        {stockName}
                      </p>

                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-extrabold",

                          stockClassBadgeClass(row.classification),
                        )}
                      >
                        {row.classification}
                      </span>
                    </div>

                    <p className="mt-1 text-[11px] font-bold text-muted-foreground">
                      {row.market === "US" ? `티커 ${row.ticker}` : row.ticker}
                    </p>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="text-sm font-extrabold">
                      {formatAppPrice(row.price, row.currency)}
                    </p>

                    <p
                      className={cn(
                        "mt-1 flex items-center justify-end gap-1 text-xs font-extrabold",

                        positive ? "text-positive" : "text-destructive",
                      )}
                    >
                      {positive ? (
                        <TrendingUp className="h-3.5 w-3.5" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5" />
                      )}

                      {formatAppPercent(row.changePercent)}
                    </p>
                  </div>
                </div>

                <div className="mt-3 rounded-2xl bg-secondary/60 px-3 py-2.5">
                  <p className="break-keep text-[11px] font-bold leading-relaxed text-muted-foreground">
                    {rowDescription(row, rank)}
                  </p>
                </div>

                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div className="rounded-xl bg-secondary/40 px-2 py-2">
                    <p className="text-[9px] font-bold text-muted-foreground">
                      거래량
                    </p>
                    <p className="mt-1 text-xs font-extrabold">
                      {formatLargeNumber(row.volume, row.market)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-secondary/40 px-2 py-2">
                    <p className="text-[9px] font-bold text-muted-foreground">
                      거래대금
                    </p>
                    <p className="mt-1 text-xs font-extrabold">
                      {formatLargeNumber(row.tradingValue, row.market)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-secondary/40 px-2 py-2">
                    <p className="text-[9px] font-bold text-muted-foreground">
                      시총
                    </p>
                    <p className="mt-1 text-xs font-extrabold">
                      {formatLargeNumber(row.marketCap, row.market)}
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </main>

      <BottomNav />

      {watchlistOpen && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-3 sm:items-center">
          <button type="button" aria-label="닫기" className="absolute inset-0" onClick={() => setWatchlistOpen(false)} />
          <section className="relative z-10 flex max-h-[82dvh] w-full max-w-md flex-col overflow-hidden rounded-3xl border border-card-border bg-card p-4 shadow-2xl">
            <div className="flex items-center justify-between gap-3">
              <div><h2 className="text-lg font-extrabold">관심종목</h2><p className="mt-1 text-xs font-bold text-muted-foreground">15초마다 현재가를 갱신합니다.</p></div>
              <button type="button" onClick={() => setWatchlistOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-secondary"><X className="h-4 w-4" /></button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {(["KR", "US"] as Market[]).map((item) => (
                <button key={item} type="button" onClick={() => setWatchMarket(item)} className={cn("rounded-xl border px-3 py-2 text-sm font-extrabold", watchMarket === item ? "border-primary bg-primary text-primary-foreground" : "border-card-border bg-background text-muted-foreground")}>{item === "KR" ? "국내" : "해외"}</button>
              ))}
            </div>
            <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto">
              {(watchlistQuery.data ?? []).filter((row) => row.market === watchMarket).length === 0 ? (
                <p className="rounded-2xl bg-secondary/70 p-5 text-center text-sm font-bold text-muted-foreground">등록된 {watchMarket === "KR" ? "국내" : "해외"} 관심종목이 없습니다.</p>
              ) : (watchlistQuery.data ?? []).filter((row) => row.market === watchMarket).map((row) => (
                <button key={row.ticker} type="button" onClick={() => { setWatchlistOpen(false); openDetail(row); }} className="flex w-full items-center gap-3 rounded-2xl border border-card-border bg-background p-3 text-left">
                  <Star className="h-4 w-4 shrink-0 fill-yellow-400 text-yellow-400" />
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-extrabold">{displayStockName(row.ticker, row.name, row.market)}</p><p className="mt-1 text-[11px] font-bold text-muted-foreground">{row.ticker}</p></div>
                  <div className="shrink-0 text-right"><p className="text-sm font-extrabold">{formatAppPrice(row.price, row.currency)}</p><p className={cn("mt-1 text-xs font-extrabold", (row.changePercent ?? 0) >= 0 ? "text-positive" : "text-destructive")}>{formatAppPercent(row.changePercent)}</p></div>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
