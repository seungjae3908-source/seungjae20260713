import type { ScannerSignalCard } from './scanner-signal.types';
import type { TradingAccountMode, TradingExchange, TradingPlanInput } from './trade-automation.types';

export type MarketIntelligenceMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type MarketIntelligenceStatus = 'READY' | 'NOT_AVAILABLE';
export type MarketIntelligenceAutoMode = 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE' | 'NOT_AVAILABLE';
export type MarketIntelligenceNewsDisclosureAiMode = 'NO_AI' | 'CHEAP_AI' | 'DEEP_AI' | 'MULTI_EVIDENCE';
export type MarketIntelligenceNewsDisclosureEvidenceStatus = 'READY' | 'PARTIAL_EVIDENCE' | 'CONFLICTING_EVIDENCE' | 'NO_EVIDENCE' | 'INVALID_EVIDENCE';

export type MarketIntelligenceSummary = {
  status: MarketIntelligenceStatus;
  market: MarketIntelligenceMarket;
  symbol: string;
  serviceSha: string | null;
  reason: string | null;
  scanner: {
    mode: 'SOFT_INTELLIGENCE_LAYER';
    adjustment: number | null;
    intelligenceScore: number | null;
    bullishScore: number | null;
    bearishScore: number | null;
    hardBlockReason: string | null;
    candidateDeletionAllowed: false;
  };
  autoTrading: {
    mode: MarketIntelligenceAutoMode;
    orderAllowed: false;
    evidenceReady: boolean;
    parentEligibilityReady: boolean;
    hardBlockReason: string | null;
  };
  warnings: string[];
};

export type MarketIntelligenceFetchOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type MarketIntelligenceNewsDisclosureRouteInput = {
  event: {
    sourceId?: string | null;
    sourceType?: string | null;
    sourceTier?: string | null;
    sourceUrl?: string | null;
    sourceName?: string | null;
    market?: MarketIntelligenceMarket | null;
    symbol?: string | null;
    companyName?: string | null;
    publishedAt?: string | null;
    receivedAt?: string | null;
    headline?: string | null;
    originalText?: string | null;
    eventType?: string | null;
    direction?: string | null;
    importanceScore?: number | null;
    confidenceScore?: number | null;
    noveltyScore?: number | null;
    evidence?: {
      facts?: string[];
      inferences?: string[];
      uncertainty?: string[];
    };
  };
  context?: Record<string, boolean | number | string | null | undefined>;
  nowMs?: number;
  freshnessPolicyMs?: {
    futureToleranceMs: number;
    freshMs: number;
    agingMs: number;
    staleMs: number;
  };
  promptVersion?: string;
  analysisScope?: 'CORE' | 'SCANNER' | 'CHART' | 'PORTFOLIO' | 'ASSISTANT' | 'BACKTEST' | 'SHADOW' | 'PAPER';
  seenRawHashes?: string[];
  cachedAnalysisKeys?: string[];
  clusterEvents?: MarketIntelligenceNewsDisclosureRouteInput['event'][];
};

export type MarketIntelligenceNewsDisclosureRoute = {
  contract: 'MarketIntelAiRouteV1';
  serviceSha: string | null;
  status: MarketIntelligenceNewsDisclosureEvidenceStatus;
  event: {
    rawHash: string;
    sourceId: string | null;
    sourceType: string;
    sourceTier: string;
    sourceUrl: string | null;
    sourceName: string | null;
    market: MarketIntelligenceMarket | null;
    symbol: string | null;
    companyName: string | null;
    publishedAt: string | null;
    receivedAt: string | null;
    headline: string | null;
    originalText: string | null;
    eventType: string;
    evidence: { facts: string[]; inferences: string[]; uncertainty: string[] };
  };
  freshness: { state: 'FRESH' | 'AGING' | 'STALE' | 'EXPIRED' | 'UNKNOWN'; ageMs: number | null; reason: string | null };
  ai: {
    level: number;
    mode: MarketIntelligenceNewsDisclosureAiMode;
    modelTier: 'NONE' | 'CHEAP' | 'DEEP';
    realtimeClass: 'NONE' | 'REALTIME' | 'BATCH';
    analysisKey: string;
    cacheEligible: boolean;
    cacheReuse: boolean;
    batchEligible: boolean;
    maxOutputClass: string;
  };
  reasons: string[];
  safety: {
    executionAuthority: 'NONE';
    orderAllowed: false;
    candidateDeletionAllowed: false;
    sentimentIsPriceDirection: false;
    fabricatedEvidenceAllowed: false;
  };
};

export type MarketIntelligenceTradeDecision = {
  allowed: boolean;
  blockCode: string | null;
  warnings: string[];
  intelligence: MarketIntelligenceSummary;
};

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_BASE_URL = 'http://127.0.0.1:8791';
const DEFAULT_TIMEOUT_MS = 1_500;

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function normalizeBaseUrl(value: string | undefined) {
  const url = new URL(String(value ?? process.env.MARKET_INTELLIGENCE_BASE_URL ?? DEFAULT_BASE_URL).trim());
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error('MARKET_INTELLIGENCE_LOOPBACK_ONLY');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('MARKET_INTELLIGENCE_PROTOCOL_INVALID');
  return url.origin;
}

function normalizeSymbol(value: unknown) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40);
}

function notAvailable(market: MarketIntelligenceMarket, symbol: string, reason: string): MarketIntelligenceSummary {
  return {
    status: 'NOT_AVAILABLE',
    market,
    symbol,
    serviceSha: null,
    reason,
    scanner: {
      mode: 'SOFT_INTELLIGENCE_LAYER',
      adjustment: null,
      intelligenceScore: null,
      bullishScore: null,
      bearishScore: null,
      hardBlockReason: null,
      candidateDeletionAllowed: false,
    },
    autoTrading: {
      mode: 'NOT_AVAILABLE',
      orderAllowed: false,
      evidenceReady: false,
      parentEligibilityReady: false,
      hardBlockReason: null,
    },
    warnings: [reason],
  };
}

function endpoint(market: MarketIntelligenceMarket, symbol: string, baseUrl: string) {
  if (market === 'CRYPTO_SPOT') return `${baseUrl}/v1/public/crypto/spot/${encodeURIComponent(symbol)}`;
  if (market === 'CRYPTO_FUTURES') return `${baseUrl}/v1/public/crypto/futures/${encodeURIComponent(symbol)}`;
  return null;
}

function parsePayload(payload: unknown, market: MarketIntelligenceMarket, symbol: string): MarketIntelligenceSummary {
  const envelope = asObject(payload);
  if (envelope.ok !== true) throw new Error('MARKET_INTELLIGENCE_RESPONSE_NOT_OK');
  const result = asObject(envelope.result);
  const scanner = asObject(result.scanner);
  const autoTrading = asObject(result.autoTrading);
  const safety = asObject(result.safety);
  if (scanner.mode !== 'SOFT_INTELLIGENCE_LAYER') throw new Error('MARKET_INTELLIGENCE_UNSAFE_SCANNER_MODE');
  if (autoTrading.orderAllowed !== false || safety.orderSubmissionAllowed !== false || safety.realOrderAllowed !== false) {
    throw new Error('MARKET_INTELLIGENCE_UNSAFE_ORDER_AUTHORITY');
  }
  const mode = String(autoTrading.mode ?? 'PAPER_ONLY').toUpperCase();
  if (!['PAPER_ONLY', 'BLOCKED_RISK', 'ELIGIBLE_FOR_PARENT_GATE'].includes(mode)) {
    throw new Error('MARKET_INTELLIGENCE_AUTO_MODE_INVALID');
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings.map(String).filter(Boolean).slice(0, 32) : [];
  return {
    status: 'READY',
    market,
    symbol,
    serviceSha: text(envelope.serviceSha),
    reason: null,
    scanner: {
      mode: 'SOFT_INTELLIGENCE_LAYER',
      adjustment: finite(scanner.adjustment),
      intelligenceScore: finite(scanner.intelligenceScore),
      bullishScore: finite(scanner.bullishScore),
      bearishScore: finite(scanner.bearishScore),
      hardBlockReason: text(scanner.hardBlockReason),
      candidateDeletionAllowed: false,
    },
    autoTrading: {
      mode: mode as Exclude<MarketIntelligenceAutoMode, 'NOT_AVAILABLE'>,
      orderAllowed: false,
      evidenceReady: bool(autoTrading.evidenceReady),
      parentEligibilityReady: bool(autoTrading.parentEligibilityReady),
      hardBlockReason: text(autoTrading.hardBlockReason),
    },
    warnings,
  };
}

function stringArray(value: unknown, max = 48): string[] {
  return Array.isArray(value) ? value.map(String).map((entry) => entry.trim()).filter(Boolean).slice(0, max) : [];
}

function parseNewsDisclosureRoute(payload: unknown): MarketIntelligenceNewsDisclosureRoute {
  const envelope = asObject(payload);
  if (envelope.ok !== true) throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_NOT_OK');
  const result = asObject(envelope.result);
  if (result.contract !== 'MarketIntelAiRouteV1') throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_CONTRACT_INVALID');
  const status = String(result.status ?? '') as MarketIntelligenceNewsDisclosureEvidenceStatus;
  if (!['READY', 'PARTIAL_EVIDENCE', 'CONFLICTING_EVIDENCE', 'NO_EVIDENCE', 'INVALID_EVIDENCE'].includes(status)) {
    throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_STATUS_INVALID');
  }
  const event = asObject(result.event);
  const ai = asObject(result.ai);
  const freshness = asObject(result.freshness);
  const routeSafety = asObject(result.safety);
  const envelopeSafety = asObject(envelope.safety);
  if (
    routeSafety.executionAuthority !== 'NONE'
    || routeSafety.orderAllowed !== false
    || routeSafety.candidateDeletionAllowed !== false
    || routeSafety.fabricatedEvidenceAllowed !== false
    || envelopeSafety.realOrderAllowed !== false
    || envelopeSafety.orderSubmissionAllowed !== false
    || envelopeSafety.privateTradingApiAllowed !== false
  ) {
    throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_UNSAFE_AUTHORITY');
  }
  const mode = String(ai.mode ?? '') as MarketIntelligenceNewsDisclosureAiMode;
  if (!['NO_AI', 'CHEAP_AI', 'DEEP_AI', 'MULTI_EVIDENCE'].includes(mode)) throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_MODE_INVALID');
  const analysisKey = String(ai.analysisKey ?? '');
  const rawHash = String(event.rawHash ?? '');
  if (!/^[a-f0-9]{64}$/i.test(analysisKey) || !/^[a-f0-9]{64}$/i.test(rawHash)) {
    throw new Error('MARKET_INTELLIGENCE_NEWS_ROUTE_IDENTITY_INVALID');
  }
  const eventEvidence = asObject(event.evidence);
  const market = text(event.market);
  const allowedMarkets: MarketIntelligenceMarket[] = ['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES'];
  return {
    contract: 'MarketIntelAiRouteV1',
    serviceSha: text(envelope.serviceSha),
    status,
    event: {
      rawHash,
      sourceId: text(event.sourceId),
      sourceType: String(event.sourceType ?? 'UNKNOWN'),
      sourceTier: String(event.sourceTier ?? 'UNKNOWN'),
      sourceUrl: text(event.sourceUrl),
      sourceName: text(event.sourceName),
      market: allowedMarkets.includes(market as MarketIntelligenceMarket) ? market as MarketIntelligenceMarket : null,
      symbol: text(event.symbol),
      companyName: text(event.companyName),
      publishedAt: text(event.publishedAt),
      receivedAt: text(event.receivedAt),
      headline: text(event.headline),
      originalText: text(event.originalText),
      eventType: String(event.eventType ?? 'UNKNOWN'),
      evidence: {
        facts: stringArray(eventEvidence.facts, 32),
        inferences: stringArray(eventEvidence.inferences, 24),
        uncertainty: stringArray(eventEvidence.uncertainty, 24),
      },
    },
    freshness: {
      state: String(freshness.state ?? 'UNKNOWN') as MarketIntelligenceNewsDisclosureRoute['freshness']['state'],
      ageMs: finite(freshness.ageMs),
      reason: text(freshness.reason),
    },
    ai: {
      level: finite(ai.level) ?? 0,
      mode,
      modelTier: String(ai.modelTier ?? 'NONE') as MarketIntelligenceNewsDisclosureRoute['ai']['modelTier'],
      realtimeClass: String(ai.realtimeClass ?? 'NONE') as MarketIntelligenceNewsDisclosureRoute['ai']['realtimeClass'],
      analysisKey,
      cacheEligible: bool(ai.cacheEligible),
      cacheReuse: bool(ai.cacheReuse),
      batchEligible: bool(ai.batchEligible),
      maxOutputClass: String(ai.maxOutputClass ?? 'NONE'),
    },
    reasons: stringArray(result.reasons),
    safety: {
      executionAuthority: 'NONE',
      orderAllowed: false,
      candidateDeletionAllowed: false,
      sentimentIsPriceDirection: false,
      fabricatedEvidenceAllowed: false,
    },
  };
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: MarketIntelligenceFetchOptions,
  fallbackTimeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('MARKET_INTELLIGENCE_FETCH_UNAVAILABLE');
  const timeoutMs = Math.max(250, Math.min(5_000, Number(options.timeoutMs ?? fallbackTimeoutMs)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MARKET_INTELLIGENCE_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`MARKET_INTELLIGENCE_HTTP_${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function scannerMarket(card: Pick<ScannerSignalCard, 'assetClass' | 'market'>): MarketIntelligenceMarket {
  if (card.assetClass === 'coin_spot') return 'CRYPTO_SPOT';
  if (card.assetClass === 'coin_futures') return 'CRYPTO_FUTURES';
  return String(card.market ?? '').toUpperCase().includes('US') ? 'US_STOCK' : 'KR_STOCK';
}

export function tradingMarket(input: Pick<TradingPlanInput, 'exchange' | 'market'>): MarketIntelligenceMarket {
  if (input.exchange === 'bitget') return 'CRYPTO_FUTURES';
  if (input.exchange === 'upbit') return 'CRYPTO_SPOT';
  return String(input.market ?? '').toUpperCase().includes('US') ? 'US_STOCK' : 'KR_STOCK';
}

export function marketIntelligenceNotAvailable(
  market: MarketIntelligenceMarket,
  symbol: string,
  reason = 'MARKET_INTELLIGENCE_EVIDENCE_NOT_CONNECTED',
) {
  return notAvailable(market, normalizeSymbol(symbol), reason);
}

export async function routeNewsDisclosureMarketIntelligence(
  input: MarketIntelligenceNewsDisclosureRouteInput,
  options: MarketIntelligenceFetchOptions = {},
): Promise<MarketIntelligenceNewsDisclosureRoute> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const payload = await requestJson(`${baseUrl}/v1/news-disclosure/route`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, options);
  return parseNewsDisclosureRoute(payload);
}

export async function fetchMarketIntelligence(
  market: MarketIntelligenceMarket,
  rawSymbol: string,
  options: MarketIntelligenceFetchOptions = {},
): Promise<MarketIntelligenceSummary> {
  const symbol = normalizeSymbol(rawSymbol);
  if (!symbol) return notAvailable(market, symbol, 'MARKET_INTELLIGENCE_SYMBOL_REQUIRED');
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const path = endpoint(market, symbol, baseUrl);
  if (!path) return notAvailable(market, symbol, 'PUBLIC_STOCK_INTELLIGENCE_EVIDENCE_NOT_CONNECTED');
  try {
    return parsePayload(await requestJson(path, { headers: { accept: 'application/json' } }, options), market, symbol);
  } catch (error) {
    return notAvailable(market, symbol, error instanceof Error ? error.message : 'MARKET_INTELLIGENCE_UNAVAILABLE');
  }
}

export function scannerDirectionalAdjustment(card: Pick<ScannerSignalCard, 'direction'>, intelligence: MarketIntelligenceSummary) {
  const adjustment = intelligence.scanner.adjustment ?? 0;
  if (card.direction === 'SHORT') return -adjustment;
  if (card.direction === 'LONG') return adjustment;
  return 0;
}

export function marketIntelligenceTradeDecision(
  intelligence: MarketIntelligenceSummary,
  accountMode: TradingAccountMode,
): MarketIntelligenceTradeDecision {
  const warnings = [...intelligence.warnings];
  if (intelligence.status !== 'READY') {
    if (accountMode === 'live') {
      return { allowed: false, blockCode: 'MARKET_INTELLIGENCE_NOT_AVAILABLE', warnings, intelligence };
    }
    warnings.push('MARKET_INTELLIGENCE_FAIL_SOFT_NON_LIVE');
    return { allowed: true, blockCode: null, warnings, intelligence };
  }
  if (intelligence.autoTrading.mode === 'BLOCKED_RISK') {
    return { allowed: false, blockCode: intelligence.autoTrading.hardBlockReason ?? 'MARKET_INTELLIGENCE_BLOCKED_RISK', warnings, intelligence };
  }
  if (accountMode === 'live' && intelligence.autoTrading.mode !== 'ELIGIBLE_FOR_PARENT_GATE') {
    return { allowed: false, blockCode: 'MARKET_INTELLIGENCE_FORWARD_EVIDENCE_REQUIRED', warnings, intelligence };
  }
  if (intelligence.autoTrading.mode === 'PAPER_ONLY') warnings.push('MARKET_INTELLIGENCE_PAPER_ONLY');
  return { allowed: true, blockCode: null, warnings, intelligence };
}

export async function fetchTradingPlanMarketIntelligence(
  input: Pick<TradingPlanInput, 'exchange' | 'market' | 'symbol'>,
  options: MarketIntelligenceFetchOptions = {},
) {
  return fetchMarketIntelligence(tradingMarket(input), input.symbol, options);
}

export async function fetchScannerCardMarketIntelligence(
  card: Pick<ScannerSignalCard, 'assetClass' | 'market' | 'symbol'>,
  options: MarketIntelligenceFetchOptions = {},
) {
  return fetchMarketIntelligence(scannerMarket(card), card.symbol, options);
}

export function exchangeSupportsMarketIntelligence(exchange: TradingExchange) {
  return exchange === 'bitget' || exchange === 'upbit';
}
