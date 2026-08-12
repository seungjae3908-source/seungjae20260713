import type {
  TradingOrder,
  TradingPlan,
  TradingRiskDecision,
} from './trade-automation.types';

type JsonRecord = Record<string, unknown>;

const MAX_QUOTE_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export type TossMarket = 'KR' | 'US';
export type TossCurrency = 'KRW' | 'USD';

export type TossPreSubmissionSnapshot = Readonly<{
  provider: 'TOSS';
  accountAlias: string;
  market: TossMarket;
  symbol: string;
  currency: TossCurrency;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: number | null;
  amount: number | null;
  currentPrice: number;
  expectedExecutionPrice: number;
  spreadPercent: number;
  availableBuyingPower: number;
  sellableQuantity: number;
  estimatedCommissionPercent: number;
  estimatedSlippagePercent: number;
  marketStatus: 'OPEN';
  marketCalendarDate: string;
  marketTimestamp: string;
  providerTimestamp: string;
  observedAt: string;
  freshnessMs: number;
  riskDecision: TradingRiskDecision;
  strategyVersion: string;
  releaseSha: string;
  internalOrderId: string;
  clientOrderId: string;
  riskDecisionId: string;
}>;

export type TossPreSubmissionPayloads = {
  accounts: unknown;
  orderbook: unknown;
  prices: unknown;
  buyingPower: unknown;
  sellableQuantity: unknown;
  commissions: unknown;
  marketCalendar: unknown;
};

export type TossPreSubmissionInput = {
  selectedAccountSeq: string;
  plan: TradingPlan;
  order: TradingOrder;
  market: TossMarket;
  currency: TossCurrency;
  riskDecision: TradingRiskDecision;
  riskDecisionId: string;
  strategyVersion: string;
  releaseSha: string;
  payloads: TossPreSubmissionPayloads;
  now?: Date;
};

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function finite(value: unknown): number | null {
  if (typeof value === 'string') value = value.replace(/[,+%₩$]/g, '').trim();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown, code: string): number {
  const parsed = finite(value);
  if (parsed == null || parsed <= 0) throw new Error(code);
  return parsed;
}

function nonNegative(value: unknown, code: string): number {
  const parsed = finite(value);
  if (parsed == null || parsed < 0) throw new Error(code);
  return parsed;
}

function parseTime(value: unknown, code: string): number {
  const parsed = Date.parse(text(value));
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function maskAccount(accountSeq: string) {
  const normalized = accountSeq.trim();
  if (!normalized) throw new Error('TOSS_ACCOUNT_SELECTION_REQUIRED');
  if (normalized.length <= 2) return '*'.repeat(normalized.length);
  return `${normalized.slice(0, 1)}${'*'.repeat(Math.max(3, normalized.length - 2))}${normalized.slice(-1)}`;
}

function expectedCurrency(market: TossMarket): TossCurrency {
  return market === 'KR' ? 'KRW' : 'USD';
}

function assertMarketPlan(plan: TradingPlan, market: TossMarket, currency: TossCurrency) {
  if (plan.exchange !== 'toss') throw new Error('TOSS_PROVIDER_REQUIRED');
  if (plan.market.toUpperCase() !== market) throw new Error('TOSS_MARKET_MISMATCH');
  if (currency !== expectedCurrency(market)) throw new Error('TOSS_CURRENCY_MISMATCH');
  if (plan.side !== 'buy' && plan.side !== 'sell') throw new Error('TOSS_SIDE_UNSUPPORTED');
  if (plan.orderType !== 'market' && plan.orderType !== 'limit') throw new Error('TOSS_ORDER_TYPE_UNSUPPORTED');
}

function assertSelectedAccount(payload: unknown, selectedAccountSeq: string) {
  const accountRows = rows(record(payload).result);
  if (!accountRows.some((account) => text(account.accountSeq) === selectedAccountSeq)) {
    throw new Error('TOSS_SELECTED_ACCOUNT_NOT_FOUND');
  }
}

function quote(payloads: TossPreSubmissionPayloads, symbol: string, currency: TossCurrency, side: 'BUY' | 'SELL') {
  const priceRows = rows(record(payloads.prices).result);
  const price = priceRows.find((row) => text(row.symbol).toUpperCase() === symbol.toUpperCase());
  if (!price) throw new Error('TOSS_PRICE_NOT_FOUND');
  if (text(price.currency) !== currency) throw new Error('TOSS_PRICE_CURRENCY_MISMATCH');
  const currentPrice = positive(price.lastPrice, 'TOSS_CURRENT_PRICE_INVALID');
  const priceTimestamp = text(price.timestamp);

  const book = record(record(payloads.orderbook).result);
  if (text(book.currency) !== currency) throw new Error('TOSS_ORDERBOOK_CURRENCY_MISMATCH');
  const asks = rows(book.asks);
  const bids = rows(book.bids);
  const bestAsk = positive(asks[0]?.price, 'TOSS_BEST_ASK_UNAVAILABLE');
  const bestBid = positive(bids[0]?.price, 'TOSS_BEST_BID_UNAVAILABLE');
  if (bestAsk < bestBid) throw new Error('TOSS_ORDERBOOK_CROSSED');
  const expectedExecutionPrice = side === 'BUY' ? bestAsk : bestBid;
  const midpoint = (bestAsk + bestBid) / 2;
  const spreadPercent = midpoint > 0 ? (bestAsk - bestBid) / midpoint * 100 : Number.NaN;
  if (!Number.isFinite(spreadPercent) || spreadPercent < 0) throw new Error('TOSS_SPREAD_INVALID');
  const estimatedSlippagePercent = Math.abs(expectedExecutionPrice - currentPrice) / currentPrice * 100;
  return {
    currentPrice,
    expectedExecutionPrice,
    spreadPercent,
    estimatedSlippagePercent,
    priceTimestamp,
    orderbookTimestamp: text(book.timestamp),
  };
}

function marketSessions(payload: unknown, market: TossMarket) {
  const today = record(record(payload).result).today;
  const todayRecord = record(today);
  const date = text(todayRecord.date);
  if (!date) throw new Error('TOSS_MARKET_CALENDAR_DATE_MISSING');
  if (market === 'KR') {
    const integrated = todayRecord.integrated;
    if (integrated == null) return { date, sessions: [] as JsonRecord[] };
    const value = record(integrated);
    return { date, sessions: ['preMarket', 'regularMarket', 'afterMarket'].map((key) => record(value[key])).filter((item) => Object.keys(item).length > 0) };
  }
  return {
    date,
    sessions: ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket']
      .map((key) => todayRecord[key])
      .filter((item) => item != null)
      .map(record),
  };
}

function assertMarketOpen(payload: unknown, market: TossMarket, now: Date) {
  const calendar = marketSessions(payload, market);
  const nowMs = now.getTime();
  const active = calendar.sessions.find((session) => {
    const start = Date.parse(text(session.startTime));
    const end = Date.parse(text(session.endTime));
    return Number.isFinite(start) && Number.isFinite(end) && nowMs >= start && nowMs < end;
  });
  if (!active) throw new Error('TOSS_MARKET_NOT_OPEN');
  return { date: calendar.date, marketTimestamp: text(active.startTime) };
}

function buyingPower(payload: unknown, currency: TossCurrency) {
  const result = record(record(payload).result);
  if (text(result.currency) !== currency) throw new Error('TOSS_BUYING_POWER_CURRENCY_MISMATCH');
  return nonNegative(result.cashBuyingPower, 'TOSS_BUYING_POWER_INVALID');
}

function sellableQuantity(payload: unknown) {
  return nonNegative(record(record(payload).result).sellableQuantity, 'TOSS_SELLABLE_QUANTITY_INVALID');
}

function commission(payload: unknown, market: TossMarket, now: Date) {
  const matching = rows(record(payload).result).filter((row) => text(row.marketCountry) === market);
  const active = matching.find((row) => {
    const start = text(row.startDate);
    const end = text(row.endDate);
    const today = now.toISOString().slice(0, 10);
    return (!start || start <= today) && (!end || today <= end);
  });
  if (!active) throw new Error('TOSS_COMMISSION_UNAVAILABLE');
  return nonNegative(active.commissionRate, 'TOSS_COMMISSION_INVALID');
}

function assertFresh(now: Date, timestamps: string[]) {
  const nowMs = now.getTime();
  const parsed = timestamps.map((value) => parseTime(value, 'TOSS_PROVIDER_TIMESTAMP_INVALID'));
  for (const timestamp of parsed) {
    if (timestamp > nowMs + MAX_FUTURE_SKEW_MS) throw new Error('TOSS_PROVIDER_TIMESTAMP_FROM_FUTURE');
  }
  const freshnessMs = Math.max(...parsed.map((timestamp) => Math.max(0, nowMs - timestamp)));
  if (freshnessMs > MAX_QUOTE_AGE_MS) throw new Error('TOSS_MARKET_DATA_STALE');
  return freshnessMs;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value as Readonly<T>;
}

export function buildTossPreSubmissionSnapshot(input: TossPreSubmissionInput): TossPreSubmissionSnapshot {
  const now = input.now ?? new Date();
  const accountSeq = input.selectedAccountSeq.trim();
  if (!accountSeq) throw new Error('TOSS_ACCOUNT_SELECTION_REQUIRED');
  assertMarketPlan(input.plan, input.market, input.currency);
  assertSelectedAccount(input.payloads.accounts, accountSeq);
  if (!input.riskDecision.allowed || input.riskDecision.blockCodes.length > 0) throw new Error('TOSS_RISK_DECISION_NOT_ALLOWED');
  if (!input.riskDecisionId.trim()) throw new Error('TOSS_RISK_DECISION_ID_REQUIRED');
  if (!input.strategyVersion.trim()) throw new Error('TOSS_STRATEGY_VERSION_REQUIRED');
  if (!/^[0-9a-f]{40}$/i.test(input.releaseSha)) throw new Error('TOSS_RELEASE_SHA_INVALID');

  const side = input.plan.side === 'buy' ? 'BUY' : 'SELL';
  const orderType = input.plan.orderType === 'market' ? 'MARKET' : 'LIMIT';
  const quantity = input.plan.quantity ?? null;
  const amount = input.plan.quoteAmount ?? null;
  if ((quantity == null) === (amount == null)) throw new Error('TOSS_QUANTITY_OR_AMOUNT_REQUIRED');
  if (quantity != null && (!(quantity > 0) || !Number.isFinite(quantity))) throw new Error('TOSS_QUANTITY_INVALID');
  if (amount != null && (!(amount > 0) || !Number.isFinite(amount))) throw new Error('TOSS_AMOUNT_INVALID');

  const market = assertMarketOpen(input.payloads.marketCalendar, input.market, now);
  const prices = quote(input.payloads, input.plan.symbol, input.currency, side);
  const freshnessMs = assertFresh(now, [prices.priceTimestamp, prices.orderbookTimestamp]);
  const availableBuyingPower = buyingPower(input.payloads.buyingPower, input.currency);
  const sellable = sellableQuantity(input.payloads.sellableQuantity);
  const estimatedCommissionPercent = commission(input.payloads.commissions, input.market, now);

  const estimatedOrderValue = amount ?? (quantity! * prices.expectedExecutionPrice);
  if (side === 'BUY' && availableBuyingPower < estimatedOrderValue) throw new Error('TOSS_INSUFFICIENT_BUYING_POWER');
  if (side === 'SELL' && (quantity == null || sellable < quantity)) throw new Error('TOSS_INSUFFICIENT_SELLABLE_QUANTITY');

  return deepFreeze({
    provider: 'TOSS' as const,
    accountAlias: maskAccount(accountSeq),
    market: input.market,
    symbol: input.plan.symbol,
    currency: input.currency,
    side,
    orderType,
    quantity,
    amount,
    currentPrice: prices.currentPrice,
    expectedExecutionPrice: prices.expectedExecutionPrice,
    spreadPercent: prices.spreadPercent,
    availableBuyingPower,
    sellableQuantity: sellable,
    estimatedCommissionPercent,
    estimatedSlippagePercent: prices.estimatedSlippagePercent,
    marketStatus: 'OPEN' as const,
    marketCalendarDate: market.date,
    marketTimestamp: market.marketTimestamp,
    providerTimestamp: prices.priceTimestamp,
    observedAt: now.toISOString(),
    freshnessMs,
    riskDecision: input.riskDecision,
    strategyVersion: input.strategyVersion.trim(),
    releaseSha: input.releaseSha.toLowerCase(),
    internalOrderId: input.order.id,
    clientOrderId: input.order.clientOrderId,
    riskDecisionId: input.riskDecisionId.trim(),
  });
}
