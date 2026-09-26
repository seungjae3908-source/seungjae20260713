import { authorizedFetch } from '@/lib/auth-fetch';
import { buildSignalScannerRequestUrl } from './signal-scanner-url';

export type ScannerAssetClass = 'stock' | 'coin_spot' | 'coin_futures';
export type ScannerDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
export type ScannerTradeAction = 'BUY' | 'SELL' | 'LONG' | 'SHORT' | 'NO_TRADE' | 'UNKNOWN' | 'NONE';
export type ScannerStrategyMode = 'scalping' | 'swing' | 'position';
export type ScannerSignalGrade = 'S' | 'A' | 'B' | 'C' | 'D';
export type ScannerSignalState =
  | 'CANDIDATE' | 'CONFIRMED' | 'ARMED' | 'ENTRY_ZONE' | 'APPROVAL_PENDING' | 'APPROVED'
  | 'EXECUTING' | 'PARTIALLY_FILLED' | 'FILLED' | 'MANAGING' | 'CLOSED' | 'INVALIDATED'
  | 'EXPIRED' | 'REJECTED' | 'CANCELLED' | 'DETECTED' | 'WATCHING' | 'READY_FOR_APPROVAL' | 'WEAKENED';
export type ScannerDataState = 'complete' | 'partial' | 'stale' | 'insufficient' | 'unavailable' | 'untrusted';
export type ScannerOutcomeCode =
  | 'CANDIDATES_AVAILABLE'
  | 'VALID_ZERO_SIGNAL'
  | 'UNIVERSE_EMPTY'
  | 'PROVIDER_FAILURE'
  | 'SYMBOL_MAPPING_FAILURE'
  | 'REQUEST_TIMEOUT'
  | 'DATA_QUALITY_REJECT'
  | 'FILTER_TOO_STRICT'
  | 'FRONTEND_RENDER_FAILURE';

export interface ScannerEvidence {
  key: string;
  label: string;
  status: 'matched' | 'not_matched' | 'unverified';
  source: string;
  observedAt: string | null;
  reasons: string[];
}

export interface ScannerBacktestQualitySummary {
  status: 'verified' | 'missing' | 'insufficient';
  researchFrom?: string;
  researchTo?: string;
  oosWinRate?: number | null;
  walkForwardWinRate?: number | null;
  expectancyPercent?: number | null;
  profitFactor?: number | null;
  maxDrawdownPercent?: number | null;
  tradeCount?: number | null;
  minimumTradeCount?: number | null;
  sharpe?: number | null;
  netReturnPercent?: number | null;
  regime?: 'Strong Bull' | 'Bull' | 'Sideways' | 'Bear' | 'High Volatility' | 'Low Volatility' | null;
  regimeScore?: number | null;
  oosStabilityScore?: number | null;
  costsIncluded?: boolean;
  slippageIncluded?: boolean;
  lookaheadGuarded?: boolean;
  survivorshipGuarded?: boolean;
  oos?: boolean;
  walkForward?: boolean;
  source?: string | null;
}

export interface ScannerCandidateRankingSummary {
  rank: number;
  score: number;
  relativeScore: number;
  relative: {
    tradingValuePercentile: number;
    momentumPercentile: number;
    trendPercentile: number;
    volumePercentile: number;
    volatilityPercentile: number;
  };
  watchCompletionPercent: number;
  watchReasons: string[];
  hardFilterPassed: boolean;
  hardFilterReasons: string[];
}

export interface ScannerPricePlan {
  entryZone: { from: number; to: number } | null;
  invalidation: number | null;
  stopLoss: number | null;
  targets: number[];
  riskReward: number | null;
}

export interface ScannerSignalCard {
  signalId: string;
  assetClass: ScannerAssetClass;
  market: string;
  exchange: string | null;
  symbol: string;
  name: string;
  currency: string;
  assetType: string;
  listingStatus: 'LISTED' | 'UNKNOWN';
  price: number;
  changePercent: number | null;
  direction: ScannerDirection;
  action?: ScannerTradeAction;
  signalState: ScannerSignalState;
  score: number;
  confidence: number;
  dataCompleteness: number;
  riskScore: number | null;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNAVAILABLE';
  liquidity: number | null;
  volume: number | null;
  tradingValue: number | null;
  spreadPercent: number | null;
  volatilityPercent: number | null;
  matched: string[];
  notMatched: string[];
  unverified: string[];
  evidence: ScannerEvidence[];
  pricePlan: ScannerPricePlan;
  dataState: ScannerDataState;
  dataSources: string[];
  observedAt: string;
  expiresAt: string;
  strongSignalEligible: boolean;
  warnings: string[];
  strategyMode?: ScannerStrategyMode;
  signalGrade?: ScannerSignalGrade;
  dataQuality?: {
    state: 'TRUSTED' | 'DEGRADED' | 'DATA_UNTRUSTED';
    score: number;
    strongSignalAllowed: boolean;
    issues: Array<{ code: string; severity: 'warning' | 'blocking'; message: string }>;
  };
  quantScore?: {
    technical: number;
    trend: number;
    momentum: number;
    volume: number;
    liquidity: number;
    volatility: number;
    marketRegime: number;
    risk: number;
  };
  aiValidation?: {
    status: 'NOT_RUN' | 'PASS' | 'PARTIAL' | 'VETO';
    provider: string | null;
    counterEvidence: string[];
    missingData: string[];
    risks: string[];
    explanation: string | null;
  };
  backtestQuality?: ScannerBacktestQualitySummary;
  candidateRanking?: ScannerCandidateRankingSummary;
}

export interface ScannerAlertCandidate {
  idempotencyKey: string;
  signalId: string;
  assetClass: ScannerAssetClass;
  market: string;
  symbol: string;
  direction: ScannerDirection;
  action?: ScannerTradeAction;
  state: 'APPROVAL_PENDING' | 'READY_FOR_APPROVAL';
  entryZone: { from: number; to: number } | null;
  stopLoss: number | null;
  targets: number[];
  expiresAt: string;
  evidence: string[];
  orderSubmitted: false;
  exchangeRequestSent: false;
}

export interface ScannerFailure {
  symbol: string;
  reason: 'provider_error' | 'timeout' | 'invalid_data' | 'symbol_mapping';
  message: string;
}

export interface ScannerRefreshIssue {
  status: 409 | 429 | 502;
  code: string;
  retryAfterSeconds: number | null;
  message: string;
}

export interface ScannerResponse {
  ok: true;
  requestId: string;
  assetClass: ScannerAssetClass;
  market: string;
  timeframe: string;
  cards: ScannerSignalCard[];
  alerts: ScannerAlertCandidate[];
  failures: ScannerFailure[];
  execution: {
    requestedCount: number;
    startedCount: number;
    completedCount: number;
    excludedCount: number;
    providerErrorCount: number;
    timeoutCount: number;
    partial: boolean;
    timedOut: boolean;
    cancelled: boolean;
    duplicate: boolean;
    elapsedMs: number;
    deadlineMs: number;
    itemTimeoutMs: number;
    maxConcurrency: number;
    providerAcceptedCount?: number;
    dataSuccessCount?: number;
    insufficientDataCount?: number;
    filteredByStrategyCount?: number;
    unsupportedCount?: number;
    staleCount?: number;
    hardFilterPassCount?: number;
    hardFilterRejectedCount?: number;
    softCandidateCount?: number;
    finalDisplayedCount?: number;
    sGradeCount?: number;
    aGradeCount?: number;
    bGradeCount?: number;
    backtestMissingCount?: number;
  };
  universe: {
    totalCount: number;
    cursor: number;
    nextCursor: number | null;
    source: string;
    partial: boolean;
    stale: boolean;
    listingStatusCoverage: 'listed-or-unknown';
  };
  dataState: ScannerDataState;
  outcome?: ScannerOutcomeCode;
  message: string;
  generatedAt: string;
  refreshIssue?: ScannerRefreshIssue;
  orderSubmitted: false;
  exchangeRequestSent: false;
}

export function deriveScannerDisplayOutcome(response: ScannerResponse, renderedCount = response.cards.length): ScannerOutcomeCode {
  if (response.cards.length > 0 && renderedCount === 0) return 'FRONTEND_RENDER_FAILURE';
  if (renderedCount > 0) return 'CANDIDATES_AVAILABLE';
  if (response.outcome && response.outcome !== 'CANDIDATES_AVAILABLE') return response.outcome;

  const mappingFailure = response.failures.some((failure) =>
    failure.reason === 'symbol_mapping'
    || /(?:symbol|ticker).*(?:map|normaliz|mismatch|invalid)|(?:map|normaliz).*(?:symbol|ticker)/i.test(failure.message));
  if (mappingFailure) return 'SYMBOL_MAPPING_FAILURE';
  if (response.execution.timedOut || response.execution.timeoutCount > 0) return 'REQUEST_TIMEOUT';

  const providerFailure = response.execution.providerErrorCount > 0
    || response.failures.some((failure) => failure.reason === 'provider_error')
    || response.dataState === 'unavailable';
  if (response.universe.totalCount === 0) {
    if (providerFailure || response.universe.source === 'unavailable') return 'PROVIDER_FAILURE';
    return 'UNIVERSE_EMPTY';
  }

  const dataSuccessCount = response.execution.dataSuccessCount
    ?? Math.max(0, response.execution.completedCount - (response.execution.insufficientDataCount ?? 0));
  if (providerFailure && dataSuccessCount === 0) return 'PROVIDER_FAILURE';
  const dataRejectCount = response.execution.insufficientDataCount
    ?? response.failures.filter((failure) => failure.reason === 'invalid_data').length;
  if (dataRejectCount > 0 && dataSuccessCount === 0) return 'DATA_QUALITY_REJECT';
  if ((response.execution.hardFilterRejectedCount ?? 0) + (response.execution.filteredByStrategyCount ?? 0) > 0) return 'FILTER_TOO_STRICT';
  return 'VALID_ZERO_SIGNAL';
}

export interface SignalScannerRequest {
  assetClass: ScannerAssetClass;
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  strategy: ScannerStrategyMode;
  timeframe: '1m' | '3m' | '5m' | '15m' | '60m' | '4H' | '1D';
  conditions: string[];
  condition: 'trend' | 'volume' | 'breakout' | 'pullback' | 'williams';
  cursor: number;
  batchSize: number;
  minimumScore: number;
  maximumRiskScore: number;
}

export class SignalScannerRequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly retryAfterSeconds: number | null) {
    super(code);
    this.name = 'SignalScannerRequestError';
  }
}

interface ScannerInFlight {
  controller: AbortController;
  consumers: Set<symbol>;
  abortTimer: ReturnType<typeof setTimeout> | null;
  promise: Promise<ScannerResponse>;
}

const scannerInFlight = new Map<string, ScannerInFlight>();
const scannerLastGood = new Map<string, ScannerResponse>();
const scannerRetryUntil = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function abortError(): DOMException {
  return new DOMException('Scanner request aborted', 'AbortError');
}

function fallbackReason(error: SignalScannerRequestError): string {
  if (error.status === 409) return '동일 조건 분석이 이미 진행 중입니다. 기존 결과를 유지하며 완료를 기다립니다.';
  if (error.status === 429) {
    const retry = error.retryAfterSeconds == null ? '' : ` ${error.retryAfterSeconds}초 후`;
    return `검색 요청 한도를 보호하고 있습니다.${retry} 다음 갱신을 기다립니다.`;
  }
  return '시장데이터 공급자 응답이 불안정합니다. 마지막 정상 결과를 유지합니다.';
}

function asLastGoodFallback(response: ScannerResponse, error: SignalScannerRequestError): ScannerResponse {
  const reason = fallbackReason(error);
  return {
    ...response,
    cards: response.cards.map((card) => ({
      ...card,
      dataState: 'stale',
      strongSignalEligible: false,
      warnings: card.warnings.includes(reason) ? card.warnings : [...card.warnings, reason],
    })),
    alerts: [],
    execution: {
      ...response.execution,
      partial: true,
      duplicate: response.execution.duplicate || error.status === 409,
    },
    universe: {
      ...response.universe,
      partial: true,
      stale: true,
    },
    dataState: 'stale',
    message: `${response.message} · ${reason}`,
    refreshIssue: {
      status: error.status as 409 | 429 | 502,
      code: error.code,
      retryAfterSeconds: error.retryAfterSeconds,
      message: reason,
    },
  };
}

async function requestScannerUpstream(request: SignalScannerRequest, signal: AbortSignal): Promise<ScannerResponse> {
  const response = await authorizedFetch(buildSignalScannerRequestUrl(request), {
    signal,
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-cache, no-store, max-age=0', Pragma: 'no-cache' },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === 'string' ? payload.error : `HTTP_${response.status}`;
    const retryAfterHeader = Number(response.headers.get('Retry-After'));
    const retryAfterBody = isRecord(payload) ? Number(payload.retryAfterSeconds) : Number.NaN;
    const retryAfterSeconds = Number.isFinite(retryAfterHeader) ? retryAfterHeader : Number.isFinite(retryAfterBody) ? retryAfterBody : null;
    throw new SignalScannerRequestError(response.status, code, retryAfterSeconds);
  }
  if (!isRecord(payload) || payload.ok !== true || !Array.isArray(payload.cards)) {
    throw new SignalScannerRequestError(502, 'SCANNER_RESPONSE_INVALID', null);
  }
  if (payload.orderSubmitted !== false || payload.exchangeRequestSent !== false) {
    throw new SignalScannerRequestError(500, 'SCANNER_ORDER_SAFETY_VIOLATION', null);
  }
  return {
    ...(payload as Omit<ScannerResponse, 'failures'>),
    failures: Array.isArray(payload.failures) ? payload.failures as ScannerFailure[] : [],
  };
}

function consumeInFlight(key: string, entry: ScannerInFlight, signal: AbortSignal): Promise<ScannerResponse> {
  if (signal.aborted) return Promise.reject(abortError());

  if (entry.abortTimer !== null) {
    clearTimeout(entry.abortTimer);
    entry.abortTimer = null;
  }

  const consumer = Symbol(key);
  entry.consumers.add(consumer);

  return new Promise<ScannerResponse>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      entry.consumers.delete(consumer);
      if (entry.consumers.size === 0 && scannerInFlight.get(key) === entry) {
        entry.abortTimer = setTimeout(() => {
          if (entry.consumers.size === 0 && scannerInFlight.get(key) === entry) entry.controller.abort();
        }, 25);
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export async function fetchSignalScanner(request: SignalScannerRequest, signal: AbortSignal): Promise<ScannerResponse> {
  const key = buildSignalScannerRequestUrl(request);
  const existing = scannerInFlight.get(key);
  if (existing) return consumeInFlight(key, existing, signal);

  const retryUntil = scannerRetryUntil.get(key) ?? 0;
  if (retryUntil > Date.now()) {
    const remaining = Math.max(1, Math.ceil((retryUntil - Date.now()) / 1000));
    const cached = scannerLastGood.get(key);
    const rateError = new SignalScannerRequestError(429, 'SCAN_RATE_LIMIT_BACKOFF', remaining);
    if (cached) return asLastGoodFallback(cached, rateError);
    throw rateError;
  }

  const entry = {
    controller: new AbortController(),
    consumers: new Set<symbol>(),
    abortTimer: null,
    promise: Promise.resolve(null as unknown as ScannerResponse),
  } satisfies ScannerInFlight;

  entry.promise = requestScannerUpstream(request, entry.controller.signal)
    .then((result) => {
      scannerRetryUntil.delete(key);
      if (result.dataState === 'complete' || result.dataState === 'partial') scannerLastGood.set(key, result);
      return result;
    })
    .catch((error: unknown) => {
      if (error instanceof SignalScannerRequestError) {
        if (error.status === 429 && error.retryAfterSeconds !== null) {
          scannerRetryUntil.set(key, Date.now() + Math.max(1, error.retryAfterSeconds) * 1000);
        }
        if (error.status === 409 || error.status === 429 || error.status === 502) {
          const cached = scannerLastGood.get(key);
          if (cached) return asLastGoodFallback(cached, error);
        }
      }
      throw error;
    })
    .finally(() => {
      if (entry.abortTimer !== null) clearTimeout(entry.abortTimer);
      if (scannerInFlight.get(key) === entry) scannerInFlight.delete(key);
    });

  scannerInFlight.set(key, entry);
  return consumeInFlight(key, entry, signal);
}

export function signalScannerDetailPath(card: ScannerSignalCard): string {
  const symbol = encodeURIComponent(card.symbol);
  if (card.assetClass === 'stock') {
    const market = encodeURIComponent(card.market === 'US' ? 'US' : 'KR');
    return `/stock-info?asset=stock&market=${market}&ticker=${symbol}`;
  }
  const coinMarket = card.assetClass === 'coin_futures' ? 'futures' : 'spot';
  return `/stock-info?asset=coin&coinMarket=${coinMarket}&symbol=${symbol}`;
}

