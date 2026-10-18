/**
 * Manual real-money order ticket (종목 탭 주문창 / 호가 클릭 / 보유종목 매도·청산).
 *
 * The browser sends only what the owner typed. The server builds the complete
 * TradingPlanInput: broker routing from the owner's policy, a fresh exchange
 * snapshot (read-only provider calls, no order), FX, and loss-limit inputs from
 * the canonical journal. The plan is then created in APPROVAL mode and executes
 * only through the existing explicit approval call, so every existing gate still
 * applies: server live gate, per-market live switch, first-week cap, risk checks,
 * pre-submission re-check, emergency stop.
 */
import { randomUUID } from 'node:crypto';
import { buildUnifiedTradeJournal } from './unified-trade-journal.service';
import { readTradeAutomationJournalPayloads } from './trade-automation-unified-journal-adapter';
import type {
  TradingAssetClass,
  TradingExchange,
  TradingMarketSnapshot,
  TradingPlanInput,
  TradingPolicy,
  TradingSide,
} from './trade-automation.types';
import type { TradingRepository } from './trade-automation.repository';

export const MANUAL_ORDER_STRATEGY_ID = 'manual-order-ticket-v1';

export type ManualOrderAction = 'buy' | 'sell' | 'long' | 'short' | 'close_long' | 'close_short';

export type ManualLiveOrderRequest = {
  market: TradingAssetClass;
  symbol: string;
  action: ManualOrderAction;
  orderType: 'market' | 'limit';
  quantity?: number | null;
  quoteAmountKrw?: number | null;
  limitPrice?: number | null;
  stopPrice?: number | null;
  targetPrice?: number | null;
  stockExchange?: 'NASDAQ' | 'NYSE' | 'AMEX' | null;
};

export class ManualOrderInputError extends Error {}

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Pure: validate the ticket and map it onto broker, plan market, side and exit semantics. */
export function resolveManualOrderRoute(request: ManualLiveOrderRequest, policy: TradingPolicy) {
  const markets: TradingAssetClass[] = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'];
  if (!request || !markets.includes(request.market)) throw new ManualOrderInputError('MANUAL_ORDER_MARKET_INVALID');
  const symbol = String(request.symbol ?? '').trim().toUpperCase().replace(/^KRW-/u, '');
  if (!/^[A-Z0-9._-]{1,24}$/u.test(symbol)) throw new ManualOrderInputError('MANUAL_ORDER_SYMBOL_INVALID');
  if (request.orderType !== 'market' && request.orderType !== 'limit') throw new ManualOrderInputError('MANUAL_ORDER_TYPE_INVALID');
  if (request.orderType === 'limit' && !positive(request.limitPrice)) throw new ManualOrderInputError('MANUAL_ORDER_LIMIT_PRICE_REQUIRED');

  const futures = request.market === 'crypto_futures';
  const cashActions: ManualOrderAction[] = ['buy', 'sell'];
  const futuresActions: ManualOrderAction[] = ['long', 'short', 'close_long', 'close_short'];
  if (!(futures ? futuresActions : cashActions).includes(request.action)) throw new ManualOrderInputError('MANUAL_ORDER_ACTION_INVALID');

  let exchange: TradingExchange;
  let planMarket: string;
  let stockBroker: 'kiwoom' | 'toss' | null = null;
  if (request.market === 'domestic_stock' || request.market === 'us_stock') {
    stockBroker = policy.stockBrokerByMarket?.[request.market] === 'toss' ? 'toss' : 'kiwoom';
    exchange = stockBroker;
    planMarket = request.market === 'domestic_stock' ? 'KR' : 'US';
  } else if (request.market === 'crypto_spot') {
    exchange = 'upbit';
    planMarket = 'KRW';
  } else {
    exchange = 'bitget';
    planMarket = 'USDT-FUTURES';
  }

  const exit = request.action === 'sell' || request.action === 'close_long' || request.action === 'close_short';
  // Bitget one-way: closing a long sends a reduce-only SELL (side 'short'), and vice versa.
  const side: TradingSide = request.action === 'close_long' ? 'short'
    : request.action === 'close_short' ? 'long'
      : request.action as TradingSide;

  const quantity = request.quantity == null ? null : Number(request.quantity);
  const quoteAmountKrw = request.quoteAmountKrw == null ? null : Number(request.quoteAmountKrw);
  const upbitMarketBuy = exchange === 'upbit' && request.orderType === 'market' && side === 'buy';
  if (upbitMarketBuy) {
    if (!positive(quoteAmountKrw)) throw new ManualOrderInputError('MANUAL_ORDER_AMOUNT_REQUIRED');
  } else if (!positive(quantity)) {
    throw new ManualOrderInputError('MANUAL_ORDER_QUANTITY_REQUIRED');
  }
  if (exchange === 'kiwoom' && planMarket === 'KR' && quantity != null && !Number.isSafeInteger(quantity)) {
    throw new ManualOrderInputError('MANUAL_ORDER_QUANTITY_MUST_BE_INTEGER');
  }
  if (exchange === 'kiwoom' && planMarket === 'US' && !['NASDAQ', 'NYSE', 'AMEX'].includes(String(request.stockExchange ?? ''))) {
    throw new ManualOrderInputError('MANUAL_ORDER_US_EXCHANGE_REQUIRED');
  }
  // New entries must carry a protective stop on the losing side; exits do not.
  if (!exit && !positive(request.stopPrice)) throw new ManualOrderInputError('MANUAL_ORDER_STOP_REQUIRED');

  return {
    exchange, planMarket, stockBroker, symbol, side, exit,
    quantity: upbitMarketBuy ? null : quantity,
    quoteAmountKrw: upbitMarketBuy ? quoteAmountKrw : null,
    leverage: futures ? policy.bitgetLeverage : null,
    marginMode: futures ? 'isolated' as const : null,
  };
}

/** Pure: stop and target must sit on the correct side of the reference price. */
export function validateManualProtection(
  side: TradingSide, exit: boolean, reference: number, stop: number | null | undefined, target: number | null | undefined,
) {
  if (exit) return;
  const longSide = side === 'buy' || side === 'long';
  if (!positive(stop) || (longSide ? !(stop < reference) : !(stop > reference))) {
    throw new ManualOrderInputError('MANUAL_ORDER_STOP_SIDE_INVALID');
  }
  if (target != null && (!positive(target) || (longSide ? !(target > reference) : !(target < reference)))) {
    throw new ManualOrderInputError('MANUAL_ORDER_TARGET_SIDE_INVALID');
  }
}

/** Loss-limit inputs from all closed LIVE trades (manual and automatic) in the canonical journal. */
export async function manualLiveJournalRisk(
  repository: TradingRepository, userId: string, policy: TradingPolicy, nowMs: number,
  krwPerQuote: (market: string) => Promise<number>,
) {
  const payloads = await readTradeAutomationJournalPayloads(repository, userId);
  const journal = buildUnifiedTradeJournal(payloads, { range: 'ALL' }, new Date(nowMs));
  const closed = journal.trades.filter((trade) => (trade.source === 'APP_AUTO' || trade.source === 'APP_MANUAL')
    && trade.status === 'CLOSED' && trade.closedAt && Number.isFinite(Number(trade.netPnl)));
  const pnlSince = async (cutoff: number) => {
    let total = 0;
    for (const trade of closed) {
      if (Date.parse(trade.closedAt ?? '') < cutoff) continue;
      total += Number(trade.netPnl) * await krwPerQuote(String(trade.market));
    }
    return total;
  };
  const equityBase = Math.max(1, policy.totalCapitalKrw);
  const ordered = [...closed].sort((a, b) => Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''));
  let consecutiveLosses = 0;
  for (const trade of ordered) {
    if (Number(trade.netPnl) < 0) consecutiveLosses += 1;
    else break;
  }
  return {
    dailyPnlPercent: await pnlSince(nowMs - 86_400_000) / equityBase * 100,
    weeklyPnlPercent: await pnlSince(nowMs - (7 * 86_400_000)) / equityBase * 100,
    consecutiveLosses,
  };
}

/** Builds a manual LIVE plan input from the ticket plus server-read exchange data. */
export async function buildManualLivePlanInput(input: {
  userId: string;
  request: ManualLiveOrderRequest;
  policy: TradingPolicy;
  repository: TradingRepository;
  krwPerQuote: (market: string) => Promise<number>;
  previewSnapshot: (seed: TradingPlanInput, fx: number) => Promise<TradingMarketSnapshot>;
  now?: Date;
}): Promise<TradingPlanInput> {
  const now = input.now ?? new Date();
  const route = resolveManualOrderRoute(input.request, input.policy);
  const fxMarket = route.planMarket === 'KR' ? 'KR_STOCK' : route.planMarket === 'US' ? 'US_STOCK'
    : route.planMarket === 'KRW' ? 'CRYPTO_SPOT' : 'CRYPTO_FUTURES';
  const fx = await input.krwPerQuote(fxMarket);
  if (!positive(fx)) throw new ManualOrderInputError('MANUAL_ORDER_FX_UNAVAILABLE');
  const observedAt = now.toISOString();
  const ticketId = randomUUID();
  const hint = positive(input.request.limitPrice) ? input.request.limitPrice : null;
  const seedSnapshot: TradingMarketSnapshot = {
    observedAt, riskObservedAt: observedAt, dataDelayMs: 0, oneMinuteMovePercent: 0,
    spreadPercent: 0, orderbookGapPercent: 0, halted: false, availableBalance: 0,
    accountValueKrw: Math.max(1, input.policy.totalCapitalKrw), dailyPnlPercent: 0, assetExposurePercent: 0,
    openPositionCount: 0, dailyOrderCount: 0, consecutiveLosses: 0,
    currentPrice: hint, plannedPrice: hint, marketStatus: 'OPEN', source: 'manual-order-ticket',
    signalState: 'entry_ready', signalObservedAt: observedAt,
  };
  const seed: TradingPlanInput = {
    exchange: route.exchange,
    accountMode: 'live',
    stockBroker: route.stockBroker,
    stockExchange: route.exchange === 'kiwoom' && route.planMarket === 'US' ? input.request.stockExchange ?? null : null,
    strategyId: MANUAL_ORDER_STRATEGY_ID,
    signalId: `manual:${ticketId}`,
    signalOccurrenceId: `manual:${ticketId}@${now.getTime()}`,
    symbol: route.symbol,
    market: route.planMarket,
    side: route.side,
    orderType: input.request.orderType,
    quantity: route.quantity,
    quoteAmount: route.quoteAmountKrw,
    limitPrice: input.request.orderType === 'limit' ? input.request.limitPrice ?? null : hint,
    estimatedKrw: route.quoteAmountKrw ?? 1,
    stopPrice: route.exit ? 0 : Number(input.request.stopPrice),
    targetPrices: !route.exit && positive(input.request.targetPrice) ? [input.request.targetPrice] : [],
    splitRatios: [100],
    leverage: route.leverage,
    marginMode: route.marginMode,
    reduceOnly: route.exit,
    invalidateAction: 'hold',
    signalReasons: ['MANUAL_ORDER_TICKET', route.exit ? 'MANUAL_EXIT' : 'MANUAL_ENTRY'],
    marketSnapshot: seedSnapshot,
    entryPrice: null,
    entryZoneLow: null,
    entryZoneHigh: null,
    estimatedSlippagePercent: null,
    averageSpreadPercent: null,
    economics: null,
  };
  const snapshot = await input.previewSnapshot(seed, fx);
  const reference = Number(input.request.orderType === 'limit' ? input.request.limitPrice : snapshot.currentPrice ?? snapshot.plannedPrice);
  if (!positive(reference)) throw new ManualOrderInputError('MANUAL_ORDER_PRICE_UNAVAILABLE');
  validateManualProtection(route.side, route.exit, reference, input.request.stopPrice, input.request.targetPrice);
  const risk = await manualLiveJournalRisk(input.repository, input.userId, input.policy, now.getTime(), async (m) => {
    const key = m.toUpperCase();
    return input.krwPerQuote(key.includes('FUTURES') || key === 'USDT-FUTURES' ? 'CRYPTO_FUTURES'
      : key === 'KRW' || key.includes('SPOT') ? 'CRYPTO_SPOT' : key === 'US' || key.includes('US') ? 'US_STOCK' : 'KR_STOCK');
  });
  const estimatedKrw = route.quoteAmountKrw ?? Number(route.quantity) * reference * fx;
  return {
    ...seed,
    estimatedKrw,
    // Exits are protected by reduce-only; their stop is the reference price like automatic exits.
    stopPrice: route.exit ? reference : Number(input.request.stopPrice),
    limitPrice: input.request.orderType === 'limit' ? Number(input.request.limitPrice) : reference,
    estimatedSlippagePercent: snapshot.estimatedSlippagePercent ?? null,
    averageSpreadPercent: snapshot.spreadPercent,
    marketSnapshot: {
      ...snapshot,
      dailyPnlPercent: risk.dailyPnlPercent,
      weeklyPnlPercent: risk.weeklyPnlPercent,
      consecutiveLosses: risk.consecutiveLosses,
      source: `${snapshot.source ?? 'exchange'}+manual-order-ticket`,
    },
  };
}
