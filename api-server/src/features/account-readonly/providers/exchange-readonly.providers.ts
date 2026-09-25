import { prepareBitgetAccount, prepareBitgetPendingOrders, prepareBitgetPositions, prepareUpbitAccounts, prepareUpbitOpenOrders, type BitgetCredentials, type PreparedExchangeRequest, type UpbitCredentials } from '../../../services/trade-exchange-adapters.service';
import { emptySnapshot, nullableNumber, type CanonicalAccountSnapshot, type CanonicalReadonlyOrder } from '../account-readonly.contract';
import { AccountReadonlyError } from '../account-readonly.errors';

export type SignedReadonlyTransport = (request: PreparedExchangeRequest, signal?: AbortSignal) => Promise<unknown>;
export type UpbitPublicQuoteReader = (markets: readonly string[], signal?: AbortSignal) => Promise<ReadonlyMap<string, number>>;
type Row = Record<string, unknown>;

const UPBIT_PUBLIC_ORIGIN = 'https://api.upbit.com';

export function createUpbitPublicQuoteReader(
  fetchImpl: typeof fetch = fetch,
  apiOrigin = UPBIT_PUBLIC_ORIGIN,
): UpbitPublicQuoteReader {
  const expectedOrigin = new URL(apiOrigin).origin;
  return async (markets, signal) => {
    const normalized = [...new Set(markets.map((market) => market.trim().toUpperCase()).filter(Boolean))];
    if (normalized.some((market) => !/^KRW-[A-Z0-9._-]+$/.test(market))) {
      throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_MARKET_INVALID');
    }
    const prices = new Map<string, number>();
    for (let index = 0; index < normalized.length; index += 100) {
      const chunk = normalized.slice(index, index + 100);
      if (chunk.length === 0) continue;
      const url = new URL('/v1/ticker', expectedOrigin);
      url.searchParams.set('markets', chunk.join(','));
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw new AccountReadonlyError('PROVIDER_TIMEOUT', true);
        throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_UNAVAILABLE', true);
      }
      if (!response.ok) {
        if (response.status === 418 || response.status === 429) throw new AccountReadonlyError('RATE_LIMITED', true);
        throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_UNAVAILABLE', response.status >= 500);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_RESPONSE_INVALID');
      }
      for (const row of rows(body, 'UPBIT_PUBLIC_QUOTE_RESPONSE_INVALID')) {
        const market = identity(row.market, 'UPBIT_PUBLIC_QUOTE_IDENTITY_INVALID');
        const price = optionalNonNegative(row.trade_price, 'UPBIT_PUBLIC_QUOTE_PRICE_INVALID');
        if (price == null || price <= 0) throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_PRICE_INVALID');
        if (!chunk.includes(market) || prices.has(market)) throw new AccountReadonlyError('UPBIT_PUBLIC_QUOTE_IDENTITY_INVALID');
        prices.set(market, price);
      }
    }
    return prices;
  };
}

function record(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rows(value: unknown, code: string): Row[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error(code);
  return value;
}

function identity(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim().toUpperCase();
}

function total(balance: number | null, locked: number | null) {
  if (balance === null || locked === null || balance < 0 || locked < 0) return null;
  const result = balance + locked;
  return Number.isFinite(result) ? result : null;
}

function optionalNonNegative(value: unknown, code: string) {
  if (value == null || value === '') return null;
  const parsed = nullableNumber(value);
  if (parsed === null || parsed < 0) throw new Error(code);
  return parsed;
}

function requiredText(value: unknown, code: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(code);
  return value.trim();
}

function remainingQuantity(quantity: number | null, filled: number | null, code: string) {
  if (quantity === null || filled === null) return null;
  if (filled > quantity) throw new Error(code);
  return quantity - filled;
}

function partialOpenOrdersError(provider: 'UPBIT' | 'BITGET', error: AccountReadonlyError) {
  return `${provider}_OPEN_ORDERS_${error.code}`;
}

async function readUpbitOpenOrderSnapshot(
  credentials: UpbitCredentials,
  transport: SignedReadonlyTransport,
  signal?: AbortSignal,
): Promise<{ openOrders: CanonicalReadonlyOrder[] | null; errorCode: string | null }> {
  try {
    const [waitRaw, watchRaw] = await Promise.all([
      transport(prepareUpbitOpenOrders(credentials, 'wait'), signal),
      transport(prepareUpbitOpenOrders(credentials, 'watch'), signal),
    ]);
    const orders = [...rows(waitRaw, 'UPBIT_OPEN_ORDERS_RESPONSE_INVALID'), ...rows(watchRaw, 'UPBIT_OPEN_ORDERS_RESPONSE_INVALID')]
      .map((row): CanonicalReadonlyOrder => ({
        id: requiredText(row.uuid, 'UPBIT_OPEN_ORDER_IDENTITY_INVALID'),
        market: 'UPBIT',
        symbol: identity(row.market, 'UPBIT_OPEN_ORDER_MARKET_INVALID'),
        side: row.side === 'bid' ? 'BUY' : row.side === 'ask' ? 'SELL' : null,
        price: optionalNonNegative(row.price, 'UPBIT_OPEN_ORDER_PRICE_INVALID'),
        quantity: optionalNonNegative(row.volume, 'UPBIT_OPEN_ORDER_QUANTITY_INVALID'),
        remainingQuantity: optionalNonNegative(row.remaining_volume, 'UPBIT_OPEN_ORDER_REMAINING_INVALID'),
        status: typeof row.state === 'string' && row.state.trim() ? row.state.trim() : null,
      }));
    const ids = orders.map((row) => row.id).filter((value): value is string => Boolean(value));
    if (new Set(ids).size !== ids.length) throw new Error('UPBIT_OPEN_ORDER_IDENTITY_DUPLICATE');
    return { openOrders: orders, errorCode: null };
  } catch (error) {
    if (error instanceof AccountReadonlyError) {
      return { openOrders: null, errorCode: partialOpenOrdersError('UPBIT', error) };
    }
    throw error;
  }
}

function bitgetApplicationFailure(code: string) {
  if (code === '40018' || code === '40038') return new AccountReadonlyError('BITGET_IP_NOT_ALLOWED');
  if (code === '40014') return new AccountReadonlyError('BITGET_PERMISSION_DENIED');
  if (code === '40006' || code === '40009' || code === '40036') return new AccountReadonlyError('BITGET_AUTH_FAILED');
  if (code === '40008') return new AccountReadonlyError('BITGET_TIMESTAMP_REJECTED', true);
  if (code === '429') return new AccountReadonlyError('RATE_LIMITED', true);
  return new AccountReadonlyError('BITGET_REQUEST_REJECTED');
}

export async function readUpbitSnapshot(
  credentials: UpbitCredentials,
  transport: SignedReadonlyTransport,
  signal?: AbortSignal,
  now = new Date(),
  publicQuotes?: UpbitPublicQuoteReader,
): Promise<CanonicalAccountSnapshot> {
  const raw = rows(await transport(prepareUpbitAccounts(credentials), signal), 'UPBIT_ACCOUNT_RESPONSE_INVALID');
  const base = raw.map((row) => {
    const available = optionalNonNegative(row.balance, 'UPBIT_ACCOUNT_BALANCE_INVALID');
    const locked = optionalNonNegative(row.locked, 'UPBIT_ACCOUNT_LOCKED_INVALID');
    const currency = identity(row.currency, 'UPBIT_ACCOUNT_IDENTITY_INVALID');
    const unitCurrency = typeof row.unit_currency === 'string' && row.unit_currency.trim()
      ? row.unit_currency.trim().toUpperCase()
      : null;
    return {
      row,
      currency,
      unitCurrency,
      available,
      locked,
      total: total(available, locked),
      averageEntryPrice: optionalNonNegative(row.avg_buy_price, 'UPBIT_ACCOUNT_AVG_PRICE_INVALID'),
    };
  });
  if (new Set(base.map((row) => row.currency)).size !== base.length) throw new Error('UPBIT_ACCOUNT_IDENTITY_DUPLICATE');

  const valuationMarkets = base
    .filter((row) => row.currency !== 'KRW' && row.unitCurrency === 'KRW' && (row.total ?? 0) > 0)
    .map((row) => `KRW-${row.currency}`);
  let quotePrices: ReadonlyMap<string, number> = new Map();
  let valuationUnavailable = false;
  if (publicQuotes && valuationMarkets.length > 0) {
    try {
      quotePrices = await publicQuotes(valuationMarkets, signal);
    } catch {
      valuationUnavailable = true;
    }
  }

  const balances = base.map((row) => {
    const currentPrice = row.currency === 'KRW'
      ? 1
      : row.unitCurrency === 'KRW'
        ? quotePrices.get(`KRW-${row.currency}`) ?? null
        : null;
    const estimatedKrwValue = row.total === 0
      ? 0
      : row.total != null && currentPrice != null
        ? row.total * currentPrice
        : null;
    return {
      currency: row.currency,
      available: row.available,
      locked: row.locked,
      total: row.total,
      estimatedKrwValue: Number.isFinite(estimatedKrwValue ?? Number.NaN) ? estimatedKrwValue : null,
    };
  });

  const positions = base.map((row, index) => {
    const currentPrice = row.currency === 'KRW'
      ? 1
      : row.unitCurrency === 'KRW'
        ? quotePrices.get(`KRW-${row.currency}`) ?? null
        : null;
    const marketValue = balances[index].estimatedKrwValue;
    const averageEntryPrice = row.averageEntryPrice;
    const unrealizedPnl = row.currency !== 'KRW'
      && row.total != null
      && currentPrice != null
      && averageEntryPrice != null
      && averageEntryPrice > 0
      ? (currentPrice - averageEntryPrice) * row.total
      : null;
    const unrealizedPnlPercent = row.currency !== 'KRW'
      && currentPrice != null
      && averageEntryPrice != null
      && averageEntryPrice > 0
      ? ((currentPrice - averageEntryPrice) / averageEntryPrice) * 100
      : null;
    return {
      market: 'UPBIT', symbol: row.currency, quantity: row.total,
      availableQuantity: row.available, averageEntryPrice,
      currentPrice, marketValue,
      unrealizedPnl: Number.isFinite(unrealizedPnl ?? Number.NaN) ? unrealizedPnl : null,
      unrealizedPnlPercent: Number.isFinite(unrealizedPnlPercent ?? Number.NaN) ? unrealizedPnlPercent : null,
      leverage: null, liquidationPrice: null, marginMode: null, side: null,
    };
  });

  const open = await readUpbitOpenOrderSnapshot(credentials, transport, signal);
  const checkedAt = now.toISOString();
  return {
    ...emptySnapshot(
      'upbit',
      'CONNECTED',
      checkedAt,
      open.errorCode ?? (valuationUnavailable ? 'UPBIT_PUBLIC_VALUATION_UNAVAILABLE' : null),
    ),
    connected: true,
    balances,
    positions,
    openOrders: open.openOrders,
    lastGoodAt: checkedAt,
  };
}

export async function readBitgetSnapshot(credentials: BitgetCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const pendingPromise = transport(prepareBitgetPendingOrders(credentials), signal)
    .then((value) => ({ value, error: null as AccountReadonlyError | null }))
    .catch((error: unknown) => {
      if (error instanceof AccountReadonlyError) return { value: null, error };
      throw error;
    });
  const [accountRaw, positionRaw, pendingResult] = await Promise.all([
    transport(prepareBitgetAccount(credentials), signal),
    transport(prepareBitgetPositions(credentials), signal),
    pendingPromise,
  ]);
  const data = (value: unknown) => {
    if (!record(value)) throw new Error('BITGET_ACCOUNT_RESPONSE_INVALID');
    const code = typeof value.code === 'string' || typeof value.code === 'number'
      ? String(value.code)
      : '';
    if (!code) throw new Error('BITGET_ACCOUNT_RESPONSE_INVALID');
    if (code !== '00000') throw bitgetApplicationFailure(code);
    return rows(value.data, 'BITGET_ACCOUNT_RESPONSE_INVALID');
  };
  const balances = data(accountRaw).map((row) => ({
    currency: identity(row.marginCoin, 'BITGET_ACCOUNT_IDENTITY_INVALID'),
    available: nullableNumber(row.available), locked: nullableNumber(row.locked ?? row.occupied),
    total: nullableNumber(row.accountEquity), estimatedKrwValue: null,
  }));
  if (new Set(balances.map((row) => row.currency)).size !== balances.length) throw new Error('BITGET_ACCOUNT_IDENTITY_DUPLICATE');
  const positions = data(positionRaw).map((row) => {
    const quantity = optionalNonNegative(row.total, 'BITGET_POSITION_QUANTITY_INVALID');
    const availableQuantity = optionalNonNegative(row.available, 'BITGET_POSITION_AVAILABLE_INVALID');
    const averageEntryPrice = optionalNonNegative(row.openPriceAvg, 'BITGET_POSITION_AVG_PRICE_INVALID');
    const currentPrice = optionalNonNegative(row.markPrice, 'BITGET_POSITION_MARK_PRICE_INVALID');
    const unrealizedPnl = nullableNumber(row.unrealizedPL);
    const marketValue = quantity === 0
      ? 0
      : quantity != null && currentPrice != null
        ? Math.abs(quantity) * currentPrice
        : null;
    const entryNotional = quantity != null && averageEntryPrice != null
      ? Math.abs(quantity) * averageEntryPrice
      : null;
    const unrealizedPnlPercent = unrealizedPnl != null && entryNotional != null && entryNotional > 0
      ? (unrealizedPnl / entryNotional) * 100
      : null;
    return {
      market: 'BITGET', symbol: identity(row.symbol, 'BITGET_POSITION_IDENTITY_INVALID'),
      quantity, availableQuantity,
      averageEntryPrice, currentPrice,
      marketValue: Number.isFinite(marketValue ?? Number.NaN) ? marketValue : null,
      unrealizedPnl,
      unrealizedPnlPercent: Number.isFinite(unrealizedPnlPercent ?? Number.NaN) ? unrealizedPnlPercent : null,
      leverage: optionalNonNegative(row.leverage, 'BITGET_POSITION_LEVERAGE_INVALID'),
      liquidationPrice: optionalNonNegative(row.liquidationPrice, 'BITGET_POSITION_LIQUIDATION_INVALID'),
      marginMode: typeof row.marginMode === 'string' ? row.marginMode : null,
      side: typeof row.holdSide === 'string' ? row.holdSide : null,
    };
  });
  let openOrders: CanonicalReadonlyOrder[] | null = null;
  let openOrderError: string | null = null;
  if (pendingResult.error) {
    openOrderError = partialOpenOrdersError('BITGET', pendingResult.error);
  } else {
    const envelope = pendingResult.value;
    if (!record(envelope)) throw new Error('BITGET_OPEN_ORDERS_RESPONSE_INVALID');
    const code = typeof envelope.code === 'string' || typeof envelope.code === 'number'
      ? String(envelope.code)
      : '';
    if (!code) throw new Error('BITGET_OPEN_ORDERS_RESPONSE_INVALID');
    if (code !== '00000') {
      openOrderError = partialOpenOrdersError('BITGET', bitgetApplicationFailure(code));
    } else {
      const payload = envelope.data;
      if (!record(payload)) throw new Error('BITGET_OPEN_ORDERS_RESPONSE_INVALID');
      openOrders = rows(payload.entrustedList, 'BITGET_OPEN_ORDERS_RESPONSE_INVALID').map((row) => {
        const quantity = optionalNonNegative(row.size, 'BITGET_OPEN_ORDER_QUANTITY_INVALID');
        const filled = optionalNonNegative(row.baseVolume, 'BITGET_OPEN_ORDER_FILLED_INVALID');
        return {
          id: typeof row.orderId === 'string' && row.orderId.trim() ? row.orderId.trim() : null,
          market: 'BITGET',
          symbol: identity(row.symbol, 'BITGET_OPEN_ORDER_SYMBOL_INVALID'),
          side: row.side === 'buy' ? 'BUY' : row.side === 'sell' ? 'SELL' : null,
          price: optionalNonNegative(row.price, 'BITGET_OPEN_ORDER_PRICE_INVALID'),
          quantity,
          remainingQuantity: remainingQuantity(quantity, filled, 'BITGET_OPEN_ORDER_FILLED_EXCEEDS_QUANTITY'),
          status: typeof row.status === 'string' && row.status.trim() ? row.status.trim() : null,
        } satisfies CanonicalReadonlyOrder;
      });
      const ids = openOrders.map((row) => row.id).filter((value): value is string => Boolean(value));
      if (new Set(ids).size !== ids.length) throw new Error('BITGET_OPEN_ORDER_IDENTITY_DUPLICATE');
    }
  }

  const checkedAt = now.toISOString();
  return {
    ...emptySnapshot('bitget', 'CONNECTED', checkedAt, openOrderError),
    connected: true,
    balances,
    positions,
    openOrders,
    lastGoodAt: checkedAt,
  };
}
