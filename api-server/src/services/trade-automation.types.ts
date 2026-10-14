export type TradingExchange = 'bitget' | 'upbit' | 'kiwoom' | 'toss';
export type StockBroker = 'kiwoom' | 'toss';
export type StockTradingAssetClass = 'domestic_stock' | 'us_stock';
export type TradingMode = 'approval' | 'automatic';
export type TradingAccountMode = 'paper' | 'mock' | 'live';
export type TradingSide = 'buy' | 'sell' | 'long' | 'short';
export type TradingOrderType = 'market' | 'limit';
export type TradingMarketRegime = 'bull' | 'bear' | 'sideways' | 'stress' | 'unknown';
export type TradingPilotStage = 'approval-20' | 'limited-50' | 'validated' | 'formula-ai-exception';
export type TradingAssetClass = 'domestic_stock' | 'us_stock' | 'crypto_spot' | 'crypto_futures';
export type DailyProfitTargetAction = 'STOP_NEW_ENTRIES' | 'PROFIT_PROTECTION' | 'NOTIFY_ONLY';
export type DailyProfitTargetPolicy = Readonly<{
  enabled: boolean;
  /** A desired return, never a guarantee or permission to increase risk. */
  targetPercent: number;
  afterTargetAction: DailyProfitTargetAction;
}>;
export const USER_MARKET_CAPITAL_POLICY_VERSION = 'user-market-capital-v1' as const;
export type TradingCapitalAllocationPolicy = Readonly<{
  /** False preserves the legacy policy and grants no new capital authority. */
  configured: boolean;
  /** User-selected absolute cash/margin ceiling for this market. */
  operatingCapitalKrw: number;
  /** Separate per-entry notional ceiling; Risk may always choose less. */
  maxOrderKrw: number;
  /** Reserved for a future explicit opt-in. V1 must remain false. */
  compoundAboveAllocation: false;
  policyVersion: typeof USER_MARKET_CAPITAL_POLICY_VERSION;
  /** Server-authored audit fields. Browser values are never trusted. */
  updatedAt: string | null;
  accountScopeId: string | null;
}>;
export type TradingCapitalAllocationAudit = Readonly<{
  market: TradingAssetClass;
  configured: boolean;
  operatingCapitalKrw: number;
  maxOrderKrw: number;
  changedAt: string;
  userScopeDigest: string;
  accountScopeId: string | null;
  policyVersion: typeof USER_MARKET_CAPITAL_POLICY_VERSION;
}>;

export type TradingOrderState =
  | 'PLANNED'
  | 'APPROVAL_PENDING'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_REQUESTED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'RECOVERY_REQUIRED';

export type TradingProtectionStatus =
  | 'NOT_REQUIRED'
  | 'PENDING'
  | 'PROTECTED'
  | 'UNPROTECTED_POSITION';

export type TradingFill = {
  id: string;
  price: number;
  quantity: number;
  feeAmount: number | null;
  feeCurrency: string | null;
  filledAt: string;
};


export type TradingOrderAmendment = {
  requestId: string;
  revision: number;
  status: 'INTENT_RECORDED' | 'ACKNOWLEDGED' | 'RECOVERY_REQUIRED';
  previousClientOrderId: string;
  nextClientOrderId: string;
  previousExchangeOrderId: string | null;
  nextExchangeOrderId: string | null;
  requestedQuantity: number | null;
  requestedPrice: number;
  requestedAt: string;
  acknowledgedAt: string | null;
  errorCode: string | null;
};

export type TradingOrderLeg = {
  id: string;
  planId: string;
  legKey: string;
  legType: 'ENTRY' | 'TARGET' | 'STOP';
  sequenceNo: number;
  idempotencyKey: string;
  plannedQuantity: number | null;
  plannedQuoteAmount: number | null;
  plannedPrice: number | null;
  filledQuantity: number;
  state: TradingOrderState;
  version: number;
};

export type TradingProtectionOrder = {
  id: string;
  parentOrderId: string;
  protectionType: 'STOP' | 'TARGET';
  sequenceNo: number;
  clientOrderId: string;
  exchangeOrderId: string | null;
  quantity: number;
  triggerPrice: number;
  reduceOnly: boolean;
  state: TradingOrderState;
  version: number;
};

export const PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW = 500_000 as const;
export const PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW = 1_000_000 as const;
// Formula+AI automatic LIVE begins with a smaller, role-scoped discovery cap.
// This is an order ceiling, not a deposit and not a change to the four-market
// capital allocation. Promotion may raise it later, but discovery can never
// silently inherit the full role ceiling.
export const PRODUCTION_MEMBER_DISCOVERY_MAX_SINGLE_ENTRY_KRW = 100_000 as const;
export const PRODUCTION_ADMIN_DISCOVERY_MAX_SINGLE_ENTRY_KRW = 500_000 as const;
export const PRODUCTION_LIVE_MARKET_COUNT = 4 as const;
export const PRODUCTION_MEMBER_FOUR_MARKET_INITIAL_KRW =
  PRODUCTION_LIVE_MARKET_COUNT * PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW;
export const PRODUCTION_ADMIN_FOUR_MARKET_INITIAL_KRW =
  PRODUCTION_LIVE_MARKET_COUNT * PRODUCTION_ADMIN_MAX_SINGLE_ENTRY_KRW;
export const PRODUCTION_MEMBER_MAX_BITGET_LEVERAGE = 3 as const;
export const PRODUCTION_ADMIN_MAX_BITGET_LEVERAGE = 7 as const;

export const DEFAULT_TRADING_POLICY = Object.freeze({
  mode: 'approval' as TradingMode,
  automaticEnabled: false,
  emergencyStopped: false,
  newEntriesStopped: false,
  dailyProfitTargetByMarket: {
    domestic_stock: { enabled: false, targetPercent: 5, afterTargetAction: 'PROFIT_PROTECTION' },
    us_stock: { enabled: false, targetPercent: 5, afterTargetAction: 'PROFIT_PROTECTION' },
    crypto_spot: { enabled: false, targetPercent: 5, afterTargetAction: 'PROFIT_PROTECTION' },
    crypto_futures: { enabled: false, targetPercent: 5, afterTargetAction: 'PROFIT_PROTECTION' },
  } as Record<TradingAssetClass, DailyProfitTargetPolicy>,
  capitalAllocationByMarket: {
    domestic_stock: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, compoundAboveAllocation: false, policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION, updatedAt: null, accountScopeId: null },
    us_stock: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, compoundAboveAllocation: false, policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION, updatedAt: null, accountScopeId: null },
    crypto_spot: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, compoundAboveAllocation: false, policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION, updatedAt: null, accountScopeId: null },
    crypto_futures: { configured: false, operatingCapitalKrw: 0, maxOrderKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW, compoundAboveAllocation: false, policyVersion: USER_MARKET_CAPITAL_POLICY_VERSION, updatedAt: null, accountScopeId: null },
  } as Record<TradingAssetClass, TradingCapitalAllocationPolicy>,
  capitalAllocationAuditTrail: [] as TradingCapitalAllocationAudit[],
  marketEnabled: { domestic_stock: true, us_stock: true, crypto_spot: true, crypto_futures: false } as Record<TradingAssetClass, boolean>,
  stockBrokerByMarket: { domestic_stock: 'kiwoom', us_stock: 'kiwoom' } as Record<StockTradingAssetClass, StockBroker>,
  exchangeEnabled: { bitget: false, upbit: false, kiwoom: false, toss: false },
  enabledAssets: { bitget: [] as string[], upbit: [] as string[], kiwoom: [] as string[], toss: [] as string[] },
  enabledStrategies: [] as string[],
  totalCapitalKrw: 1_000_000,
  maxOrderKrw: PRODUCTION_MEMBER_MAX_SINGLE_ENTRY_KRW,
  maxInstrumentKrw: 1_000_000,
  maxAssetClassKrw: {
    domestic_stock: 1_000_000,
    us_stock: 1_000_000,
    crypto_spot: 1_000_000,
    crypto_futures: 1_000_000,
  } as Record<TradingAssetClass, number>,
  dailyLossLimitPercent: 3,
  weeklyLossLimitPercent: 10,
  maxAssetPercent: 30,
  maxOpenPositions: 5,
  // Zero means opportunity-driven entry with no ordinary business quota.
  // Duplicate/idempotency, concurrent-position, loss and provider guards still
  // fail closed independently.
  maxDailyOrders: 0,
  maxConsecutiveLosses: 3,
  bitgetLeverage: 2 as 2 | 3 | 4 | 5 | 6 | 7,
  riskOptimizationEnabled: true,
  pilotStage: 'approval-20' as TradingPilotStage,
  riskPerTradePercent: { bitget: 0.1, upbit: 0.2, kiwoom: 0.25, toss: 0.25 },
  totalDailyLossLimitPercent: 1,
  minExpectedValueR: 0.15,
  minStrategySampleSize: 50,
  minProfitFactor: 1.2,
  maxStrategyDrawdownPercent: 15,
  maxEstimatedSlippagePercent: 0.25,
  maxAverageSpreadPercent: 0.15,
  maxCorrelatedExposurePercent: 40,
  maxEconomicsAgeHours: 24,
});

export type TradingPolicy = {
  mode: TradingMode;
  automaticEnabled: boolean;
  emergencyStopped: boolean;
  newEntriesStopped: boolean;
  dailyProfitTargetByMarket: Record<TradingAssetClass, DailyProfitTargetPolicy>;
  capitalAllocationByMarket: Record<TradingAssetClass, TradingCapitalAllocationPolicy>;
  /** Bounded, server-authored history. The policy row itself remains user-scoped. */
  capitalAllocationAuditTrail: TradingCapitalAllocationAudit[];
  marketEnabled: Record<TradingAssetClass, boolean>;
  stockBrokerByMarket?: Record<StockTradingAssetClass, StockBroker>;
  exchangeEnabled: Record<TradingExchange, boolean>;
  enabledAssets: Record<TradingExchange, string[]>;
  enabledStrategies: string[];
  totalCapitalKrw: number;
  maxOrderKrw: number;
  maxInstrumentKrw: number;
  maxAssetClassKrw: Record<TradingAssetClass, number>;
  dailyLossLimitPercent: number;
  weeklyLossLimitPercent: number;
  maxAssetPercent: number;
  maxOpenPositions: number;
  maxDailyOrders: number;
  maxConsecutiveLosses: number;
  bitgetLeverage: 2 | 3 | 4 | 5 | 6 | 7;
  riskOptimizationEnabled: boolean;
  pilotStage: TradingPilotStage;
  riskPerTradePercent: Record<TradingExchange, number>;
  totalDailyLossLimitPercent: number;
  minExpectedValueR: number;
  minStrategySampleSize: number;
  minProfitFactor: number;
  maxStrategyDrawdownPercent: number;
  maxEstimatedSlippagePercent: number;
  maxAverageSpreadPercent: number;
  maxCorrelatedExposurePercent: number;
  maxEconomicsAgeHours: number;
};

export type ExchangeConnection = {
  userId: string;
  exchange: TradingExchange;
  accountMode: TradingAccountMode;
  configured: boolean;
  encryptedCredentials: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

export type TradingSignalState =
  | 'detected'
  | 'monitoring'
  | 'condition_maintained'
  | 'entry_ready'
  | 'approved'
  | 'condition_broken'
  | 'expired'
  | 'invalidated'
  | 'DETECTED'
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type TradingMarketSnapshot = {
  observedAt: string;
  riskObservedAt?: string | null;
  dataDelayMs: number;
  oneMinuteMovePercent: number;
  spreadPercent: number;
  orderbookGapPercent: number;
  halted: boolean;
  availableBalance: number;
  accountValueKrw: number;
  dailyPnlPercent: number;
  weeklyPnlPercent?: number;
  /** Full-cost settled AUTO profit for this market's exchange-local trading day. */
  dailyRealizedNetPnlKrw?: number | null;
  /** Current AUTO-owned mark-to-market only; manual positions remain excluded. */
  unrealizedPnlKrw?: number | null;
  assetExposurePercent: number;
  accountExposureKrw?: number | null;
  instrumentExposureKrw?: number | null;
  strategyExposureKrw?: number | null;
  assetClassExposureKrw?: number | null;
  /** Cash or isolated-margin commitment, distinct from futures notional. */
  assetClassCapitalCommittedKrw?: number | null;
  openRiskKrw?: number | null;
  openPositionCount: number;
  dailyOrderCount: number;
  consecutiveLosses: number;
  existingPositionSide?: TradingSide | null;
  liquidationDistancePercent?: number | null;
  openOrderExposureKrw?: number;
  currentPrice?: number | null;
  plannedPrice?: number | null;
  marketStatus?: 'OPEN' | 'CLOSED' | 'HALTED' | 'UNKNOWN';
  providerTimeOffsetMs?: number;
  source?: string;
  availableLiquidityKrw?: number | null;
  estimatedSlippagePercent?: number | null;
  estimatedFeePercent?: number | null;
  // Optional, prospective Paper-only source fields. A UI snapshot alone is
  // never settlement authority; the durable server-owned order receipt must
  // independently attest every component before capital can compound.
  estimatedTaxPercent?: number | null;
  settlementFxKrwPerQuoteCurrency?: number | null;
  settlementFxSource?: string | null;
  settlementFxObservedAt?: string | null;
  correlatedExposurePercent?: number | null;
  signalState?: TradingSignalState | null;
  signalObservedAt?: string | null;
};

export type TradingEconomics = {
  sampleSize: number;
  winProbability: number;
  averageWinR: number;
  averageLossR: number;
  estimatedCostsR: number;
  profitFactor?: number | null;
  maxDrawdownPercent?: number | null;
  marketRegime: TradingMarketRegime;
  calibratedAt: string;
};

export type TradingPlanInput = {
  exchange: TradingExchange;
  accountMode: TradingAccountMode;
  stockBroker?: StockBroker | null;
  stockExchange?: 'KRX' | 'NXT' | 'SOR' | 'NASDAQ' | 'NYSE' | 'AMEX' | null;
  strategyId: string;
  signalId: string;
  /** Server-owned signal occurrence identity. Repeated reads of one occurrence
   * stay idempotent; a later validated occurrence may re-enter after risk gates. */
  signalOccurrenceId?: string | null;
  symbol: string;
  market: string;
  side: TradingSide;
  orderType: TradingOrderType;
  quantity?: number | null;
  quoteAmount?: number | null;
  limitPrice?: number | null;
  estimatedKrw: number;
  stopPrice: number;
  targetPrices: number[];
  splitRatios: number[];
  leverage?: number | null;
  marginMode?: 'crossed' | 'isolated' | null;
  reduceOnly?: boolean;
  invalidateAction?: 'hold' | 'reduce' | 'close';
  signalReasons: string[];
  marketSnapshot: TradingMarketSnapshot;
  entryPrice?: number | null;
  entryZoneLow?: number | null;
  entryZoneHigh?: number | null;
  estimatedSlippagePercent?: number | null;
  averageSpreadPercent?: number | null;
  economics?: TradingEconomics | null;
};

export type TradingOptimizationAssessment = {
  allowed: boolean;
  blockCodes: string[];
  warnings: string[];
  expectedValueR: number | null;
  riskBudgetKrw: number | null;
  maximumOrderKrw: number | null;
  stopDistancePercent: number | null;
  pilotStage: TradingPilotStage;
};

export type TradingRiskEnvelope = {
  version: 1;
  investmentKrw: number;
  maxLossKrw: number;
  maxSlippagePercent: number;
  maxSplitCount: number;
  allowCancelUnfilled: boolean;
  stopMethod: 'fixed_stop';
  emergencyExitScope: 'cancel_unfilled_and_reduce_only';
  approvedAt: string;
  expiresAt: string;
};

export type TradingPlan = TradingPlanInput & {
  executionMode?: 'manual' | 'automatic';
  id: string;
  userId: string;
  idempotencyKey: string;
  state: TradingOrderState;
  version?: number;
  approvalExpiresAt: string | null;
  approvedAt: string | null;
  legs?: TradingOrderLeg[];
  createdAt: string;
  updatedAt: string;
  riskAssessment?: TradingOptimizationAssessment | null;
  riskEnvelope?: TradingRiskEnvelope | null;
};

export type TradingRiskDecision = {
  allowed: boolean;
  blockCodes: string[];
  warnings: string[];
  optimization?: TradingOptimizationAssessment;
};

export type TradingOrder = {
  id: string;
  userId: string;
  planId: string;
  exchange: TradingExchange;
  stockBroker?: StockBroker | null;
  clientOrderId: string;
  exchangeOrderId: string | null;
  state: TradingOrderState;
  version?: number;
  requestedQuantity: number | null;
  remainingQuantity?: number | null;
  currentLimitPrice?: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  fills?: TradingFill[];
  feeAmount?: number | null;
  feeCurrency?: string | null;
  /** Optional durable, explicit simulated-paper tax. Missing is NOT zero. */
  taxAmount?: number | null;
  taxCurrency?: string | null;
  /** Bound per-fill FX from a verified server quote, not UI market snapshots. */
  settlementFxEvidence?: {
    krwPerQuoteCurrency: number;
    source: string;
    observedAt: string;
  } | null;
  /**
   * Server-certified completed funding ledger for a closed simulated USDT
   * perpetual. Absence is unknown funding, never an assumed zero. Positive
   * netFundingKrw is a paid funding cost; negative means received funding.
   * No public order/HTTP API may independently issue this certificate.
   */
  paperFundingSettlementEvidence?: {
    source: 'SERVER_PAPER_FUNDING_LEDGER_V1';
    underlyingCurrency: 'USDT';
    netFundingKrw: number;
    entryBrokerOrderId: string;
    exitBrokerOrderId: string;
    coveredFromAt: string;
    coveredThroughAt: string;
    attestedAt: string;
    complete: true;
    eventCount: number;
    eventDigest: string;
  } | null;
  exchangeCreatedAt?: string | null;
  exchangeUpdatedAt?: string | null;
  cancelable?: boolean | null;
  providerStatusCode?: string | null;
  retryCount: number;
  nextRetryAt?: string | null;
  lastReconciledAt?: string | null;
  lastErrorCode: string | null;
  manualReviewRequired?: boolean;
  executionClaimId?: string | null;
  submissionStartedAt?: string | null;
  submissionAttemptId?: string | null;
  approvedPlanVersion?: number | null;
  preSubmissionCheckedAt?: string | null;
  preSubmissionDecision?: TradingRiskDecision | null;
  preSubmissionSnapshot?: TradingMarketSnapshot | null;
  cancelRequestedAt?: string | null;
  cancelRequestClaimId?: string | null;
  cancelSubmittedAt?: string | null;
  cancelAcknowledgedAt?: string | null;
  cancelOperationId?: string | null;
  recoveryLeaseOwner?: string | null;
  recoveryLeaseUntil?: string | null;
  protectionStatus?: TradingProtectionStatus;
  protectionErrorCode?: string | null;
  amendments?: TradingOrderAmendment[];
  lastAmendRequestId?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TradingOrderEvent = {
  id: string;
  userId: string;
  orderId: string;
  fromState: TradingOrderState | null;
  toState: TradingOrderState;
  reason: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type TradingExchangeOrderSnapshot = {
  exchangeOrderId: string | null;
  state: Exclude<TradingOrderState, 'PLANNED' | 'APPROVAL_PENDING' | 'SUBMITTED' | 'EXPIRED'>;
  requestedQuantity: number | null;
  filledQuantity: number;
  remainingQuantity: number | null;
  averageFillPrice: number | null;
  fills: TradingFill[];
  feeAmount: number | null;
  feeCurrency: string | null;
  exchangeCreatedAt: string | null;
  exchangeUpdatedAt: string | null;
  cancelable: boolean | null;
  providerStatusCode: string | null;
};

export type StoredTradingState = {
  policy: TradingPolicy;
  connections: ExchangeConnection[];
  plans: TradingPlan[];
  orders: TradingOrder[];
  events: TradingOrderEvent[];
};
