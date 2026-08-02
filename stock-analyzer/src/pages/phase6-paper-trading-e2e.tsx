import { PaperTradingPanel } from '@/components/paper-trading-panel';
import type { FuturesContractRules, FuturesMarketSnapshot, NormalizedCandle } from '@/lib/futures-market-data';
import type { PaperFill, PaperJournalEntry, PaperOrder, PaperPosition, PaperTradingAction, PaperTradingActionResult, PaperTradingState } from '@/lib/paper-trading';

const NOW = '2026-08-02T02:30:00.000Z';
const snapshot: FuturesMarketSnapshot = {
  symbol: 'BTCUSDT', price: 100_000, markPrice: 100_000, indexPrice: 99_950, change24hPercent: 1.2,
  volume24h: 1000, quoteVolume24h: 100_000_000, bidPrice: 99_990, askPrice: 100_010, spreadPercent: 0.02,
  openInterest: 100, previousOpenInterest: 90, openInterestChangePercent: 11.1, fundingRate: 0.0001,
  nextFundingAt: '2026-08-02T08:00:00.000Z', basis: 50, basisPercent: 0.05, source: 'fixture',
  status: 'live', isDelayed: false, updatedAt: NOW, warnings: [],
};
const rules: FuturesContractRules = {
  symbol: 'BTCUSDT', source: 'bitget', quantityStep: 0.001, minimumQuantity: 0.001, minimumNotional: 5,
  quantityPrecision: 3, pricePrecision: 1, priceStep: 0.1, minimumLeverage: 1, maximumLeverage: 10,
  maintenanceMarginRate: 0.005, contractSize: null, status: 'live', updatedAt: NOW, warnings: [],
};

function clone(state: PaperTradingState): PaperTradingState { return structuredClone(state); }
function result(state: PaperTradingState, extras: Partial<PaperTradingActionResult> = {}): PaperTradingActionResult {
  return { ok: true, mode: 'paper-only', orderSubmitted: false, exchangeRequestSent: false, state, order: null, position: null, fills: [], warnings: [], duplicateEvent: false, ...extras };
}

async function execute(input: PaperTradingState, action: PaperTradingAction): Promise<PaperTradingActionResult> {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const state = clone(input);
  if (state.processedEventIds.includes(action.eventId)) return result(state, { duplicateEvent: true, warnings: ['이미 처리된 이벤트입니다.'] });
  state.processedEventIds.push(action.eventId);
  state.updatedAt = NOW;

  if (action.type === 'place_order') {
    const id = `order-${state.orders.length + 1}`;
    const pending = action.request.orderType !== 'market';
    const quantity = action.request.quantity ?? 0.01;
    const order: PaperOrder = {
      id, symbol: action.request.symbol, side: action.request.side, orderType: action.request.orderType,
      status: pending ? 'pending' : 'filled', requestedPrice: action.request.requestedPrice ?? null,
      triggerPrice: action.request.triggerPrice ?? null, quantity, leverage: action.request.leverage,
      stopLossPrice: action.request.stopLossPrice, takeProfitPrice1: action.request.takeProfitPrice1 ?? null,
      takeProfitPrice2: action.request.takeProfitPrice2 ?? null, submittedAt: NOW, filledAt: pending ? null : NOW,
      cancelledAt: null, rejectionCodes: [], warnings: [], mode: 'paper-only', orderSubmitted: false,
      exchangeRequestSent: false, riskResult: { allowed: true, blockCodes: [], warnings: [], maximumRiskAmount: 50,
        recommendedQuantity: quantity, notionalValue: quantity * 100_010, requiredMargin: quantity * 100_010 / action.request.leverage,
        estimatedMaximumLoss: 50, riskReward1: 2, estimatedLiquidationPrice: 50_000 } as any,
    };
    state.orders.push(order);
    if (pending) return result(state, { order });
    const position: PaperPosition = {
      id: `position-${state.positions.length + 1}`, orderId: id, symbol: order.symbol, side: order.side,
      entryPrice: order.side === 'long' ? 100_060 : 99_940, currentPrice: 100_000, quantity, remainingQuantity: quantity,
      leverage: order.leverage, notionalValue: quantity * 100_000, requiredMargin: quantity * 100_000 / order.leverage,
      stopLossPrice: order.stopLossPrice, takeProfitPrice1: order.takeProfitPrice1, takeProfitPrice2: order.takeProfitPrice2,
      unrealizedPnl: -0.6, realizedPnl: -0.6, totalFees: 0.6, totalSlippage: 0.5, totalFunding: 0,
      openedAt: NOW, closedAt: null, status: 'open', warnings: [],
    };
    const fill: PaperFill = { id: `fill-${state.fills.length + 1}`, orderId: id, positionId: position.id,
      price: position.entryPrice, quantity, grossValue: position.entryPrice * quantity, fee: 0.6, slippageCost: 0.5,
      fundingCost: 0, filledAt: NOW, fillReason: 'market', side: order.side, referencePrice: 100_010, grossPnl: 0, netPnl: -1.1 };
    state.positions.push(position); state.fills.push(fill); state.account.cashBalance -= fill.fee; state.account.realizedPnl -= fill.fee;
    state.account.usedMargin = position.requiredMargin; state.account.availableMargin = state.account.equity - state.account.usedMargin;
    return result(state, { order, position, fills: [fill] });
  }

  if (action.type === 'cancel_order') {
    const order = state.orders.find((item) => item.id === action.orderId)!; order.status = 'cancelled'; order.cancelledAt = NOW;
    return result(state, { order });
  }

  if (action.type === 'mark_price') {
    for (const position of state.positions.filter((item) => item.status !== 'closed' && item.symbol === action.symbol)) {
      position.currentPrice = action.price; position.unrealizedPnl = position.side === 'long' ? (action.price-position.entryPrice)*position.remainingQuantity : (position.entryPrice-action.price)*position.remainingQuantity;
    }
    state.account.unrealizedPnl = state.positions.reduce((sum, item) => sum + item.unrealizedPnl, 0); state.account.equity = state.account.cashBalance + state.account.unrealizedPnl;
    return result(state);
  }

  if (action.type === 'process_candle') {
    const order = state.orders.find((item) => item.status === 'pending');
    if (order) { order.status = 'filled'; order.filledAt = NOW; }
    return result(state, { order: order ?? null });
  }

  const position = state.positions.find((item) => item.id === action.positionId)!;
  const percentage = action.percentage ?? 100;
  const closeQuantity = percentage === 100 ? position.remainingQuantity : position.remainingQuantity * percentage / 100;
  position.remainingQuantity = Math.max(0, position.remainingQuantity - closeQuantity);
  position.status = position.remainingQuantity <= 1e-9 ? 'closed' : 'partially_closed';
  position.realizedPnl += closeQuantity * 100; position.unrealizedPnl = 0;
  if (position.status === 'closed') position.closedAt = NOW;
  const fill: PaperFill = { id: `fill-${state.fills.length + 1}`, orderId: position.orderId, positionId: position.id,
    price: 101_000, quantity: closeQuantity, grossValue: 101_000 * closeQuantity, fee: 0.4, slippageCost: 0.2,
    fundingCost: 0, filledAt: NOW, fillReason: position.status === 'closed' ? 'manual_close' : 'partial_close',
    side: position.side, referencePrice: 101_000, grossPnl: closeQuantity * 100, netPnl: closeQuantity * 99.4 };
  state.fills.push(fill); state.account.cashBalance += fill.netPnl; state.account.realizedPnl += fill.netPnl;
  state.account.usedMargin = position.status === 'closed' ? 0 : position.requiredMargin * position.remainingQuantity / position.quantity;
  state.account.availableMargin = state.account.equity - state.account.usedMargin;
  let journal = state.journal.find((item) => item.positionId === position.id);
  if (!journal) {
    journal = { id: `journal-${state.journal.length + 1}`, tradeId: position.id, orderId: position.orderId, positionId: position.id,
      symbol: position.symbol, side: position.side, orderType: 'market', strategyName: 'manual', submittedAt: NOW, filledAt: NOW,
      closedAt: position.closedAt, entryPrice: position.entryPrice, stopLossPrice: position.stopLossPrice,
      takeProfitPrice1: position.takeProfitPrice1 ?? null, takeProfitPrice2: position.takeProfitPrice2 ?? null,
      exitPrice: fill.price, initialQuantity: position.quantity, closedQuantity: closeQuantity, remainingQuantity: position.remainingQuantity,
      leverage: position.leverage, notionalValue: position.notionalValue, requiredMargin: position.requiredMargin,
      entryFee: 0.6, exitFee: fill.fee, slippageCost: 0.7, fundingCost: 0, grossPnl: fill.grossPnl, netPnl: fill.netPnl,
      rMultiple: 1.2, exitReason: fill.fillReason, dataStatusAtEntry: 'live', marketRegimeAtEntry: 'manual', riskBlocked: false,
      warnings: [], ruleViolation: false, status: position.status, note: '' } as PaperJournalEntry;
    state.journal.push(journal);
  } else { journal.closedQuantity += closeQuantity; journal.remainingQuantity = position.remainingQuantity; journal.status = position.status; journal.closedAt = position.closedAt; journal.netPnl += fill.netPnl; journal.exitFee += fill.fee; }
  return result(state, { position, fills: [fill] });
}

const candle: NormalizedCandle = { timestamp: Date.parse('2026-08-02T02:45:00Z'), open: 99_000, high: 101_000, low: 98_000, close: 100_000, volume: 100,
  quoteVolume: 10_000_000, timeframe: '15m', symbol: 'BTCUSDT', market: 'crypto-futures', source: 'fixture', isClosed: true, isDelayed: false, updatedAt: NOW };

export default function Phase6PaperTradingE2EPage() {
  return <PaperTradingPanel compact execute={execute} loadMarket={async () => snapshot} loadRules={async () => rules} loadCandle={async () => candle} />;
}
