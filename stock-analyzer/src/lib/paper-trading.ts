import { authorizedFetch } from '@/lib/auth-fetch';
import { apiGet } from '@/lib/api';
import { getFuturesMarketSnapshot, type DataStatus, type FuturesContractRules, type FuturesMarketSnapshot, type NormalizedCandle } from '@/lib/futures-market-data';
import type { RiskEngineInput, RiskEngineResult } from '@/lib/trading-risk';
import { validPaperActionResult, validPaperState } from '../../../packages/api-zod/src/paper-state-evidence.js';

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
  conflictCopyOf?: string; researchEvidenceEligible?: false;
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

export type PaperStateTransport = {
  status: 'PUBLISHED' | 'BLOCKED_DATA';
  reason: string | null;
  publisherAccountBound: boolean;
  executionAuthority: 'NONE';
  privateApiAllowed: false;
  liveTrading: false;
  financialMutationAllowed: false;
};

export type PaperTradingActionResult = {
  ok: true; mode: 'paper-only'; orderSubmitted: false; exchangeRequestSent: false; state: PaperTradingState;
  order: PaperOrder | null; position: PaperPosition | null; fills: PaperFill[]; warnings: string[]; duplicateEvent: boolean;
  paperStateTransport?: PaperStateTransport | null;
};

type PaperEvaluateResponse = {
  ok: boolean; mode: 'paper-only'; orderSubmitted: false; exchangeRequestSent: false;
  result?: PaperTradingActionResult; paperStateTransport?: unknown; code?: string; message?: string;
};

export async function resolvePaperTradingActionMarket(
  state: PaperTradingState,
  action: PaperTradingAction,
  loadMarket: (symbol: string) => Promise<FuturesMarketSnapshot> = getFuturesMarketSnapshot,
): Promise<PaperTradingAction> {
  if (action.type !== 'close_position') return action;
  const position = state.positions.find((item) => item.id === action.positionId);
  if (!position) return action;
  const market = await loadMarket(position.symbol);
  return { ...action, market };
}

export function normalizePaperStateTransport(value: unknown): PaperStateTransport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<PaperStateTransport>;
  if ((candidate.status !== 'PUBLISHED' && candidate.status !== 'BLOCKED_DATA')
    || candidate.executionAuthority !== 'NONE'
    || candidate.privateApiAllowed !== false
    || candidate.liveTrading !== false
    || candidate.financialMutationAllowed !== false
    || typeof candidate.publisherAccountBound !== 'boolean'
    || !(candidate.reason == null || typeof candidate.reason === 'string')) return null;
  return {
    status: candidate.status,
    reason: candidate.reason ?? null,
    publisherAccountBound: candidate.publisherAccountBound,
    executionAuthority: 'NONE',
    privateApiAllowed: false,
    liveTrading: false,
    financialMutationAllowed: false,
  };
}

export function paperStateTransportNotice(transport: PaperStateTransport | null) {
  if (!transport) return 'Natural Paper 스냅샷: UNKNOWN';
  if (transport.status === 'PUBLISHED') return 'Natural Paper 스냅샷: PUBLISHED';
  return `Natural Paper 스냅샷: BLOCKED_DATA${transport.reason ? ` (${transport.reason})` : ''}`;
}

export async function evaluatePaperTrading(state: PaperTradingState, action: PaperTradingAction, signal?: AbortSignal) {
  if (!validPaperState(state, Date.now())) throw new Error('모의거래 입력 기록의 근거를 확인하지 못했습니다.');
  const resolvedAction = await resolvePaperTradingActionMarket(state, action);
  signal?.throwIfAborted();
  const response = await authorizedFetch('/api/paper-trading/evaluate', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state, action: resolvedAction }), signal,
  });
  const body = await response.json().catch(() => null) as PaperEvaluateResponse | null;
  if (!body || body.mode !== 'paper-only' || body.orderSubmitted !== false || body.exchangeRequestSent !== false) {
    throw new Error('모의거래 안전 계약을 확인하지 못했습니다.');
  }
  if (!response.ok || body.ok !== true || !body.result) throw new Error(body.message ?? body.code ?? '모의거래 계산을 처리하지 못했습니다.');
  if (!validPaperActionResult(body.result, state, action.eventId, Date.now())) throw new Error('모의거래 결과의 기록·식별자·수치 근거를 확인하지 못했습니다.');
  const paperStateTransport = normalizePaperStateTransport(body.paperStateTransport);
  const transportNotice = paperStateTransportNotice(paperStateTransport);
  return {
    ...body.result,
    warnings: [...body.result.warnings.filter((item) => !item.startsWith('Natural Paper 스냅샷:')), transportNotice],
    paperStateTransport,
  };
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

export { calculatePaperStatistics, type PaperStatistics } from './paper-statistics';
