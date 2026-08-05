import type { PreparedExchangeRequest } from './trade-exchange-adapters.service';
import type {
  TradingMarketSnapshot,
  TradingPlan,
  TradingSignalState,
} from './trade-automation.types';

type JsonObject = Record<string, unknown>;
type Level = { price: number; size: number };

type SignalSnapshot = {
  state: TradingSignalState;
  observedAt: string;
} | null;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function absolute(value: unknown): number | null {
  const parsed = finite(value);
  return parsed == null ? null : Math.abs(parsed);
}

function rows(value: unknown): JsonObject[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (isRecord(value)) return [value];
  return [];
}

function levelRows(value: unknown, descending: boolean): Level[] {
  if (!Array.isArray(value)) return [];
  const normalized = value.flatMap((row) => {
    if (!Array.isArray(row) || row.length < 2) return [];
    const price = positive(row[0]);
    const size = positive(row[1]);
    return price != null && size != null ? [{ price, size }] : [];
  });
  return normalized.sort((left, right) => descending ? right.price - left.price : left.price - right.price);
}

function objectLevels(value: unknown): { bids: Level[]; asks: Level[]; timestamp: number | null } {
  const row = rows(value)[0];
  if (!row) return { bids: [], asks: [], timestamp: null };
  const units = Array.isArray(row.orderbook_units) ? row.orderbook_units.filter(isRecord) : [];
  return {
    bids: units.flatMap((unit) => {
      const price = positive(unit.bid_price);
      const size = positive(unit.bid_size);
      return price != null && size != null ? [{ price, size }] : [];
    }).sort((left, right) => right.price - left.price),
    asks: units.flatMap((unit) => {
      const price = positive(unit.ask_price);
      const size = positive(unit.ask_size);
      return price != null && size != null ? [{ price, size }] : [];
    }).sort((left, right) => left.price - right.price),
    timestamp: finite(row.timestamp),
  };
}

function kiwoomLevels(value: JsonObject): { bids: Level[]; asks: Level[] } {
  const asks: Level[] = [];
  const bids: Level[] = [];
  const bestAsk = positive(value.sel_fpr_bid);
  const bestAskSize = positive(value.sel_fpr_req);
  const bestBid = positive(value.buy_fpr_bid);
  const bestBidSize = positive(value.buy_fpr_req);
  if (bestAsk != null && bestAskSize != null) asks.push({ price: bestAsk, size: bestAskSize });
  if (bestBid != null && bestBidSize != null) bids.push({ price: bestBid, size: bestBidSize });
  for (let index = 2; index <= 10; index += 1) {
    const askPrice = positive(value[`sel_${index}th_pre_bid`]);
    const askSize = positive(value[`sel_${index}th_pre_req`]);
    const bidPrice = positive(value[`buy_${index}th_pre_bid`]);
    const bidSize = positive(value[`buy_${index}th_pre_req`]);
    if (askPrice != null && askSize != null) asks.push({ price: askPrice, size: askSize });
    if (bidPrice != null && bidSize != null) bids.push({ price: bidPrice, size: bidSize });
  }
  return {
    asks: asks.sort((left, right) => left.price - right.price),
    bids: bids.sort((left, right) => right.price - left.price),
  };
}

function timestampMs(values: unknown[]) {
  const timestamps = values
    .map(finite)
    .filter((value): value is number => value != null && value > 0)
    .map((value) => value < 100_000_000_000 ? value * 1000 : value);
  return timestamps.length ? Math.min(...timestamps) : null;
}

function isoTimestamp(value: number | null) {
  if (value == null) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function plannedReferencePrice(plan: TradingPlan) {
  const values = [
    plan.marketSnapshot.currentPrice,
    plan.marketSnapshot.plannedPrice,
    plan.limitPrice,
    plan.quoteAmount != null && plan.quantity != null && plan.quantity > 0
      ? plan.quoteAmount / plan.quantity
      : null,
  ];
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null;
}

function bookMetrics(plan: TradingPlan, bids: Level[], asks: Level[], currentPrice: number | null) {
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const midpoint = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : currentPrice;
  const spreadPercent = midpoint != null && midpoint > 0 && bestBid != null && bestAsk != null && bestAsk >= bestBid
    ? (bestAsk - bestBid) / midpoint * 100
    : Number.POSITIVE_INFINITY;
  const executionLevels = plan.side === 'buy' || plan.side === 'long' ? asks : bids;
  const gapPercent = executionLevels.length >= 2 && midpoint != null && midpoint > 0
    ? Math.max(...executionLevels.slice(0, 5).slice(1).map((level, index) => (
      Math.abs(level.price - executionLevels[index].price) / midpoint * 100
    )))
    : Number.POSITIVE_INFINITY;
  const requiredQuantity = plan.quantity != null && plan.quantity > 0
    ? plan.quantity
    : plan.quoteAmount != null && currentPrice != null && currentPrice > 0
      ? plan.quoteAmount / currentPrice
      : null;
  const availableNotional = executionLevels.slice(0, 10)
    .reduce((sum, level) => sum + level.price * level.size, 0);
  const requiredNotional = requiredQuantity != null && currentPrice != null
    ? requiredQuantity * currentPrice
    : null;
  const availableLiquidityKrw = requiredNotional != null && requiredNotional > 0
    ? plan.estimatedKrw * (availableNotional / requiredNotional)
    : 0;

  let remaining = requiredQuantity ?? Number.POSITIVE_INFINITY;
  let filled = 0;
  let cost = 0;
  for (const level of executionLevels.slice(0, 10)) {
    if (!(remaining > 0)) break;
    const quantity = Math.min(remaining, level.size);
    filled += quantity;
    cost += quantity * level.price;
    remaining -= quantity;
  }
  const vwap = filled > 0 && remaining <= 1e-12 ? cost / filled : null;
  const estimatedSlippagePercent = vwap != null && currentPrice != null && currentPrice > 0
    ? Math.abs(vwap - currentPrice) / currentPrice * 100
    : Number.POSITIVE_INFINITY;
  return {
    bestBid,
    bestAsk,
    spreadPercent,
    orderbookGapPercent: gapPercent,
    availableLiquidityKrw,
    estimatedSlippagePercent,
  };
}

function baseSnapshot(input: {
  plan: TradingPlan;
  source: string;
  observedAtMs: number | null;
  currentPrice: number | null;
  bids: Level[];
  asks: Level[];
  availableBalance: number;
  accountValueKrw?: number;
  assetExposurePercent?: number;
  openPositionCount?: number;
  existingPositionSide?: TradingPlan['side'] | null;
  liquidationDistancePercent?: number | null;
  estimatedFeePercent?: number | null;
  marketStatus?: TradingMarketSnapshot['marketStatus'];
  signal?: SignalSnapshot;
}): TradingMarketSnapshot {
  const now = Date.now();
  const plannedPrice = plannedReferencePrice(input.plan);
  const metrics = bookMetrics(input.plan, input.bids, input.asks, input.currentPrice);
  const oneMinuteMovePercent = input.currentPrice != null && plannedPrice != null
    ? (input.currentPrice - plannedPrice) / plannedPrice * 100
    : input.plan.marketSnapshot.oneMinuteMovePercent;
  return {
    ...input.plan.marketSnapshot,
    observedAt: isoTimestamp(input.observedAtMs),
    riskObservedAt: input.plan.marketSnapshot.riskObservedAt ?? input.plan.marketSnapshot.observedAt,
    dataDelayMs: input.observedAtMs == null ? Number.POSITIVE_INFINITY : Math.max(0, now - input.observedAtMs),
    providerTimeOffsetMs: input.observedAtMs == null ? Number.POSITIVE_INFINITY : now - input.observedAtMs,
    source: input.source,
    currentPrice: input.currentPrice,
    plannedPrice,
    oneMinuteMovePercent,
    spreadPercent: metrics.spreadPercent,
    orderbookGapPercent: metrics.orderbookGapPercent,
    availableLiquidityKrw: metrics.availableLiquidityKrw,
    estimatedSlippagePercent: metrics.estimatedSlippagePercent,
    estimatedFeePercent: input.estimatedFeePercent ?? null,
    availableBalance: input.availableBalance,
    accountValueKrw: input.accountValueKrw ?? input.plan.marketSnapshot.accountValueKrw,
    assetExposurePercent: input.assetExposurePercent ?? input.plan.marketSnapshot.assetExposurePercent,
    openPositionCount: input.openPositionCount ?? input.plan.marketSnapshot.openPositionCount,
    existingPositionSide: input.existingPositionSide ?? null,
    liquidationDistancePercent: input.liquidationDistancePercent ?? null,
    marketStatus: input.marketStatus ?? 'OPEN',
    halted: input.marketStatus === 'HALTED',
    signalState: input.signal?.state ?? input.plan.marketSnapshot.signalState ?? null,
    signalObservedAt: input.signal?.observedAt ?? input.plan.marketSnapshot.signalObservedAt ?? null,
  };
}

export function prepareBitgetExecutionDepth(symbol: string): PreparedExchangeRequest {
  return {
    method: 'GET', path: '/api/v2/mix/market/merge-depth',
    query: `symbol=${encodeURIComponent(symbol.toUpperCase())}&productType=USDT-FUTURES&precision=scale0&limit=15`,
    headers: { Accept: 'application/json' }, body: null,
  };
}

export function prepareUpbitExecutionTicker(symbol: string): PreparedExchangeRequest {
  const market = `KRW-${symbol.toUpperCase().replace(/^KRW-/, '')}`;
  return { method: 'GET', path: '/v1/ticker', query: `markets=${encodeURIComponent(market)}`, headers: { Accept: 'application/json' }, body: null };
}

export function prepareUpbitExecutionOrderbook(symbol: string): PreparedExchangeRequest {
  const market = `KRW-${symbol.toUpperCase().replace(/^KRW-/, '')}`;
  return { method: 'GET', path: '/v1/orderbook', query: `markets=${encodeURIComponent(market)}&count=15`, headers: { Accept: 'application/json' }, body: null };
}

export function prepareKiwoomExecutionOrderbook(accessToken: string, symbol: string): PreparedExchangeRequest {
  return {
    method: 'POST', path: '/api/dostk/mrkcond', query: '',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json;charset=UTF-8',
      'api-id': 'ka10004',
    },
    body: JSON.stringify({ stk_cd: symbol }),
  };
}

export function buildPaperExecutionSnapshot(plan: TradingPlan): TradingMarketSnapshot {
  return {
    ...plan.marketSnapshot,
    source: 'paper',
    riskObservedAt: plan.marketSnapshot.riskObservedAt ?? plan.marketSnapshot.observedAt,
    marketStatus: plan.marketSnapshot.marketStatus ?? 'OPEN',
    currentPrice: plan.marketSnapshot.currentPrice ?? plannedReferencePrice(plan),
    plannedPrice: plannedReferencePrice(plan),
  };
}

export function buildBitgetExecutionSnapshot(input: {
  plan: TradingPlan;
  accounts: unknown;
  positions: unknown;
  ticker: unknown;
  depth: unknown;
  contract: JsonObject;
  signal: SignalSnapshot;
}): TradingMarketSnapshot {
  const accountRows = rows(input.accounts);
  const account = accountRows.find((row) => String(row.marginCoin ?? '').toUpperCase() === 'USDT') ?? accountRows[0];
  const positionRows = rows(input.positions).filter((row) => String(row.symbol ?? '').toUpperCase() === input.plan.symbol.toUpperCase());
  const tickerRow = rows(input.ticker).find((row) => String(row.symbol ?? '').toUpperCase() === input.plan.symbol.toUpperCase()) ?? rows(input.ticker)[0];
  const depthRow = rows(input.depth)[0];
  const bids = levelRows(depthRow?.bids, true);
  const asks = levelRows(depthRow?.asks, false);
  const currentPrice = positive(tickerRow?.markPrice ?? tickerRow?.lastPr ?? tickerRow?.price);
  const observedAtMs = timestampMs([tickerRow?.ts, depthRow?.ts]);
  const leverage = Math.max(1, Number(input.plan.leverage ?? 1));
  const requestedQuantity = Number(input.plan.quantity ?? 0);
  const requiredMargin = currentPrice != null ? currentPrice * requestedQuantity / leverage : 0;
  const available = positive(account?.available) ?? 0;
  const availableBalance = requiredMargin > 0
    ? input.plan.estimatedKrw / leverage * (available / requiredMargin)
    : 0;
  const equity = positive(account?.accountEquity ?? account?.usdtEquity ?? account?.equity);
  const exposureNotional = positionRows.reduce((sum, row) => {
    const quantity = absolute(row.total ?? row.available ?? row.size) ?? 0;
    const markPrice = positive(row.markPrice) ?? currentPrice ?? 0;
    return sum + quantity * markPrice;
  }, 0);
  const assetExposurePercent = equity != null && equity > 0 ? exposureNotional / equity * 100 : input.plan.marketSnapshot.assetExposurePercent;
  const currentPosition = positionRows.find((row) => (absolute(row.total ?? row.available ?? row.size) ?? 0) > 0);
  const existingPositionSide = currentPosition
    ? String(currentPosition.holdSide ?? '').toLowerCase() === 'short' ? 'short' : 'long'
    : null;
  const liquidationDistances = positionRows.flatMap((row) => {
    const markPrice = positive(row.markPrice) ?? currentPrice;
    const liquidationPrice = positive(row.liquidationPrice);
    return markPrice != null && liquidationPrice != null
      ? [Math.abs(markPrice - liquidationPrice) / markPrice * 100]
      : [];
  });
  const feeRate = absolute(input.contract.takerFeeRate ?? input.contract.takerFeeRatio ?? input.contract.feeRate);
  return baseSnapshot({
    plan: input.plan,
    source: 'bitget-private-account+public-market',
    observedAtMs,
    currentPrice,
    bids,
    asks,
    availableBalance,
    assetExposurePercent,
    openPositionCount: positionRows.filter((row) => (absolute(row.total ?? row.available ?? row.size) ?? 0) > 0).length,
    existingPositionSide,
    liquidationDistancePercent: liquidationDistances.length ? Math.min(...liquidationDistances) : null,
    estimatedFeePercent: feeRate == null ? null : feeRate * 100,
    signal: input.signal,
  });
}

export function buildUpbitExecutionSnapshot(input: {
  plan: TradingPlan;
  accounts: unknown;
  chance: JsonObject;
  ticker: unknown;
  orderbook: unknown;
  signal: SignalSnapshot;
}): TradingMarketSnapshot {
  const accountRows = rows(isRecord(input.accounts) && Array.isArray(input.accounts.data) ? input.accounts.data : input.accounts);
  const krw = accountRows.find((row) => String(row.currency ?? '').toUpperCase() === 'KRW');
  const baseCurrency = input.plan.symbol.toUpperCase().replace(/^KRW-/, '');
  const asset = accountRows.find((row) => String(row.currency ?? '').toUpperCase() === baseCurrency);
  const tickerRows = rows(isRecord(input.ticker) && Array.isArray(input.ticker.data) ? input.ticker.data : input.ticker);
  const tickerRow = tickerRows[0];
  const orderbookRows = isRecord(input.orderbook) && Array.isArray(input.orderbook.data)
    ? input.orderbook.data : input.orderbook;
  const book = objectLevels(orderbookRows);
  const currentPrice = positive(tickerRow?.trade_price);
  const observedAtMs = timestampMs([tickerRow?.timestamp, tickerRow?.trade_timestamp, book.timestamp]);
  const availableBalance = input.plan.side === 'sell'
    ? (positive(asset?.balance) ?? 0) * (currentPrice ?? 0)
    : positive(krw?.balance) ?? 0;
  const accountValue = positive(input.plan.marketSnapshot.accountValueKrw) ?? 0;
  const assetValue = (positive(asset?.balance) ?? 0) * (currentPrice ?? 0);
  const assetExposurePercent = accountValue > 0 ? assetValue / accountValue * 100 : input.plan.marketSnapshot.assetExposurePercent;
  const feeRate = absolute(input.plan.side === 'buy'
    ? input.chance.bid_fee ?? (isRecord(input.chance.bid) ? input.chance.bid.fee : null)
    : input.chance.ask_fee ?? (isRecord(input.chance.ask) ? input.chance.ask.fee : null));
  const marketState = isRecord(input.chance.market) ? String(input.chance.market.state ?? 'active') : 'active';
  return baseSnapshot({
    plan: input.plan,
    source: 'upbit-private-account+public-market',
    observedAtMs,
    currentPrice,
    bids: book.bids,
    asks: book.asks,
    availableBalance,
    assetExposurePercent,
    estimatedFeePercent: feeRate == null ? null : feeRate * 100,
    marketStatus: marketState === 'active' ? 'OPEN' : 'HALTED',
    signal: input.signal,
  });
}

export function buildKiwoomExecutionSnapshot(input: {
  plan: TradingPlan;
  orderable: JsonObject;
  unfilled: JsonObject;
  orderbook: JsonObject;
  signal: SignalSnapshot;
}): TradingMarketSnapshot {
  const book = kiwoomLevels(input.orderbook);
  const currentPrice = input.plan.side === 'buy' ? book.asks[0]?.price ?? null : book.bids[0]?.price ?? null;
  const providerTimestamp = finite(input.orderbook.timestamp ?? input.orderbook.ts);
  const observedAtMs = timestampMs([providerTimestamp]);
  const availableBalance = positive(
    input.orderable.ord_alow_amt
      ?? input.orderable.ord_psbl_cash
      ?? input.orderable.ord_psbl_amt
      ?? input.orderable.cash,
  ) ?? 0;
  const feePercent = absolute(input.plan.marketSnapshot.estimatedFeePercent);
  return baseSnapshot({
    plan: input.plan,
    source: 'kiwoom-private-account+orderbook',
    observedAtMs,
    currentPrice,
    bids: book.bids,
    asks: book.asks,
    availableBalance,
    openPositionCount: rows(input.unfilled).length,
    estimatedFeePercent: feePercent,
    marketStatus: 'OPEN',
    signal: input.signal,
  });
}
