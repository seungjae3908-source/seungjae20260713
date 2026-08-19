import type { ScannerSignalCard } from './scanner-signal.types';
import type { TradingAccountMode, TradingExchange, TradingPlanInput } from './trade-automation.types';

export type MarketIntelligenceMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type MarketIntelligenceStatus = 'READY' | 'NOT_AVAILABLE';
export type MarketIntelligenceAutoMode = 'PAPER_ONLY' | 'BLOCKED_RISK' | 'ELIGIBLE_FOR_PARENT_GATE' | 'NOT_AVAILABLE';

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
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return notAvailable(market, symbol, 'MARKET_INTELLIGENCE_FETCH_UNAVAILABLE');
  const timeoutMs = Math.max(250, Math.min(5_000, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('MARKET_INTELLIGENCE_TIMEOUT')), timeoutMs);
  try {
    const response = await fetchImpl(path, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`MARKET_INTELLIGENCE_HTTP_${response.status}`);
    return parsePayload(await response.json(), market, symbol);
  } catch (error) {
    return notAvailable(market, symbol, error instanceof Error ? error.message : 'MARKET_INTELLIGENCE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
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
