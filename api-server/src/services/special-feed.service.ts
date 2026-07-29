import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { CATALOG, type CatalogEntry } from "../data/catalog";
import { MarketDataService } from "./market-data.service";
import { NewsService } from "./news.service";
import { RiskAnalysisService } from "./risk-analysis.service";
import { SignalService } from "./signal.service";

export type SpecialFeedMarket = "KR" | "US" | "spot" | "futures";
export type SpecialFeedKind = "news" | "disclosure" | "signal";
export type SpecialFeedTone = "positive" | "negative" | "neutral";
export type SpecialFeedMarketState =
  | "OK"
  | "PARTIAL"
  | "NOT_CONFIGURED"
  | "ERROR";

export interface SpecialFeedMarketStatus {
  market: SpecialFeedMarket;
  status: SpecialFeedMarketState;
  source: string;
  resultCount: number;
  durationMs: number;
  updatedAt: string;
  warning: string | null;
  staleUsed: boolean;
}

export interface SpecialFeedItem {
  id: string;
  kind: SpecialFeedKind;
  tone: SpecialFeedTone;
  ticker: string;
  name: string;
  market: SpecialFeedMarket;
  currency: "KRW" | "USD" | "USDT";
  title: string;
  summary: string;
  source: string;
  url: string | null;
  timeframe: string | null;
  price: number | null;
  changePercent: number | null;
  sourceAt: string | null;
  detectedAt: string;
  expiresAt: string;
}

export interface SpecialFeedResponse {
  ok: true;
  market: SpecialFeedMarket;
  items: SpecialFeedItem[];
  count: number;
  catalogSize: number;
  scannedNow: number;
  nextCursor: number;
  updatedAt: string;
  ttlMinutes: 60;
  refreshSeconds: 30;
  note: string;
  marketStatus: SpecialFeedMarketStatus;
}

const FEED_TTL_MS = 60 * 60_000;
const STATIC_SEEN_TTL_MS = 14 * 24 * 60 * 60_000;
const SIGNAL_REPEAT_MS = 60 * 60_000;
const NEWS_MAX_AGE_MS = 3 * 24 * 60 * 60_000;
const DISCLOSURE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_ITEMS_PER_MARKET = 120;
const DEFAULT_BATCH_SIZE = 8;
const SNAPSHOT_VERSION = 2 as const;
const SNAPSHOT_READ_THROTTLE_MS = 1_000;

const feedItems = new Map<string, SpecialFeedItem>();
const staticSeenAt = new Map<string, number>();
const lastSignalAddedAt = new Map<string, number>();
const previousSignals = new Map<string, Set<string>>();
let snapshotSavedAt = 0;
let snapshotReadAt = 0;
let snapshotLoadPromise: Promise<void> | null = null;

interface MarketScanResult {
  source: string;
  resultCount: number;
  scannedNow: number;
  nextCursor: number;
  warning?: string;
}

const marketState: Record<
  SpecialFeedMarket,
  {
    cursor: number;
    lastRefreshAt: number;
    running: Promise<MarketScanResult> | null;
  }
> = {
  KR: { cursor: 0, lastRefreshAt: 0, running: null },
  US: { cursor: 0, lastRefreshAt: 0, running: null },
  spot: { cursor: 0, lastRefreshAt: 0, running: null },
  futures: { cursor: 0, lastRefreshAt: 0, running: null },
};

const MARKET_KEYS: readonly SpecialFeedMarket[] = [
  "KR",
  "US",
  "spot",
  "futures",
];

function initialMarketStatus(
  market: SpecialFeedMarket,
): SpecialFeedMarketStatus {
  return {
    market,
    status: "NOT_CONFIGURED",
    source: "none",
    resultCount: 0,
    durationMs: 0,
    updatedAt: new Date(0).toISOString(),
    warning: "NOT_YET_SCANNED",
    staleUsed: false,
  };
}

const marketStatuses: Record<SpecialFeedMarket, SpecialFeedMarketStatus> = {
  KR: initialMarketStatus("KR"),
  US: initialMarketStatus("US"),
  spot: initialMarketStatus("spot"),
  futures: initialMarketStatus("futures"),
};

interface SpecialFeedSnapshot {
  version: typeof SNAPSHOT_VERSION;
  savedAt: number;
  items: SpecialFeedItem[];
  cursors: Record<SpecialFeedMarket, number>;
  markets: Record<SpecialFeedMarket, SpecialFeedMarketStatus>;
}

function snapshotFilePath(): string {
  const configured = process.env.SPECIAL_FEED_CACHE_FILE?.trim();
  if (configured) return path.resolve(configured);

  const cwd = process.cwd();
  const apiRoot = path.basename(cwd) === "api-server"
    ? cwd
    : path.join(cwd, "api-server");
  return path.join(apiRoot, "data", "worker", "special-feed-v1.json");
}

function validSnapshotItem(value: unknown): value is SpecialFeedItem {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SpecialFeedItem>;
  return Boolean(
    row.id &&
      row.ticker &&
      MARKET_KEYS.includes(row.market as SpecialFeedMarket) &&
      row.detectedAt &&
      row.expiresAt,
  );
}

function validMarketStatus(
  value: unknown,
  market: SpecialFeedMarket,
): value is SpecialFeedMarketStatus {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SpecialFeedMarketStatus>;
  return Boolean(
    row.market === market &&
      ["OK", "PARTIAL", "NOT_CONFIGURED", "ERROR"].includes(
        String(row.status),
      ) &&
      row.source &&
      Number.isFinite(Number(row.resultCount)) &&
      Number.isFinite(Number(row.durationMs)) &&
      row.updatedAt,
  );
}

async function syncSnapshotFromDisk(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - snapshotReadAt < SNAPSHOT_READ_THROTTLE_MS) return;
  if (snapshotLoadPromise) return snapshotLoadPromise;

  snapshotReadAt = now;
  snapshotLoadPromise = (async () => {
    try {
      const parsed = JSON.parse(
        await readFile(snapshotFilePath(), "utf8"),
      ) as Partial<SpecialFeedSnapshot>;
      const savedAt = Number(parsed.savedAt ?? 0);
      if (
        parsed.version !== SNAPSHOT_VERSION ||
        !Number.isFinite(savedAt) ||
        savedAt <= snapshotSavedAt ||
        !Array.isArray(parsed.items)
      ) {
        return;
      }

      feedItems.clear();
      for (const item of parsed.items.filter(validSnapshotItem)) {
        feedItems.set(item.id, item);
      }
      for (const market of MARKET_KEYS) {
        marketState[market].cursor = Math.max(
          0,
          Math.trunc(Number(parsed.cursors?.[market] ?? 0)) || 0,
        );
        const status = parsed.markets?.[market];
        if (validMarketStatus(status, market)) {
          marketStatuses[market] = status;
        }
      }
      snapshotSavedAt = savedAt;
      pruneState();
    } catch {
      // 첫 실행이거나 아직 worker snapshot이 없으면 빈 feed를 유지합니다.
    }
  })().finally(() => {
    snapshotLoadPromise = null;
  });

  return snapshotLoadPromise;
}

async function persistSnapshot(): Promise<void> {
  pruneState();
  const savedAt = Date.now();
  const target = snapshotFilePath();
  const temporary = `${target}.${process.pid}.tmp`;
  const payload: SpecialFeedSnapshot = {
    version: SNAPSHOT_VERSION,
    savedAt,
    items: [...feedItems.values()],
    cursors: {
      KR: marketState.KR.cursor,
      US: marketState.US.cursor,
      spot: marketState.spot.cursor,
      futures: marketState.futures.cursor,
    },
    markets: { ...marketStatuses },
  };

  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, JSON.stringify(payload), "utf8");
  await rename(temporary, target);
  snapshotSavedAt = savedAt;
}

const POSITIVE_WORDS = [
  "공급계약",
  "수주",
  "계약체결",
  "계약 체결",
  "사상최대",
  "사상 최대",
  "최대실적",
  "최대 실적",
  "호실적",
  "흑자전환",
  "흑자 전환",
  "실적개선",
  "실적 개선",
  "배당",
  "자사주",
  "자기주식 취득",
  "임상성공",
  "임상 성공",
  "승인",
  "허가",
  "특허",
  "인수",
  "합병",
  "투자유치",
  "투자 유치",
  "목표가상향",
  "목표가 상향",
  "신고가",
  "급등",
  "강세",
  "record revenue",
  "record profit",
  "beats estimates",
  "beat estimates",
  "raises guidance",
  "raised guidance",
  "upgrade",
  "upgraded",
  "buyback",
  "dividend",
  "approval",
  "approved",
  "fda",
  "contract",
  "partnership",
  "acquisition",
  "patent",
];

const NEGATIVE_WORDS = [
  "유상증자",
  "전환사채",
  "신주인수권",
  "오퍼링",
  "희석",
  "횡령",
  "배임",
  "거래정지",
  "상장폐지",
  "관리종목",
  "실적악화",
  "실적 악화",
  "적자전환",
  "적자 전환",
  "계약해지",
  "계약 해지",
  "임상실패",
  "임상 실패",
  "리콜",
  "소송",
  "제재",
  "과징금",
  "목표가하향",
  "목표가 하향",
  "급락",
  "약세",
  "부도",
  "감사의견",
  "offering",
  "dilution",
  "dilutive",
  "lawsuit",
  "probe",
  "investigation",
  "downgrade",
  "downgraded",
  "misses estimates",
  "missed estimates",
  "recall",
  "bankruptcy",
  "delisting",
  "trading halt",
  "cuts guidance",
  "cut guidance",
  "failed trial",
];

const IMPORTANT_DISCLOSURE_WORDS = [
  ...POSITIVE_WORDS,
  ...NEGATIVE_WORDS,
  "단일판매",
  "주요사항보고서",
  "잠정실적",
  "영업실적",
  "매출액",
  "손익구조",
  "최대주주",
  "주식소각",
  "감자",
  "분할",
  "합병",
  "타법인주식",
  "10-k",
  "10-q",
  "8-k",
  "s-1",
  "s-3",
  "424b",
];

const POSITIVE_SIGNAL_WORDS = [
  "매수",
  "골든크로스",
  "골든 크로스",
  "저항선 돌파",
  "상단 돌파",
  "돌파",
  "반등",
  "상승 전환",
  "추세 전환",
  "거래량 급증",
  "거래량 증가",
  "신고가",
  "과매도 반등",
  "지지선 반등",
];

const NEGATIVE_SIGNAL_WORDS = [
  "매도",
  "데드크로스",
  "데드 크로스",
  "지지선 이탈",
  "하단 이탈",
  "이탈",
  "하락 전환",
  "과열",
  "과매수",
  "급락",
  "신저가",
  "저항 실패",
];

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value: unknown): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/정정|첨부정정|기재정정/g, " ")
    .replace(/[^0-9a-z가-힣]+/g, "")
    .slice(0, 180);
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const result = cleanText(value);
    if (result) return result;
  }
  return "";
}

function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    const url = cleanText(value);
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

function numberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseSourceTime(value: unknown): number | null {
  const raw = cleanText(value);
  if (!raw || raw === "실시간") return null;

  if (/^\d{8}$/.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T00:00:00+09:00`;
    const timestamp = Date.parse(iso);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sourceIso(value: unknown): string | null {
  const timestamp = parseSourceTime(value);
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

function isRecent(value: unknown, maxAgeMs: number): boolean {
  const timestamp = parseSourceTime(value);
  if (timestamp == null) return true;
  return Date.now() - timestamp <= maxAgeMs;
}

function includesAny(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word.toLowerCase()));
}

function classifyTone(value: unknown): SpecialFeedTone {
  const source = cleanText(value);
  const positive = POSITIVE_WORDS.filter((word) =>
    source.toLowerCase().includes(word.toLowerCase()),
  ).length;
  const negative = NEGATIVE_WORDS.filter((word) =>
    source.toLowerCase().includes(word.toLowerCase()),
  ).length;

  if (positive === 0 && negative === 0) return "neutral";
  return positive >= negative ? "positive" : "negative";
}

function classifySignalTone(value: unknown): SpecialFeedTone {
  const source = cleanText(value);
  const positive = POSITIVE_SIGNAL_WORDS.filter((word) =>
    source.toLowerCase().includes(word.toLowerCase()),
  ).length;
  const negative = NEGATIVE_SIGNAL_WORDS.filter((word) =>
    source.toLowerCase().includes(word.toLowerCase()),
  ).length;

  if (positive === 0 && negative === 0) return "neutral";
  return positive >= negative ? "positive" : "negative";
}

function pruneState() {
  const now = Date.now();

  for (const [id, item] of feedItems) {
    if (Date.parse(item.expiresAt) <= now) feedItems.delete(id);
  }

  for (const [key, seenAt] of staticSeenAt) {
    if (now - seenAt > STATIC_SEEN_TTL_MS) staticSeenAt.delete(key);
  }

  for (const [key, addedAt] of lastSignalAddedAt) {
    if (now - addedAt > STATIC_SEEN_TTL_MS) lastSignalAddedAt.delete(key);
  }

  for (const market of ["KR", "US"] as const) {
    const rows = [...feedItems.values()]
      .filter((item) => item.market === market)
      .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt));

    for (const item of rows.slice(MAX_ITEMS_PER_MARKET)) {
      feedItems.delete(item.id);
    }
  }
}

function addStaticItem(
  signature: string,
  input: Omit<SpecialFeedItem, "id" | "detectedAt" | "expiresAt">,
) {
  const now = Date.now();
  if (staticSeenAt.has(signature)) return;

  staticSeenAt.set(signature, now);
  const id = `${input.market}:${input.ticker}:${input.kind}:${normalizeKey(signature)}`;
  feedItems.set(id, {
    ...input,
    id,
    detectedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FEED_TTL_MS).toISOString(),
  });
}

function addSignalItem(
  signature: string,
  input: Omit<SpecialFeedItem, "id" | "detectedAt" | "expiresAt">,
) {
  const now = Date.now();
  const lastAdded = lastSignalAddedAt.get(signature) ?? 0;
  if (now - lastAdded < SIGNAL_REPEAT_MS) return;

  lastSignalAddedAt.set(signature, now);
  const id = `${input.market}:${input.ticker}:signal:${normalizeKey(signature)}:${now}`;
  feedItems.set(id, {
    ...input,
    id,
    detectedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FEED_TTL_MS).toISOString(),
  });
}

function quoteFields(quote: any) {
  return {
    price: numberOrNull(quote?.price),
    changePercent: numberOrNull(quote?.changePercent),
  };
}

function newsRows(data: any): any[] {
  const rows = [
    ...(Array.isArray(data?.positive) ? data.positive : []),
    ...(Array.isArray(data?.negative) ? data.negative : []),
  ];

  const unique = new Map<string, any>();
  for (const row of rows) {
    const key =
      normalizeKey(row?.title) || firstUrl(row?.url) || String(Math.random());
    if (!unique.has(key)) unique.set(key, row);
  }

  return [...unique.values()].sort((a, b) => {
    const aTime = parseSourceTime(a?.publishedAt ?? a?.date) ?? 0;
    const bTime = parseSourceTime(b?.publishedAt ?? b?.date) ?? 0;
    return bTime - aTime;
  });
}

function disclosureRows(data: any): any[] {
  const rows = [
    ...(Array.isArray(data?.filings) ? data.filings : []),
    ...(Array.isArray(data?.disclosures) ? data.disclosures : []),
    ...(Array.isArray(data?.items) ? data.items : []),
  ];

  const unique = new Map<string, any>();
  for (const row of rows) {
    const title = firstText(
      row?.title,
      row?.report,
      row?.report_nm,
      row?.description,
      row?.form,
    );
    const key =
      firstText(row?.rcept_no, row?.accessionNumber) ||
      `${normalizeKey(title)}:${firstText(row?.date, row?.rcept_dt, row?.filingDate)}`;

    if (!unique.has(key)) unique.set(key, row);
  }

  return [...unique.values()].sort((a, b) => {
    const aTime =
      parseSourceTime(
        a?.acceptedAt ?? a?.date ?? a?.rcept_dt ?? a?.filingDate,
      ) ?? 0;
    const bTime =
      parseSourceTime(
        b?.acceptedAt ?? b?.date ?? b?.rcept_dt ?? b?.filingDate,
      ) ?? 0;
    return bTime - aTime;
  });
}

function signalRows(data: any): any[] {
  return Array.isArray(data?.signals) ? data.signals : [];
}

function signalTitle(row: any): string {
  if (typeof row === "string") return cleanText(row);

  return firstText(
    row?.label,
    row?.title,
    row?.name,
    row?.message,
    row?.signal,
    row?.type,
    row?.code,
  );
}

function signalSummary(row: any, title: string): string {
  if (typeof row === "string") return `${title} 신호가 새로 감지되었습니다.`;

  return (
    firstText(row?.reason, row?.description, row?.detail, row?.summary) ||
    `${title} 신호가 새로 감지되었습니다.`
  );
}

async function scanEntry(entry: CatalogEntry): Promise<boolean> {
  const [newsResult, riskResult, signalResult, quoteResult] =
    await Promise.allSettled([
      NewsService.getNews(entry.ticker),
      RiskAnalysisService.getRisk(entry.ticker),
      SignalService.getReport(entry.ticker),
      MarketDataService.getQuote(entry.ticker),
    ]);

  const quote = quoteResult.status === "fulfilled" ? quoteResult.value : null;
  const common = {
    ticker: entry.ticker,
    name: entry.name,
    market: entry.market as SpecialFeedMarket,
    currency: entry.currency,
    ...quoteFields(quote),
  };

  if (newsResult.status === "fulfilled" && newsResult.value) {
    for (const item of newsRows(newsResult.value).slice(0, 6)) {
      const title = firstText(item?.title);
      const sourceDate = item?.publishedAt ?? item?.date;
      if (!title || !isRecent(sourceDate, NEWS_MAX_AGE_MS)) continue;

      const keywordTone = classifyTone(title);
      const suppliedTone =
        item?.tone === "negative"
          ? "negative"
          : item?.tone === "positive"
            ? "positive"
            : "neutral";
      const tone = keywordTone === "neutral" ? suppliedTone : keywordTone;

      // 특별한 단어가 하나도 없는 일반 뉴스는 피드에 올리지 않습니다.
      if (keywordTone === "neutral") continue;

      const signature = `${entry.market}:${entry.ticker}:news:${normalizeKey(title)}:${sourceIso(sourceDate) ?? ""}`;
      addStaticItem(signature, {
        kind: "news",
        tone,
        ...common,
        title,
        summary:
          firstText(item?.summary, item?.description) ||
          `${tone === "positive" ? "호재" : "악재"} 가능성이 있는 중요 뉴스입니다.`,
        source: firstText(item?.source, item?.sourceDomain) || "뉴스",
        url: firstUrl(item?.url, item?.link),
        timeframe: null,
        sourceAt: sourceIso(sourceDate),
      });
    }
  }

  if (riskResult.status === "fulfilled" && riskResult.value) {
    for (const item of disclosureRows(riskResult.value).slice(0, 8)) {
      const title = firstText(
        item?.title,
        item?.report,
        item?.report_nm,
        item?.description,
        item?.form,
      );
      const sourceDate =
        item?.acceptedAt ?? item?.date ?? item?.rcept_dt ?? item?.filingDate;
      const eventText = [
        ...(Array.isArray(item?.events) ? item.events : []),
        ...(Array.isArray(item?.eventLabels) ? item.eventLabels : []),
      ].join(" ");
      const fullText = `${title} ${eventText}`;

      if (
        !title ||
        !isRecent(sourceDate, DISCLOSURE_MAX_AGE_MS) ||
        !includesAny(fullText, IMPORTANT_DISCLOSURE_WORDS)
      ) {
        continue;
      }

      const tone = classifyTone(fullText);
      const signature = `${entry.market}:${entry.ticker}:disclosure:${normalizeKey(title)}:${sourceIso(sourceDate) ?? ""}`;

      addStaticItem(signature, {
        kind: "disclosure",
        tone,
        ...common,
        title,
        summary:
          firstText(item?.summary, item?.description) ||
          "투자 판단에 영향을 줄 수 있는 중요 공시가 등록되었습니다.",
        source:
          firstText(item?.source) ||
          (entry.market === "KR" ? "DART" : "SEC EDGAR"),
        url: firstUrl(item?.url, item?.link),
        timeframe: null,
        sourceAt: sourceIso(sourceDate),
      });
    }
  }

  const signalKey = `${entry.market}:${entry.ticker}`;
  const before = previousSignals.get(signalKey) ?? new Set<string>();
  const current = new Set<string>();

  if (signalResult.status === "fulfilled" && signalResult.value) {
    for (const row of signalRows(signalResult.value)) {
      const title = signalTitle(row);
      const tone = classifySignalTone(title);
      if (!title || tone === "neutral") continue;

      const timeframe = firstText(row?.timeframe, row?.interval) || "일봉";
      const signature = `${signalKey}:signal:${normalizeKey(title)}:${normalizeKey(timeframe)}`;
      current.add(signature);

      if (!before.has(signature)) {
        addSignalItem(signature, {
          kind: "signal",
          tone,
          ...common,
          title,
          summary: signalSummary(row, title),
          source: "차트 분석",
          url: null,
          timeframe,
          sourceAt: new Date().toISOString(),
        });
      }
    }
  }

  previousSignals.set(signalKey, current);
  return [newsResult, riskResult, signalResult, quoteResult].some(
    (result) => result.status === "fulfilled",
  );
}

function batchSize() {
  const configured = Number(process.env.SPECIAL_FEED_BATCH_SIZE);
  if (!Number.isFinite(configured)) return DEFAULT_BATCH_SIZE;
  return Math.max(2, Math.min(20, Math.trunc(configured)));
}

async function scanStockMarket(
  market: "KR" | "US",
): Promise<MarketScanResult> {
  const state = marketState[market];
  const universe = CATALOG.filter((entry) => entry.market === market);

  if (universe.length === 0) {
    return {
      source: "catalog",
      resultCount: 0,
      scannedNow: 0,
      nextCursor: 0,
      warning: "EMPTY_MARKET_UNIVERSE",
    };
  }

  const size = Math.min(batchSize(), universe.length);
  const batch = Array.from(
    { length: size },
    (_, index) => universe[(state.cursor + index) % universe.length],
  );

  // 공급자 부하를 줄이기 위해 한 번에 4종목씩 처리합니다.
  let succeeded = 0;
  let failed = 0;
  for (let index = 0; index < batch.length; index += 4) {
    const chunk = batch.slice(index, index + 4);
    const rows = await Promise.allSettled(
      chunk.map((entry) => scanEntry(entry)),
    );
    succeeded += rows.filter(
      (row) => row.status === "fulfilled" && row.value,
    ).length;
    failed += rows.length - rows.filter(
      (row) => row.status === "fulfilled" && row.value,
    ).length;
  }

  state.cursor = (state.cursor + batch.length) % universe.length;
  if (succeeded === 0 && batch.length > 0) {
    const error = new Error(`${market}_MARKET_SCAN_FAILED`);
    error.name = "MARKET_SCAN_FAILED";
    throw error;
  }
  return {
    source: market === "KR" ? "stock-providers-kr" : "stock-providers-us",
    resultCount: succeeded,
    scannedNow: batch.length,
    nextCursor: state.cursor,
    ...(failed > 0 ? { warning: `ENTRY_PARTIAL_FAILURE:${failed}` } : {}),
  };
}

class SignalMarketError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SignalMarketError";
  }
}

function cryptoProvider(market: "spot" | "futures"): string {
  const variable =
    market === "spot"
      ? process.env.SIGNAL_SPOT_PROVIDER
      : process.env.SIGNAL_FUTURES_PROVIDER;
  return String(variable ?? "").trim().toLowerCase();
}

function signalProviderTimeoutMs(): number {
  const value = Number(process.env.SIGNAL_PROVIDER_TIMEOUT_MS);
  if (!Number.isFinite(value)) return 12_000;
  return Math.max(1_000, Math.min(30_000, Math.trunc(value)));
}

async function fetchSignalJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    signalProviderTimeoutMs(),
  );
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "stock-signal-worker/1.0",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new SignalMarketError(`HTTP_${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SignalMarketError) throw error;
    const code =
      error && typeof error === "object" && "name" in error
        ? String(error.name)
        : "PROVIDER_ERROR";
    throw new SignalMarketError(
      code === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function scanSpotMarket(): Promise<MarketScanResult> {
  if (cryptoProvider("spot") !== "upbit") {
    throw new SignalMarketError("SPOT_PROVIDER_NOT_CONFIGURED");
  }

  const state = marketState.spot;
  const markets = await fetchSignalJson<Array<{ market?: unknown }>>(
    "https://api.upbit.com/v1/market/all?isDetails=false",
  );
  const universe = markets
    .map((row) => String(row.market ?? ""))
    .filter((market) => market.startsWith("KRW-"));
  if (universe.length === 0) {
    throw new SignalMarketError("SPOT_EMPTY_MARKET_UNIVERSE");
  }

  const size = Math.min(batchSize(), universe.length);
  const batch = Array.from(
    { length: size },
    (_, index) => universe[(state.cursor + index) % universe.length],
  );
  const tickers = await fetchSignalJson<
    Array<{ market?: unknown; trade_price?: unknown }>
  >(
    `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(batch.join(","))}`,
  );
  const resultCount = tickers.filter((row) => {
    const price = Number(row.trade_price);
    return String(row.market ?? "").startsWith("KRW-") &&
      Number.isFinite(price) &&
      price > 0;
  }).length;
  if (resultCount === 0) {
    throw new SignalMarketError("SPOT_TICKERS_UNAVAILABLE");
  }

  state.cursor = (state.cursor + batch.length) % universe.length;
  return {
    source: "upbit-public",
    resultCount,
    scannedNow: batch.length,
    nextCursor: state.cursor,
    ...(resultCount < batch.length
      ? { warning: `ENTRY_PARTIAL_FAILURE:${batch.length - resultCount}` }
      : {}),
  };
}

async function scanFuturesMarket(): Promise<MarketScanResult> {
  if (cryptoProvider("futures") !== "bitget") {
    throw new SignalMarketError("FUTURES_PROVIDER_NOT_CONFIGURED");
  }

  const state = marketState.futures;
  const payload = await fetchSignalJson<{
    code?: unknown;
    data?: Array<{
      symbol?: unknown;
      lastPr?: unknown;
      markPrice?: unknown;
    }>;
  }>(
    "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES",
  );
  if (String(payload.code ?? "") !== "00000" || !Array.isArray(payload.data)) {
    throw new SignalMarketError(
      `BITGET_${String(payload.code ?? "INVALID_RESPONSE")}`,
    );
  }

  const universe = payload.data.filter((row) =>
    String(row.symbol ?? "").endsWith("USDT"),
  );
  if (universe.length === 0) {
    throw new SignalMarketError("FUTURES_EMPTY_MARKET_UNIVERSE");
  }

  const size = Math.min(batchSize(), universe.length);
  const batch = Array.from(
    { length: size },
    (_, index) => universe[(state.cursor + index) % universe.length],
  );
  const resultCount = batch.filter((row) => {
    const price = Number(row.markPrice ?? row.lastPr);
    return Number.isFinite(price) && price > 0;
  }).length;
  if (resultCount === 0) {
    throw new SignalMarketError("FUTURES_TICKERS_UNAVAILABLE");
  }

  state.cursor = (state.cursor + batch.length) % universe.length;
  return {
    source: "bitget-public",
    resultCount,
    scannedNow: batch.length,
    nextCursor: state.cursor,
    ...(resultCount < batch.length
      ? { warning: `ENTRY_PARTIAL_FAILURE:${batch.length - resultCount}` }
      : {}),
  };
}

async function scanConfiguredMarket(
  market: SpecialFeedMarket,
): Promise<MarketScanResult> {
  const forcedFailures = new Set(
    String(process.env.SIGNAL_CANARY_FAIL_MARKETS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (
    process.env.API_CANARY === "true" &&
    forcedFailures.has(market)
  ) {
    throw new SignalMarketError(`${market.toUpperCase()}_PROVIDER_TIMEOUT`);
  }

  if (market === "KR" || market === "US") {
    return scanStockMarket(market);
  }
  return market === "spot" ? scanSpotMarket() : scanFuturesMarket();
}

async function refreshMarket(
  market: SpecialFeedMarket,
): Promise<MarketScanResult> {
  const state = marketState[market];
  const now = Date.now();

  if (state.running) return state.running;
  if (now - state.lastRefreshAt < 20_000) {
    const previous = marketStatuses[market];
    return {
      source: previous.source,
      resultCount: previous.resultCount,
      scannedNow: 0,
      nextCursor: state.cursor,
      warning: "REFRESH_THROTTLED",
    };
  }

  state.running = (async () => {
    try {
      pruneState();
      const result = await scanConfiguredMarket(market);
      state.lastRefreshAt = Date.now();
      pruneState();
      return result;
    } finally {
      state.running = null;
    }
  })();

  return state.running;
}

async function getFeed(
  market: SpecialFeedMarket,
  limit = 80,
): Promise<SpecialFeedResponse> {
  await syncSnapshotFromDisk();
  pruneState();

  const items = [...feedItems.values()]
    .filter((item) => item.market === market)
    .filter((item) => Date.parse(item.expiresAt) > Date.now())
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))
    .slice(0, Math.max(1, Math.min(120, Math.trunc(limit) || 80)));

  return {
    ok: true,
    market,
    items,
    count: items.length,
    catalogSize:
      market === "KR" || market === "US"
        ? CATALOG.filter((entry) => entry.market === market).length
        : marketStatuses[market].resultCount,
    scannedNow: 0,
    nextCursor: marketState[market].cursor,
    updatedAt: new Date(snapshotSavedAt || Date.now()).toISOString(),
    ttlMinutes: 60,
    refreshSeconds: 30,
    marketStatus: marketStatuses[market],
    note: snapshotSavedAt
      ? "signal worker가 순환 확인한 새 중요 뉴스·공시·차트신호를 표시합니다."
      : "signal worker snapshot을 기다리고 있습니다.",
  };
}

function marketErrorCode(error: unknown): string {
  if (error instanceof SignalMarketError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.name : "UNKNOWN_ERROR";
}

async function runMarketScan(
  market: SpecialFeedMarket,
): Promise<SpecialFeedMarketStatus> {
  const startedAt = Date.now();
  const previous = marketStatuses[market];
  try {
    const result = await refreshMarket(market);
    return {
      market,
      status: result.warning ? "PARTIAL" : "OK",
      source: result.source,
      resultCount: result.resultCount,
      durationMs: Date.now() - startedAt,
      updatedAt: new Date().toISOString(),
      warning: result.warning ?? null,
      staleUsed: false,
    };
  } catch (error) {
    const warning = marketErrorCode(error);
    const notConfigured = warning.endsWith("_PROVIDER_NOT_CONFIGURED");
    const hasLastGood =
      previous.resultCount > 0 &&
      previous.source !== "none" &&
      Date.parse(previous.updatedAt) > 0;
    return {
      market,
      status: notConfigured
        ? "NOT_CONFIGURED"
        : hasLastGood
          ? "PARTIAL"
          : "ERROR",
      source: hasLastGood ? previous.source : "none",
      resultCount: hasLastGood ? previous.resultCount : 0,
      durationMs: Date.now() - startedAt,
      updatedAt: hasLastGood ? previous.updatedAt : new Date().toISOString(),
      warning,
      staleUsed: hasLastGood,
    };
  }
}

async function runWorkerScanOnce(): Promise<{
  markets: Record<SpecialFeedMarket, SpecialFeedMarketStatus>;
  KR: SpecialFeedMarketStatus;
  US: SpecialFeedMarketStatus;
  spot: SpecialFeedMarketStatus;
  futures: SpecialFeedMarketStatus;
  itemCount: number;
  savedAt: string;
}> {
  await syncSnapshotFromDisk(true);
  const settled = await Promise.allSettled(MARKET_KEYS.map(runMarketScan));
  settled.forEach((row, index) => {
    const market = MARKET_KEYS[index];
    marketStatuses[market] =
      row.status === "fulfilled"
        ? row.value
        : {
            market,
            status: "ERROR",
            source: marketStatuses[market].source,
            resultCount: marketStatuses[market].resultCount,
            durationMs: 0,
            updatedAt: marketStatuses[market].updatedAt,
            warning: marketErrorCode(row.reason),
            staleUsed: marketStatuses[market].resultCount > 0,
          };
  });
  await persistSnapshot();
  return {
    markets: { ...marketStatuses },
    KR: marketStatuses.KR,
    US: marketStatuses.US,
    spot: marketStatuses.spot,
    futures: marketStatuses.futures,
    itemCount: feedItems.size,
    savedAt: new Date(snapshotSavedAt).toISOString(),
  };
}

export const SpecialFeedService = {
  getFeed,
  runWorkerScanOnce,
};
