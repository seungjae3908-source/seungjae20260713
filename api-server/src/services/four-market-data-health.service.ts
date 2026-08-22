export type FourMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type FourMarketProvider = 'TOSS' | 'UPBIT' | 'BITGET';
export type FourMarketStage = 'BACKTEST' | 'PAPER' | 'SHADOW' | 'AUTO_PREDEPLOY';
export type FourMarketDirection = 'BUY' | 'SELL' | 'LONG' | 'SHORT';

export type FourMarketCapability =
  | 'HISTORICAL_OHLCV'
  | 'POINT_IN_TIME_UNIVERSE'
  | 'CORPORATE_ACTIONS'
  | 'SESSION_CALENDAR'
  | 'QUOTE'
  | 'ORDERBOOK'
  | 'TICK_SIZE'
  | 'MIN_ORDER'
  | 'CONTRACT_SPEC'
  | 'MARK_PRICE'
  | 'FUNDING_RATE'
  | 'FUNDING_HISTORY'
  | 'OPEN_INTEREST'
  | 'EXECUTION_CONTRACT';

export type FourMarketReadinessStatus =
  | 'READY'
  | 'BLOCKED_PROVIDER'
  | 'BLOCKED_DATA'
  | 'STALE_DATA'
  | 'UNKNOWN_COST_POLICY'
  | 'DIRECTION_NOT_SUPPORTED';

export interface FourMarketCapabilityEvidence {
  provider: FourMarketProvider;
  capabilities: readonly FourMarketCapability[];
  fetchedAt: string;
  provenance: readonly string[];
  costPolicyVersion?: string | null;
  dataQualityPassed: boolean;
  publicOrStaticOnly: boolean;
}

export interface FourMarketReadinessInput {
  market: FourMarket;
  stage: FourMarketStage;
  direction: FourMarketDirection;
  reducingPosition?: boolean;
  evidence: FourMarketCapabilityEvidence;
  now?: string;
  maxAgeMs?: number;
}

export interface FourMarketReadinessResult {
  market: FourMarket;
  stage: FourMarketStage;
  providerAuthority: FourMarketProvider;
  status: FourMarketReadinessStatus;
  ready: boolean;
  requiredCapabilities: FourMarketCapability[];
  missingCapabilities: FourMarketCapability[];
  reasons: string[];
  costPolicyVersion: string | null;
  provenance: readonly string[];
  privateTradingRequestAllowed: false;
  liveActivationAllowed: false;
}

export const FOUR_MARKET_PROVIDER_AUTHORITY: Readonly<Record<FourMarket, FourMarketProvider>> = {
  KR_STOCK: 'TOSS',
  US_STOCK: 'TOSS',
  CRYPTO_SPOT: 'UPBIT',
  CRYPTO_FUTURES: 'BITGET',
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function requiredCapabilities(market: FourMarket, stage: FourMarketStage): FourMarketCapability[] {
  if (stage === 'BACKTEST') {
    if (market === 'KR_STOCK' || market === 'US_STOCK') {
      return ['HISTORICAL_OHLCV', 'POINT_IN_TIME_UNIVERSE', 'CORPORATE_ACTIONS', 'SESSION_CALENDAR', 'TICK_SIZE'];
    }
    if (market === 'CRYPTO_SPOT') return ['HISTORICAL_OHLCV', 'TICK_SIZE', 'MIN_ORDER'];
    return ['HISTORICAL_OHLCV', 'FUNDING_HISTORY', 'CONTRACT_SPEC', 'TICK_SIZE', 'MIN_ORDER'];
  }

  const realtimeBase: FourMarketCapability[] = ['QUOTE', 'ORDERBOOK', 'TICK_SIZE', 'MIN_ORDER'];
  if (market === 'KR_STOCK' || market === 'US_STOCK') {
    return unique([...realtimeBase, 'SESSION_CALENDAR', ...(stage === 'AUTO_PREDEPLOY' ? ['EXECUTION_CONTRACT' as const] : [])]);
  }
  if (market === 'CRYPTO_SPOT') {
    return unique([...realtimeBase, ...(stage === 'AUTO_PREDEPLOY' ? ['EXECUTION_CONTRACT' as const] : [])]);
  }
  return unique([
    ...realtimeBase,
    'CONTRACT_SPEC',
    'MARK_PRICE',
    'FUNDING_RATE',
    'OPEN_INTEREST',
    ...(stage === 'AUTO_PREDEPLOY' ? ['EXECUTION_CONTRACT' as const] : []),
  ]);
}

function directionReason(input: FourMarketReadinessInput): string | null {
  if (input.market === 'CRYPTO_FUTURES') {
    return input.direction === 'LONG' || input.direction === 'SHORT'
      ? null
      : 'FUTURES_DIRECTION_MUST_BE_LONG_OR_SHORT';
  }
  if (input.direction === 'BUY') return null;
  if (input.direction === 'SELL' && input.reducingPosition === true) return null;
  if (input.direction === 'SELL') return 'CASH_MARKET_SELL_REQUIRES_EXISTING_POSITION';
  return 'CASH_MARKET_SHORT_NOT_SUPPORTED';
}

function validTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateFourMarketReadiness(input: FourMarketReadinessInput): FourMarketReadinessResult {
  const providerAuthority = FOUR_MARKET_PROVIDER_AUTHORITY[input.market];
  const required = requiredCapabilities(input.market, input.stage);
  const capabilities = new Set(input.evidence.capabilities);
  const missingCapabilities = required.filter((capability) => !capabilities.has(capability));
  const reasons: string[] = [];

  let status: FourMarketReadinessStatus = 'READY';
  if (input.evidence.provider !== providerAuthority) {
    status = 'BLOCKED_PROVIDER';
    reasons.push(`PROVIDER_AUTHORITY_MISMATCH:${input.evidence.provider}->${providerAuthority}`);
  } else {
    const unsupportedDirection = directionReason(input);
    if (unsupportedDirection) {
      status = 'DIRECTION_NOT_SUPPORTED';
      reasons.push(unsupportedDirection);
    } else if (!input.evidence.publicOrStaticOnly) {
      status = 'BLOCKED_PROVIDER';
      reasons.push('PRIVATE_PROVIDER_EVIDENCE_FORBIDDEN_IN_AUTOMATED_VALIDATION');
    } else if (!input.evidence.dataQualityPassed || input.evidence.provenance.length === 0) {
      status = 'BLOCKED_DATA';
      if (!input.evidence.dataQualityPassed) reasons.push('DATA_QUALITY_FAILED');
      if (input.evidence.provenance.length === 0) reasons.push('PROVENANCE_REQUIRED');
    } else if (missingCapabilities.length > 0) {
      status = 'BLOCKED_DATA';
      reasons.push(...missingCapabilities.map((capability) => `MISSING_CAPABILITY:${capability}`));
    } else if (!input.evidence.costPolicyVersion?.trim()) {
      status = 'UNKNOWN_COST_POLICY';
      reasons.push('COST_POLICY_VERSION_REQUIRED');
    } else {
      const now = validTimestamp(input.now ?? new Date().toISOString());
      const fetchedAt = validTimestamp(input.evidence.fetchedAt);
      const maxAgeMs = Math.max(1, input.maxAgeMs ?? (input.stage === 'BACKTEST' ? 24 * 60 * 60 * 1000 : 2 * 60 * 1000));
      if (now == null || fetchedAt == null || fetchedAt > now || now - fetchedAt > maxAgeMs) {
        status = 'STALE_DATA';
        reasons.push('EVIDENCE_TIMESTAMP_STALE_OR_INVALID');
      }
    }
  }

  return {
    market: input.market,
    stage: input.stage,
    providerAuthority,
    status,
    ready: status === 'READY',
    requiredCapabilities: required,
    missingCapabilities,
    reasons,
    costPolicyVersion: input.evidence.costPolicyVersion?.trim() || null,
    provenance: input.evidence.provenance,
    privateTradingRequestAllowed: false,
    liveActivationAllowed: false,
  };
}

export function fourMarketReadinessMatrix(inputs: readonly FourMarketReadinessInput[]): FourMarketReadinessResult[] {
  return inputs.map(evaluateFourMarketReadiness);
}
