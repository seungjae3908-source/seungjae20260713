import { authorizedFetch } from '@/lib/auth-fetch';
import { buildSignalScannerRequestUrl } from './signal-scanner-url';

export type ScannerAssetClass = 'stock' | 'coin_spot' | 'coin_futures';
export type ScannerDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
export type ScannerStrategyMode = 'scalping' | 'swing';
export type ScannerSignalGrade = 'S' | 'A' | 'B' | 'C' | 'D';
export type ScannerSignalState =
  | 'CANDIDATE'
  | 'CONFIRMED'
  | 'ARMED'
  | 'ENTRY_ZONE'
  | 'APPROVAL_PENDING'
  | 'APPROVED'
  | 'EXECUTING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'MANAGING'
  | 'CLOSED'
  | 'INVALIDATED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED';
export type ScannerDataState =
  | 'complete'
  | 'partial'
  | 'stale'
  | 'insufficient'
  | 'unavailable'
  | 'untrusted';

export interface ScannerEvidence {
  key: string;
  label: string;
  status: 'matched' | 'not_matched' | 'unverified';
  source: string;
  observedAt: string | null;
  reasons: string[];
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
  pricePlan: {
    entryZone: { from: number; to: number } | null;
    invalidation: number | null;
    stopLoss: number | null;
    targets: number[];
    riskReward: number | null;
  };
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
}

export interface ScannerAlertCandidate {
  idempotencyKey: string;
  signalId: string;
  assetClass: ScannerAssetClass;
  market: string;
  symbol: string;
  direction: ScannerDirection;
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
  reason: 'provider_error' | 'timeout' | 'invalid_data';
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
  message: string;
  generatedAt: string;
  orderSubmitted: false;
  exchangeRequestSent: false;
}

export interface SignalScannerRequest {
  assetClass: ScannerAssetClass;
  market: 'KR' | 'US' | 'UPBIT' | 'BITGET';
  strategy: ScannerStrategyMode;
  timeframe: '1m' | '3m' | '5m' | '15m' | '60m' | '4H' | '1D';
  conditions: string[];
  condition: 'trend' | 'volume' | 'breakout' | 'pullback';
  cursor: number;
  batchSize: number;
  minimumScore: number;
  maximumRiskScore: number;
}

export class SignalScannerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(code);
    this.name = 'SignalScannerRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function fetchSignalScanner(
  request: SignalScannerRequest,
  signal: AbortSignal,
): Promise<ScannerResponse> {
  const response = await authorizedFetch(buildSignalScannerRequestUrl(request), {
    signal,
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, max-age=0',
      Pragma: 'no-cache',
    },
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === 'string'
      ? payload.error
      : `HTTP_${response.status}`;
    const retryAfterHeader = Number(response.headers.get('Retry-After'));
    const retryAfterBody = isRecord(payload) ? Number(payload.retryAfterSeconds) : Number.NaN;
    const retryAfterSeconds = Number.isFinite(retryAfterHeader)
      ? retryAfterHeader
      : Number.isFinite(retryAfterBody)
        ? retryAfterBody
        : null;
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
    failures: Array.isArray(payload.failures)
      ? payload.failures as ScannerFailure[]
      : [],
  };
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
