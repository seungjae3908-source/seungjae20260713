import type { ScannerTradingSignal } from './scanner-approval.types';

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
  scannerSignal?: ScannerTradingSignal | null;
  scannerApprovedTotalKrw?: number | null;
  scannerEntryLegSequence?: 1 | 2 | 3 | null;
  scannerParentPlanId?: string | null;
  approvalNonce?: string | null;
};

export type TradingPlan = TradingPlanInput & {
  id: string;
  userId: string;
  idempotencyKey: string;
  state: TradingOrderState;
  approvalExpiresAt: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TradingOrder = {
  id: string;
  userId: string;
  planId: string;
  exchange: TradingExchange;
  clientOrderId: string;
  exchangeOrderId: string | null;
  state: TradingOrderState;
  requestedQuantity: number | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  retryCount: number;
  lastErrorCode: string | null;
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

export type TradingRiskDecision = {
  allowed: boolean;
  blockCodes: string[];
  warnings: string[];
};

export type StoredTradingState = {
  policy: TradingPolicy;
  connections: ExchangeConnection[];
  plans: TradingPlan[];
  orders: TradingOrder[];
  events: TradingOrderEvent[];
};
