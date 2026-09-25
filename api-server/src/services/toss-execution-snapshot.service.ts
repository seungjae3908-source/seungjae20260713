import type {
  TradingMarketSnapshot,
  TradingPlan,
  TradingSignalState,
} from './trade-automation.types';

type JsonObject = Record<string, unknown>;
type Level = { price: number; size: number };
type SignalSnapshot = { state: TradingSignalState; observedAt: string } | null;

export type TossExecutionPayloads = {
  accounts: unknown;
  orderbook: unknown;
  prices: unknown;
  buyingPower: unknown;
  sellableQuantity?: unknown;
  commissions: unknown;
  marketCalendar: unknown;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function rows(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown) {
  return String(value ?? '').trim();
}

function finite(value: unknown) {
  const parsed = Number(typeof value === 'string' ? value.replace(/[,+%₩$]/g, '').trim() : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function nonNegative(value: unknown) {
  const parsed = finite(value);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function timestamp(value: unknown) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedAccountExists(payload: unknown, accountSeq: string) {
  return rows(record(payload).result).some((row) => text(row.accountSeq) === accountSeq);
}

function marketSessions(payload: unknown, market: 'KR' | 'US') {
  const today = record(record(payload).result).today;
  const row = record(today);
  if (!text(row.date)) throw new Error('TOSS_MARKET_CALENDAR_DATE_MISSING');
  if (market === 'KR') {
    const integrated = record(row.integrated);
    return ['preMarket', 'regularMarket', 'afterMarket'].map((key) => record(integrated[key]))
      .filter((item) => Object.keys(item).length > 0);
  }
  return ['dayMarket', 'preMarket', 'regularMarket', 'afterMarket'].map((key) => record(row[key]))
    .filter((item) => Object.keys(item).length > 0);
}

function assertMarketOpen(payload: unknown, market: 'KR' | 'US', now: Date) {
  const nowMs = now.getTime();
  const sessions = marketSessions(payload, market);
  const active = sessions.some((session) => {
    const start = timestamp(session.startTime);
    const end = timestamp(session.endTime);
    return start != null && end != null && nowMs >= start && nowMs < end;
  });
  if (!active) throw new Error('TOSS_MARKET_NOT_OPEN');
}

function activeCommission(payload: unknown, market: 'KR' | 'US', now: Date) {
  const today = now.toISOString().slice(0, 10);
  const active = rows(record(payload).result).find((row) => {
    if (text(row.marketCountry).toUpperCase() !== market) return false;
    const start = text(row.startDate);
    const end = text(row.endDate);
    return (!start || start <= today) && (!end || today <= end);
  });
  const fee = nonNegative(active?.commissionRate);
  if (fee == null) throw new Error('TOSS_COMMISSION_UNAVAILABLE');
  return fee;
}

function quote(input: {
  payloads: TossExecutionPayloads;
  plan: TradingPlan;
  currency: 'KRW' | 'USD';
}) {
  const price = rows(record(input.payloads.prices).result)
    .find((row) => text(row.symbol).toUpperCase() === input.plan.symbol.toUpperCase());
  if (!price) throw new Error('TOSS_PRICE_NOT_FOUND');
  if (text(price.currency).toUpperCase() !== input.currency) throw new Error('TOSS_PRICE_CURRENCY_MISMATCH');
  const currentPrice = positive(price.lastPrice);
  if (currentPrice == null) throw new Error('TOSS_CURRENT_PRICE_INVALID');

  const book = record(record(input.payloads.orderbook).result);
  if (text(book.currency).toUpperCase() !== input.currency) throw new Error('TOSS_ORDERBOOK_CURRENCY_MISMATCH');
  const asks = rows(book.asks).flatMap((row) => {
    const priceValue = positive(row.price);
    const size = positive(row.quantity ?? row.size);
    return priceValue != null && size != null ? [{ price: priceValue, size }] : [];
  }).sort((a, b) => a.price - b.price);
  const bids = rows(book.bids).flatMap((row) => {
    const priceValue = positive(row.price);
    const size = positive(row.quantity ?? row.size);
    return priceValue != null && size != null ? [{ price: priceValue, size }] : [];
  }).sort((a, b) => b.price - a.price);
  if (!asks.length || !bids.length || asks[0].price < bids[0].price) throw new Error('TOSS_ORDERBOOK_INVALID');

  const timestamps = [timestamp(price.timestamp), timestamp(book.timestamp)].filter((v): v is number => v != null);
  if (timestamps.length !== 2) throw new Error('TOSS_PROVIDER_TIMESTAMP_INVALID');
  const observedAtMs = Math.min(...timestamps);
  const now = Date.now();
  if (timestamps.some((value) => value > now + 5_000)) throw new Error('TOSS_PROVIDER_TIMESTAMP_FROM_FUTURE');
  if (now - observedAtMs > 30_000) throw new Error('TOSS_MARKET_DATA_STALE');

  return { currentPrice, asks, bids, observedAtMs };
}

function orderbookMetrics(plan: TradingPlan, asks: Level[], bids: Level[], currentPrice: number) {
  const execution = plan.side === 'buy' ? asks : bids;
  const requiredQuantity = plan.quantity ?? (plan.quoteAmount != null ? plan.quoteAmount / currentPrice : null);
  if (requiredQuantity == null || requiredQuantity <= 0) throw new Error('TOSS_ORDER_SIZE_INVALID');
  let remaining = requiredQuantity;
  let cost = 0;
  let filled = 0;
  for (const level of execution.slice(0, 10)) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, level.size);
    filled += quantity;
    cost += quantity * level.price;
    remaining -= quantity;
  }
  if (remaining > 1e-12 || filled <= 0) throw new Error('TOSS_INSUFFICIENT_ORDERBOOK_LIQUIDITY');
  const vwap = cost / filled;
  const midpoint = (asks[0].price + bids[0].price) / 2;
  return {
    expectedExecutionPrice: vwap,
    spreadPercent: (asks[0].price - bids[0].price) / midpoint * 100,
    slippagePercent: Math.abs(vwap - currentPrice) / currentPrice * 100,
    executableNotional: cost,
  };
}

export function buildTossExecutionSnapshot(input: {
  plan: TradingPlan;
  accountSeq: string;
  payloads: TossExecutionPayloads;
  signal: SignalSnapshot;
  now?: Date;
}): TradingMarketSnapshot {
  const now = input.now ?? new Date();
  const market = input.plan.market.toUpperCase();
  if (market !== 'KR' && market !== 'US') throw new Error('TOSS_MARKET_INVALID');
  const currency = market === 'KR' ? 'KRW' : 'USD';
  if (!selectedAccountExists(input.payloads.accounts, input.accountSeq)) {
    throw new Error('TOSS_SELECTED_ACCOUNT_NOT_FOUND');
  }
  assertMarketOpen(input.payloads.marketCalendar, market, now);

  const marketQuote = quote({ payloads: input.payloads, plan: input.plan, currency });
  const metrics = orderbookMetrics(input.plan, marketQuote.asks, marketQuote.bids, marketQuote.currentPrice);
  const buyingPower = nonNegative(record(record(input.payloads.buyingPower).result).cashBuyingPower);
  if (buyingPower == null) throw new Error('TOSS_BUYING_POWER_INVALID');

  const requiredProviderNotional = input.plan.quoteAmount
    ?? ((input.plan.quantity ?? 0) * metrics.expectedExecutionPrice);
  if (!(requiredProviderNotional > 0)) throw new Error('TOSS_ORDER_SIZE_INVALID');
  if (input.plan.side === 'buy' && buyingPower < requiredProviderNotional) {
    throw new Error('TOSS_INSUFFICIENT_BUYING_POWER');
  }
  if (input.plan.side === 'sell') {
    const sellable = nonNegative(record(record(input.payloads.sellableQuantity).result).sellableQuantity);
    if (sellable == null || input.plan.quantity == null || sellable < input.plan.quantity) {
      throw new Error('TOSS_INSUFFICIENT_SELLABLE_QUANTITY');
    }
  }

  const providerCoverage = input.plan.side === 'buy'
    ? buyingPower / requiredProviderNotional
    : 1;
  const availableBalance = input.plan.estimatedKrw * Math.max(1, providerCoverage);
  const liquidityCoverage = metrics.executableNotional / requiredProviderNotional;
  const feePercent = activeCommission(input.payloads.commissions, market, now);

  return {
    ...input.plan.marketSnapshot,
    observedAt: new Date(marketQuote.observedAtMs).toISOString(),
    riskObservedAt: input.plan.marketSnapshot.riskObservedAt ?? input.plan.marketSnapshot.observedAt,
    dataDelayMs: Math.max(0, now.getTime() - marketQuote.observedAtMs),
    providerTimeOffsetMs: Math.max(0, now.getTime() - marketQuote.observedAtMs),
    source: 'toss-private-account+market',
    currentPrice: marketQuote.currentPrice,
    plannedPrice: input.plan.marketSnapshot.plannedPrice ?? input.plan.limitPrice ?? marketQuote.currentPrice,
    spreadPercent: metrics.spreadPercent,
    orderbookGapPercent: input.plan.marketSnapshot.orderbookGapPercent,
    availableLiquidityKrw: input.plan.estimatedKrw * liquidityCoverage,
    estimatedSlippagePercent: metrics.slippagePercent,
    estimatedFeePercent: feePercent,
    availableBalance,
    marketStatus: 'OPEN',
    halted: false,
    signalState: input.signal?.state ?? input.plan.marketSnapshot.signalState ?? null,
    signalObservedAt: input.signal?.observedAt ?? input.plan.marketSnapshot.signalObservedAt ?? null,
  };
}
