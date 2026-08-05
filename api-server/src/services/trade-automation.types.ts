export type TradingExchange = 'bitget' | 'upbit' | 'kiwoom';
export type TradingMode = 'approval' | 'automatic';
export type TradingAccountMode = 'paper' | 'mock' | 'live';
export type TradingSide = 'buy' | 'sell' | 'long' | 'short';
export type TradingOrderType = 'market' | 'limit';
export type TradingMarketRegime = 'bull' | 'bear' | 'sideways' | 'stress' | 'unknown';
export type TradingPilotStage = 'approval-20' | 'limited-50' | 'validated';

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

export type TradingSignalState =
  | 'WATCHING'
  | 'READY_FOR_APPROVAL'
  | 'WEAKENED'
  | 'INVALIDATED'
  | 'EXPIRED';

export type TradingSignalStateEvent = {
  fromState: TradingSignalState | null;
  toState: TradingSignalState;
  reason: string;
  score: number;
  confidence: number;
  coreConditionsMaintained: boolean;
  riskReward: number | null;
  dataTimestamp: string;
  createdAt: string;
};

export type TradingSignalValidationInput = {
  score: number;
  confidence: number;
  coreConditionsMaintained: boolean;
  riskReward?: number | null;
  reasons?: string[];
  warnings?: string[];
  dataTimestamp: string;
  invalidationReason?: string | null;
  marketSnapshot?: TradingMarketSnapshot;
};

export type TradingApprovalStatus = {
  approvalEnabled: boolean;
  signalState: TradingSignalState;
  planState: TradingOrderState;
  reasonCode: string | null;
  expiresAt: string | null;
  lastValidatedAt: string;
};

export type ScannerPlanContext = {
  market: 'KR';
  timeframe: string;
  selectedConditions: string[];
  volumeThreshold: number | null;
  tradingValueThreshold: number | null;
  marketCapThreshold: number | null;
  volumeLookbackDays: number;
  tradingValueLookbackDays: number;
  minimumScore: number;
  minimumConfidence: number;
  maximumRiskScore: number;
  maxEntryDriftPercent: number;
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
  riskOptimizationEnabled: true,
  pilotStage: 'approval-20' as TradingPilotStage,
  riskPerTradePercent: { bitget: 0.1, upbit: 0.2, kiwoom: 0.25 },
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
  currentPrice?: number | null;
  correlatedExposurePercent?: number | null;
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
  signalWarnings?: string[];
  signalScore?: number;
  signalConfidence?: number;
  minimumSignalScore?: number;
  minimumSignalConfidence?: number;
  minimumRiskReward?: number;
  signalRiskReward?: number | null;
  signalCoreConditionsMaintained?: boolean;
  signalExpiresAt?: string | null;
  scannerContext?: ScannerPlanContext | null;
  marketSnapshot: TradingMarketSnapshot;
  signalState?: TradingSignalState | null;
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

export type TradingPlan = TradingPlanInput & {
  id: string;
  userId: string;
  idempotencyKey: string;
  state: TradingOrderState;
  approvalExpiresAt: string | null;
  approvedAt: string | null;
  signalState: TradingSignalState;
  signalScore: number;
  signalConfidence: number;
  minimumSignalScore: number;
  minimumSignalConfidence: number;
  minimumRiskReward: number;
  signalRiskReward: number | null;
  signalCoreConditionsMaintained: boolean;
  signalExpiresAt: string;
  lastSignalValidatedAt: string;
  signalWarnings: string[];
  signalInvalidationReason: string | null;
  signalStateHistory: TradingSignalStateEvent[];
  createdAt: string;
  updatedAt: string;
  riskAssessment?: TradingOptimizationAssessment | null;
};

export type TradingPlanRevalidationInput = Partial<Pick<TradingPlanInput,
  | 'marketSnapshot'
  | 'signalExpiresAt'
  | 'entryPrice'
  | 'entryZoneLow'
  | 'entryZoneHigh'
  | 'estimatedSlippagePercent'
  | 'averageSpreadPercent'
  | 'economics'
>> & {
  signalValidation?: TradingSignalValidationInput;
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
  optimization?: TradingOptimizationAssessment;
};

export type StoredTradingState = {
  policy: TradingPolicy;
  connections: ExchangeConnection[];
  plans: TradingPlan[];
  orders: TradingOrder[];
  events: TradingOrderEvent[];
};
