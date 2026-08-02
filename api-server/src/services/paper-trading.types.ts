import type { RiskDataStatus, RiskEngineInput, RiskEngineResult } from './trading-risk-engine.service';

export type PaperAccount = {
  id: string;
  initialBalance: number;
  cashBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  equity: number;
  usedMargin: number;
  availableMargin: number;
  createdAt: string;
  updatedAt: string;
};

export type PaperOrderType = 'market' | 'limit' | 'stop_market';
export type PaperOrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected' | 'expired';
export type PaperPositionStatus = 'open' | 'partially_closed' | 'closed';
export type PaperSide = 'long' | 'short';

export type PaperOrder = {
  id: string;
  symbol: string;
  side: PaperSide;
  orderType: PaperOrderType;
  status: PaperOrderStatus;
  requestedPrice: number | null;
  triggerPrice: number | null;
  quantity: number;
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice1?: number | null;
  takeProfitPrice2?: number | null;
  submittedAt: string;
  filledAt: string | null;
  cancelledAt: string | null;
  rejectionCodes: string[];
  warnings: string[];
  mode: 'paper-only';
  orderSubmitted: false;
  exchangeRequestSent: false;
  idempotencyKey: string;
  referencePrice: number | null;
  expectedFillPrice: number | null;
  riskResult: RiskEngineResult | null;
  entryFeeRate: number;
  exitFeeRate: number;
  slippageRate: number;
  fundingRatePerInterval: number;
  fundingIntervalHours: number;
  targetClosePercent1: number;
  targetClosePercent2: number;
  strategyName: string;
  dataStatusAtSubmission: RiskDataStatus;
  contractRulesStatusAtSubmission: RiskDataStatus;
  marketRegimeAtSubmission: string;
};

export type PaperPosition = {
  id: string;
  symbol: string;
  side: PaperSide;
  entryPrice: number;
  currentPrice: number;
  quantity: number;
  remainingQuantity: number;
  leverage: number;
  notionalValue: number;
  requiredMargin: number;
  stopLossPrice: number;
  takeProfitPrice1?: number | null;
  takeProfitPrice2?: number | null;
  unrealizedPnl: number;
  realizedPnl: number;
  totalFees: number;
  totalSlippage: number;
  totalFunding: number;
  openedAt: string;
  closedAt: string | null;
  status: PaperPositionStatus;
  orderId: string;
  entryReferencePrice: number;
  initialRequiredMargin: number;
  initialRiskAmount: number;
  entryFee: number;
  entrySlippageCost: number;
  exitFeeRate: number;
  slippageRate: number;
  fundingRatePerInterval: number;
  fundingIntervalHours: number;
  targetClosePercent1: number;
  targetClosePercent2: number;
  target1Executed: boolean;
  target2Executed: boolean;
  strategyName: string;
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  dataStatusAtEntry: RiskDataStatus;
  marketRegimeAtEntry: string;
  warnings: string[];
};

export type PaperFillReason =
  | 'market'
  | 'limit'
  | 'stop_trigger'
  | 'stop_loss'
  | 'take_profit'
  | 'partial_close'
  | 'manual_close';

export type PaperFill = {
  id: string;
  orderId: string;
  positionId: string;
  price: number;
  quantity: number;
  grossValue: number;
  fee: number;
  slippageCost: number;
  fundingCost: number;
  filledAt: string;
  fillReason: PaperFillReason;
  side: PaperSide;
  referencePrice: number;
  grossPnl: number;
  netPnl: number;
};

export type PaperJournalEntry = {
  id: string;
  tradeId: string;
  orderId: string;
  positionId: string;
  symbol: string;
  side: PaperSide;
  orderType: PaperOrderType;
  strategyName: string;
  submittedAt: string;
  filledAt: string;
  closedAt: string | null;
  entryPrice: number;
  entryReferencePrice: number;
  stopLossPrice: number;
  takeProfitPrice1: number | null;
  takeProfitPrice2: number | null;
  exitPrice: number | null;
  initialQuantity: number;
  closedQuantity: number;
  remainingQuantity: number;
  leverage: number;
  notionalValue: number;
  requiredMargin: number;
  entryFee: number;
  exitFee: number;
  slippageCost: number;
  fundingCost: number;
  grossPnl: number;
  netPnl: number;
  rMultiple: number | null;
  maximumFavorableExcursion: number;
  maximumAdverseExcursion: number;
  exitReason: PaperFillReason | null;
  dataStatusAtEntry: RiskDataStatus;
  marketRegimeAtEntry: string;
  riskBlocked: boolean;
  warnings: string[];
  ruleViolation: boolean;
  status: PaperPositionStatus;
  note: string;
};

export type PaperRiskState = {
  dayKey: string;
  weekKey: string;
  dailyRealizedPnl: number;
  weeklyRealizedPnl: number;
  consecutiveLosses: number;
};

export type PaperTradingState = {
  schemaVersion: 1;
  account: PaperAccount;
  orders: PaperOrder[];
  positions: PaperPosition[];
  fills: PaperFill[];
  journal: PaperJournalEntry[];
  riskState: PaperRiskState;
  processedEventIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type PaperMarketData = {
  symbol: string;
  price: number | null;
  lastPrice?: number | null;
  markPrice: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  fundingRate: number | null;
  status: RiskDataStatus;
  updatedAt: string;
  warnings?: string[];
};

export type PaperContractRules = {
  symbol: string;
  quantityStep: number | null;
  quantityPrecision: number | null;
  minimumQuantity: number | null;
  minimumNotional: number | null;
  maximumLeverage: number | null;
  maintenanceMarginRate: number | null;
  status: RiskDataStatus;
  updatedAt: string;
  warnings?: string[];
};

export type PaperCandle = {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  isClosed: boolean;
  status?: RiskDataStatus;
};

export type PaperOrderRequest = {
  symbol: string;
  side: PaperSide;
  orderType: PaperOrderType;
  requestedPrice?: number | null;
  triggerPrice?: number | null;
  quantity?: number | null;
  leverage: number;
  stopLossPrice: number;
  takeProfitPrice1?: number | null;
  takeProfitPrice2?: number | null;
  targetClosePercent1?: number | null;
  targetClosePercent2?: number | null;
  strategyName?: string | null;
  marketRegime?: string | null;
};

export type PlacePaperOrderAction = {
  type: 'place_order';
  eventId: string;
  request: PaperOrderRequest;
  market: PaperMarketData;
  contractRules: PaperContractRules;
  riskInput: RiskEngineInput;
};

export type CancelPaperOrderAction = {
  type: 'cancel_order';
  eventId: string;
  orderId: string;
  at?: string;
};

export type ProcessPaperCandleAction = {
  type: 'process_candle';
  eventId: string;
  candle: PaperCandle;
  market?: PaperMarketData | null;
};

export type MarkPaperPriceAction = {
  type: 'mark_price';
  eventId: string;
  symbol: string;
  price: number;
  at?: string;
};

export type ClosePaperPositionAction = {
  type: 'close_position';
  eventId: string;
  positionId: string;
  quantity?: number | null;
  percentage?: 25 | 50 | 75 | 100 | null;
  market: PaperMarketData;
  reason?: 'partial_close' | 'manual_close';
  at?: string;
};

export type PaperTradingAction =
  | PlacePaperOrderAction
  | CancelPaperOrderAction
  | ProcessPaperCandleAction
  | MarkPaperPriceAction
  | ClosePaperPositionAction;

export type PaperTradingActionResult = {
  ok: true;
  mode: 'paper-only';
  orderSubmitted: false;
  exchangeRequestSent: false;
  state: PaperTradingState;
  order: PaperOrder | null;
  position: PaperPosition | null;
  fills: PaperFill[];
  warnings: string[];
  duplicateEvent: boolean;
};

export type PaperTradingStatisticsGroup = {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netPnl: number;
};

export type PaperTradingStatistics = {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  expectancy: number;
  averageR: number;
  profitFactor: number | null;
  maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number;
  cumulativeNetPnl: number;
  totalFees: number;
  totalSlippage: number;
  totalFunding: number;
  bySide: PaperTradingStatisticsGroup[];
  bySymbol: PaperTradingStatisticsGroup[];
  byHour: PaperTradingStatisticsGroup[];
  byExitReason: PaperTradingStatisticsGroup[];
};
