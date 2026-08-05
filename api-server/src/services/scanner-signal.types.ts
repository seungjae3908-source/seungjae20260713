export type ScannerAssetClass = 'stock' | 'coin_spot' | 'coin_futures';
export type ScannerSignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
export type ScannerSignalState =
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED';
export type ScannerEvidenceStatus = 'matched' | 'not_matched' | 'unverified';
export type ScannerDataState =
  | 'complete'
  | 'partial'
  | 'stale'
  | 'insufficient'
  | 'unavailable';

export interface ScannerEvidence {
  key: string;
  label: string;
  status: ScannerEvidenceStatus;
  source: string;
  observedAt: string | null;
  reasons: string[];
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
  direction: ScannerSignalDirection;
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
}

export interface ScannerAlertCandidate {
  idempotencyKey: string;
  signalId: string;
  assetClass: ScannerAssetClass;
  market: string;
  symbol: string;
  direction: ScannerSignalDirection;
  state: 'READY_FOR_APPROVAL';
  entryZone: ScannerPricePlan['entryZone'];
  stopLoss: number | null;
  targets: number[];
  expiresAt: string;
  evidence: string[];
  orderSubmitted: false;
  exchangeRequestSent: false;
}

export interface ScannerExecutionSummary {
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
  execution: ScannerExecutionSummary;
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
