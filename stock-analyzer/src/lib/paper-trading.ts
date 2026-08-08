import { authorizedFetch } from '@/lib/auth-fetch';
import { apiGet } from '@/lib/api';
import type { DataStatus, FuturesContractRules, FuturesMarketSnapshot, NormalizedCandle } from '@/lib/futures-market-data';
import type { RiskEngineInput, RiskEngineResult } from '@/lib/trading-risk';

export type PaperSide = 'long' | 'short';
export type PaperOrderType = 'market' | 'limit' | 'stop_market';
export type PaperOrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected' | 'expired';
export type PaperPositionStatus = 'open' | 'partially_closed' | 'closed';
export type PaperFillReason = 'market' | 'limit' | 'stop_trigger' | 'stop_loss' | 'take_profit' | 'partial_close' | 'manual_close';

export type PaperAccount = {
  id: string; initialBalance: number; cashBalance: number; realizedPnl: number; unrealizedPnl: number;
  equity: number; usedMargin: number; availableMargin: number; createdAt: string; updatedAt: string;
};

export type PaperOrder = {
  id: string; symbol: string; side: PaperSide; orderType: PaperOrderType; status: PaperOrderStatus;
  requestedPrice: number | null; triggerPrice: number | null; quantity: number; leverage: number;
  stopLossPrice: number; takeProfitPrice1?: number | null; takeProfitPrice2?: number | null;
  submittedAt: string; filledAt: string | null; cancelledAt: string | null; rejectionCodes: string[]; warnings: string[];
  mode: 'paper-only'; orderSubmitted: false; exchangeRequestSent: false; riskResult: RiskEngineResult | null;
};

export type PaperPosition = {
  id: string; orderId: string; symbol: string; side: PaperSide; entryPrice: number; currentPrice: number;
  quantity: number; remainingQuantity: number; leverage: number; notionalValue: number; requiredMargin: number;
  stopLossPrice: number; takeProfitPrice1?: number | null; takeProfitPrice2?: number | null;
  unrealizedPnl: number; realizedPnl: number; totalFees: number; totalSlippage: number; totalFunding: number;
  openedAt: string; closedAt: string | null; status: PaperPositionStatus; warnings: string[];
};

export type PaperFill = {
  id: string; orderId: string; positionId: string; price: number; quantity: number; grossValue: number;
  fee: number; slippageCost: number; fundingCost: number; filledAt: string; fillReason: PaperFillReason;
  side: PaperSide; referencePrice: number; grossPnl: number; netPnl: number;
};

export type PaperJournalEntry = {
  id: string; tradeId: string; orderId: string; positionId: string; symbol: string; side: PaperSide;
  orderType: PaperOrderType; strategyName: string; submittedAt: string; filledAt: string; closedAt: string | null;
  entryPrice: number; stopLossPrice: number; takeProfitPrice1: number | null; takeProfitPrice2: number | null;
  exitPrice: number | null; initialQuantity: number; closedQuantity: number; remainingQuantity: number; leverage: number;
  notionalValue: number; requiredMargin: number; entryFee: number; exitFee: number; slippageCost: number;
  fundingCost: number; grossPnl: number; netPnl: number; rMultiple: number | null; exitReason: PaperFillReason | null;
  dataStatusAtEntry: DataStatus; marketRegimeAtEntry: string; riskBlocked: boolean; warnings: string[];
  ruleViolation: boolean; status: PaperPositionStatus; note: string;
};

export type PaperTradingState = {
  schemaVersion: 1;
  account: PaperAccount;
  orders: PaperOrder[];
  positions: PaperPosition[];
  fills: PaperFill[];
  journal: PaperJournalEntry[];
  riskState: { dayKey: string; weekKey: string; dailyRealizedPnl: number; weeklyRealizedPnl: number; consecutiveLosses: number };
  processedEventIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type PaperOrderRequest = {
  symbol: string; side: PaperSide; orderType: PaperOrderType; requestedPrice?: number | null; triggerPrice?: number | null;
  quantity?: number | null; leverage: number; stopLossPrice: number; takeProfitPrice1?: number | null;
  takeProfitPrice2?: number | null; targetClosePercent1?: number | null; targetClosePercent2?: number | null;
  strategyName?: string | null; marketRegime?: string | null;
};

export type PaperTradingAction =
  | { type: 'place_order'; eventId: string; request: PaperOrderRequest; market: FuturesMarketSnapshot; contractRules: FuturesContractRules; riskInput: RiskEngineInput }
  | { type: 'cancel_order'; eventId: string; orderId: string; at?: string }
  | { type: 'process_candle'; eventId: string; candle: Pick<NormalizedCandle, 'symbol'|'timestamp'|'open'|'high'|'low'|'close'|'isClosed'>; market?: FuturesMarketSnapshot | null }
  | { type: 'mark_price'; eventId: string; symbol: string; price: number; at?: string }
  | { type: 'close_position'; eventId: string; positionId: string; quantity?: number | null; percentage?: 25|50|75|100|null; market: FuturesMarketSnapshot; reason?: 'partial_close'|'manual_close'; at?: string };

export type PaperTradingActionResult = {
  ok: true; mode: 'paper-only'; orderSubmitted: false; exchangeRequestSent: false; state: PaperTradingState;
  order: PaperOrder | null; position: PaperPosition | null; fills: PaperFill[]; warnings: string[]; duplicateEvent: boolean;
};

type PaperEvaluateResponse = {
  ok: boolean; mode: 'paper-only'; orderSubmitted: false; exchangeRequestSent: false;
  result?: PaperTradingActionResult; code?: string; message?: string;
};

export async function evaluatePaperTrading(state: PaperTradingState, action: PaperTradingAction, signal?: AbortSignal) {
  const response = await authorizedFetch('/api/paper-trading/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, action }), signal,
  });
  const body = await response.json().catch(() => null) as PaperEvaluateResponse | null;
  if (!body || body.mode !== 'paper-only' || body.orderSubmitted !== false || body.exchangeRequestSent !== false) {
    throw new Error('모의거래 안전 계약을 확인하지 못했습니다.');
  }
  if (!response.ok || !body.ok || !body.result) throw new Error(body.message ?? body.code ?? '모의거래 계산을 처리하지 못했습니다.');
  return body.result;
}

export async function getLatestCompletedCandle(symbol: string, timeframe = '15m') {
  const response = await apiGet<{ ok: true; data: NormalizedCandle[] }>(`/crypto/futures/${encodeURIComponent(symbol)}/candles?timeframe=${encodeURIComponent(timeframe)}&limit=3`);
  const completed = response.data.filter((item) => item.isClosed).sort((a, b) => a.timestamp - b.timestamp);
  return completed.at(-1) ?? null;
}

export {
  PAPER_STORAGE_KEY, PAPER_STORAGE_SCHEMA_VERSION, PAPER_STORAGE_LIMITS,
  createLocalPaperState, validatePaperState, repairPaperState, savePaperState, loadPaperState,
  exportPaperState, importPaperState, clearPaperState,
  type StorageLike, type PaperStorageEnvelope,
} from './paper-trading-storage';

export type PaperStatistics = {
  totalTrades: number; wins: number; losses: number; winRate: number; averageProfit: number; averageLoss: number;
  expectancy: number; averageR: number; profitFactor: number | null; maximumConsecutiveWins: number;
  maximumConsecutiveLosses: number; cumulativeNetPnl: number; totalFees: number; totalSlippage: number; totalFunding: number;
};

export function calculatePaperStatistics(journal: readonly PaperJournalEntry[]): PaperStatistics {
  const entries = journal.filter((item) => item.status === 'closed');
  const profits = entries.filter((item) => item.netPnl > 0);
  const losses = entries.filter((item) => item.netPnl < 0);
  const grossProfit = profits.reduce((sum, item) => sum + item.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, item) => sum + item.netPnl, 0));
  let wins = 0; let lossCount = 0; let maxWins = 0; let maxLosses = 0;
  for (const item of [...entries].sort((a, b) => Date.parse(a.closedAt ?? a.filledAt) - Date.parse(b.closedAt ?? b.filledAt))) {
    if (item.netPnl > 0) { wins += 1; lossCount = 0; }
    else if (item.netPnl < 0) { lossCount += 1; wins = 0; }
    else { wins = 0; lossCount = 0; }
    maxWins = Math.max(maxWins, wins); maxLosses = Math.max(maxLosses, lossCount);
  }
  const total = entries.length;
  const net = entries.reduce((sum, item) => sum + item.netPnl, 0);
  return {
    totalTrades: total, wins: profits.length, losses: losses.length, winRate: total ? profits.length / total * 100 : 0,
    averageProfit: profits.length ? grossProfit / profits.length : 0, averageLoss: losses.length ? -grossLoss / losses.length : 0,
    expectancy: total ? net / total : 0, averageR: total ? entries.reduce((sum, item) => sum + (item.rMultiple ?? 0), 0) / total : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null, maximumConsecutiveWins: maxWins, maximumConsecutiveLosses: maxLosses,
    cumulativeNetPnl: net, totalFees: entries.reduce((sum, item) => sum + item.entryFee + item.exitFee, 0),
    totalSlippage: entries.reduce((sum, item) => sum + item.slippageCost, 0), totalFunding: entries.reduce((sum, item) => sum + item.fundingCost, 0),
  };
}
