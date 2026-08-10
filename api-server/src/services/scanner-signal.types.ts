export type ScannerAssetClass = 'stock' | 'coin_spot' | 'coin_futures';
export type ScannerSignalDirection = 'LONG' | 'SHORT' | 'NEUTRAL';
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
export type ScannerEvidenceStatus = 'matched' | 'not_matched' | 'unverified';
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

export interface ScannerDataQualitySummary {
  state: 'TRUSTED' | 'DEGRADED' | 'DATA_UNTRUSTED';
  score: number;
  strongSignalAllowed: boolean;
  issues: Array<{
    code:
      | 'STALE_TIMESTAMP'
      | 'MISSING_CANDLE'
      | 'DUPLICATE_CANDLE'
      | 'INVALID_OHLC'
      | 'INVALID_VOLUME'
      | 'ABNORMAL_SPIKE'
      | 'SYMBOL_MISMATCH'
      | 'PROVIDER_DISAGREEMENT'
      | 'MARKET_CLOSED'
      | 'TRADING_HALT';
    severity: 'warning' | 'blocking';
    message: string;
  }>;
}

export interface ScannerQuantScoreBreakdown {
  technical: number;
  trend: number;
  momentum: number;
  volume: number;
  liquidity: number;
  volatility: number;
  marketRegime: number;
  risk: number;
}

export interface ScannerAiValidationSummary {
  status: 'NOT_RUN' | 'PASS' | 'PARTIAL' | 'VETO';
  provider: string | null;
  counterEvidence: string[];
  missingData: string[];
  risks: string[];
  explanation: string | null;
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
  strategyMode?: ScannerStrategyMode;
  signalGrade?: ScannerSignalGrade;
  dataQuality?: ScannerDataQualitySummary;
  quantScore?: ScannerQuantScoreBreakdown;
  aiValidation?: ScannerAiValidationSummary;
  backtestQuality?: ScannerBacktestQualitySummary;
  candidateRanking?: ScannerCandidateRankingSummary;
}

export interface ScannerAlertCandidate {
  idempotencyKey: string;
  signalId: string;
  assetClass: ScannerAssetClass;
  market: string;
  symbol: string;
  direction: ScannerSignalDirection;
  state: 'APPROVAL_PENDING' | 'READY_FOR_APPROVAL';
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
  hardFilterPassCount?: number;
  hardFilterRejectedCount?: number;
  softCandidateCount?: number;
  finalDisplayedCount?: number;
  sGradeCount?: number;
  aGradeCount?: number;
  bGradeCount?: number;
  backtestMissingCount?: number;
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