export const MEMBER_INVESTMENT_SAFETY = Object.freeze({
  executionAuthority: 'NONE' as const,
  liveTrading: false as const,
  realOrderAllowed: false as const,
  withdrawalAllowed: false as const,
  transferAllowed: false as const,
  privateProviderCalls: 0 as const,
});

export type InvestmentProvider = 'toss' | 'kiwoom' | 'upbit' | 'bitget';
export type InvestmentProviderType = 'KR_BROKER' | 'US_BROKER' | 'CRYPTO_EXCHANGE';
export type InvestmentMarket = 'KR_STOCK' | 'US_STOCK' | 'CRYPTO_SPOT' | 'CRYPTO_FUTURES';
export type InvestmentFreshness = 'FRESH' | 'STALE' | 'PARTIAL' | 'MISSING' | 'UNAVAILABLE';
export type InvestmentProviderStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE';
export type ConnectionStatus = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'REVOKED' | 'UNVERIFIED';
export type ExecutionMode = 'SHADOW' | 'PAPER' | 'PREVIEW' | 'LIVE';
export type IntentSide = 'BUY' | 'LONG' | 'SHORT' | 'REDUCE' | 'EXIT';
export type PositionSide = 'LONG' | 'SHORT' | null;
export type IntentStatus =
  | 'CREATED'
  | 'RISK_BLOCKED'
  | 'PREVIEW_READY'
  | 'LIVE_APPROVAL_REQUIRED'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export type BrokerExchangeConnection = {
  id: string;
  userId: string;
  provider: InvestmentProvider;
  providerType: InvestmentProviderType;
  accountScope: string;
  connectionStatus: ConnectionStatus;
  permissions: string[];
  readOnlyCapable: boolean;
  tradeCapable: boolean;
  credentialReference: string | null;
  credentialVersion: number | null;
  lastVerifiedAt: string | null;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountSnapshot = {
  id: string;
  userId: string;
  connectionId: string;
  provider: InvestmentProvider;
  accountType: string;
  currency: string;
  totalEquity: number | null;
  cashBalance: number | null;
  availableBalance: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
  dailyLoss: number | null;
  drawdown: number | null;
  dataAsOf: string;
  collectedAt: string;
  freshnessStatus: InvestmentFreshness;
  providerStatus: InvestmentProviderStatus;
  provenance: string;
  snapshotVersion: number;
};

export type StockHolding = {
  id: string;
  userId: string;
  connectionId: string | null;
  provider: InvestmentProvider | null;
  market: 'KR_STOCK' | 'US_STOCK';
  symbol: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPct: number | null;
  dataAsOf: string | null;
  collectedAt: string | null;
  freshnessStatus: InvestmentFreshness;
  provenance: string | null;
};

export type CryptoSpotHolding = {
  id: string;
  userId: string;
  connectionId: string;
  provider: InvestmentProvider;
  asset: string;
  free: number | null;
  locked: number | null;
  averagePrice: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  dataAsOf: string;
  collectedAt: string;
  freshnessStatus: InvestmentFreshness;
  provenance: string;
};

export type FuturesPosition = {
  id: string;
  userId: string;
  connectionId: string;
  exchange: InvestmentProvider;
  symbol: string;
  side: Exclude<PositionSide, null>;
  marginMode: 'ISOLATED' | 'CROSS';
  leverage: number | null;
  quantity: number | null;
  entryPrice: number | null;
  markPrice: number | null;
  liquidationPrice: number | null;
  liquidationDistancePct: number | null;
  unrealizedPnl: number | null;
  maintenanceMargin: number | null;
  dataAsOf: string;
  collectedAt: string;
  freshnessStatus: InvestmentFreshness;
  provenance: string;
};

export type AutomationPolicy = {
  id: string;
  userId: string;
  connectionId: string;
  market: InvestmentMarket;
  strategyId: string;
  strategyVersion: string;
  enabled: boolean;
  executionMode: ExecutionMode;
  allowedSymbols: string[];
  maxPositionValue: number;
  maxPositionPct: number;
  maxDailyLoss: number;
  maxDrawdown: number;
  maxOrdersPerDay: number;
  maxConcurrentPositions: number;
  cooldownSeconds: number;
  leverageMin: number;
  leverageMax: number;
  minLiquidationBufferPct: number;
  stopLossRequired: boolean;
  takeProfitRequired: boolean;
  killSwitch: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OrderIntent = {
  id: string;
  userId: string;
  connectionId: string;
  sourceSignalId: string;
  sourceSignalGeneratedAt: string;
  strategyId: string;
  market: InvestmentMarket;
  symbol: string;
  side: IntentSide;
  positionSide: PositionSide;
  orderType: 'MARKET' | 'LIMIT';
  requestedQuantity: number;
  requestedPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  leverage: number | null;
  status: IntentStatus;
  riskDecision: 'PENDING' | 'BLOCKED' | 'PREVIEW_ONLY';
  riskReasons: string[];
  idempotencyKey: string;
  createdAt: string;
  expiresAt: string;
};

export type ExecutionPreview = {
  id: string;
  userId: string;
  orderIntentId: string;
  provider: InvestmentProvider;
  estimatedNotional: number;
  referencePrice: number;
  requestedQuantity: number;
  status: 'PREVIEW_ONLY';
  warnings: string[];
  createdAt: string;
  expiresAt: string;
  safety: typeof MEMBER_INVESTMENT_SAFETY;
};

export type RiskMetrics = {
  dailyLoss: number | null;
  drawdown: number | null;
  ordersToday: number | null;
  concurrentPositions: number | null;
  currentPositionValue: number | null;
  lastIntentAt: string | null;
  duplicateIntent: boolean;
  liquidationDistancePct: number | null;
};

export type RiskGateResult = {
  allowed: boolean;
  decision: 'BLOCKED' | 'PREVIEW_ONLY';
  status: 'RISK_BLOCKED' | 'PREVIEW_READY';
  reasons: string[];
  checkedAt: string;
  safety: typeof MEMBER_INVESTMENT_SAFETY;
};

export function defaultAutomationPolicy(input: {
  id: string;
  userId: string;
  connectionId: string;
  market: InvestmentMarket;
  strategyId: string;
  strategyVersion: string;
  now?: Date;
}): AutomationPolicy {
  const timestamp = (input.now ?? new Date()).toISOString();
  return {
    ...input,
    enabled: false,
    executionMode: 'SHADOW',
    allowedSymbols: [],
    maxPositionValue: 0,
    maxPositionPct: 0,
    maxDailyLoss: 0,
    maxDrawdown: 0,
    maxOrdersPerDay: 0,
    maxConcurrentPositions: 0,
    cooldownSeconds: 0,
    leverageMin: 1,
    leverageMax: 1,
    minLiquidationBufferPct: 0,
    stopLossRequired: true,
    takeProfitRequired: true,
    killSwitch: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
