export type TradingExchange = 'bitget' | 'upbit' | 'kiwoom';
export type TradingMode = 'approval' | 'automatic';
export type TradingAccountMode = 'paper' | 'mock' | 'live';
export type TradingSide = 'buy' | 'sell' | 'long' | 'short';
export type TradingOrderType = 'market' | 'limit';

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

export const DEFAULT_TRADING_POLICY = Object.freeze({
  mode: 'approval' as TradingMode,
  automaticEnabled: false,
  emergencyStopped: false,
  exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
  enabledAssets: { bitget: [] as string[], upbit: [] as string[], kiwoom: [] as string[] },
  enabledStrategies: [] as string[],
  totalCapitalKrw: 1_000_000,
  maxOrderKrw: 1_000_000,
  dailyLossLimitPercent: 5,
  maxAssetPercent: 30,
  maxOpenPositions: 5,
  maxDailyOrders: 10,
  maxConsecutiveLosses: 3,
  bitgetLeverage: 2 as 2 | 3,
});

export type TradingPolicy = {
  mode: TradingMode;
  automaticEnabled: boolean;
  emergencyStopped: boolean;
  exchangeEnabled: Record<TradingExchange, boolean>;
  enabledAssets: Record<TradingExchange, string[]>;
  enabledStrategies: string[];
  totalCapitalKrw: number;
  maxOrderKrw: number;
  dailyLossLimitPercent: number;
  maxAssetPercent: number;
  maxOpenPositions: number;
  maxDailyOrders: number;
  maxConsecutiveLosses: number;
  bitgetLeverage: 2 | 3;
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
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type TradingMarketSnapshot = {
  observedAt: string;
  dataDelayMs: number;
  oneMinuteMovePercent: number;
  spreadPercent: number;
  orderbookGapPercent: number;
  halted: boolean;
  availableBalance: number;
  accountValueKrw: number;
  dailyPnlPercent: number;
  assetExposurePercent: number;
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
  signalState?: TradingSignalState | null;
  signalObservedAt?: string | null;
};

export type TradingPlanInput = {
  exchange: TradingExchange;
  accountMode: TradingAccountMode;
  strategyId: string;
  signalId: string;
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
};

export type TradingPlan = TradingPlanInput & {
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
};

export type TradingRiskDecision = {
  allowed: boolean;
  blockCodes: string[];
  warnings: string[];
};

export type TradingOrder = {
  id: string;
  userId: string;
  planId: string;
  exchange: TradingExchange;
  clientOrderId: string;
  exchangeOrderId: string | null;
  state: TradingOrderState;
  version?: number;
  requestedQuantity: number | null;
  remainingQuantity?: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  fills?: TradingFill[];
  feeAmount?: number | null;
  feeCurrency?: string | null;
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
  approvedPlanVersion?: number | null;
  preSubmissionCheckedAt?: string | null;
  preSubmissionDecision?: TradingRiskDecision | null;
  preSubmissionSnapshot?: TradingMarketSnapshot | null;
  cancelRequestedAt?: string | null;
  cancelRequestClaimId?: string | null;
  cancelSubmittedAt?: string | null;
  cancelAcknowledgedAt?: string | null;
  recoveryLeaseOwner?: string | null;
  recoveryLeaseUntil?: string | null;
  protectionStatus?: TradingProtectionStatus;
  protectionErrorCode?: string | null;
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