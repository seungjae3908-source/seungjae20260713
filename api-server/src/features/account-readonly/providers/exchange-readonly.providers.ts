import {
  prepareBitgetAccount,
  prepareBitgetPendingOrders,
  prepareBitgetPositions,
  prepareBitgetUtaAccountInfo,
  prepareBitgetUtaAssets,
  prepareBitgetUtaPendingOrders,
  prepareBitgetUtaPositions,
  prepareUpbitAccounts,
  prepareUpbitOpenOrders,
  type BitgetCredentials,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from '../../../services/trade-exchange-adapters.service';
import { emptySnapshot, nullableNumber, type CanonicalAccountSnapshot, type CanonicalReadonlyOrder } from '../account-readonly.contract';
import { AccountReadonlyError } from '../account-readonly.errors';

export type SignedReadonlyTransport = (request: PreparedExchangeRequest, signal?: AbortSignal) => Promise<unknown>;
type Row = Record<string, unknown>;

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

export async function readUpbitSnapshot(credentials: UpbitCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
  const raw = rows(await transport(prepareUpbitAccounts(credentials), signal), 'UPBIT_ACCOUNT_RESPONSE_INVALID');
  const balances = raw.map((row) => {
    const available = nullableNumber(row.balance);
    const locked = nullableNumber(row.locked);
    return { currency: identity(row.currency, 'UPBIT_ACCOUNT_IDENTITY_INVALID'), available, locked, total: total(available, locked), estimatedKrwValue: null };
  });
  if (new Set(balances.map((row) => row.currency)).size !== balances.length) throw new Error('UPBIT_ACCOUNT_IDENTITY_DUPLICATE');
  const positions = raw.map((row, index) => ({
    market: 'UPBIT', symbol: balances[index].currency, quantity: balances[index].total,
    availableQuantity: balances[index].available, averageEntryPrice: nullableNumber(row.avg_buy_price),
    currentPrice: null, marketValue: null, unrealizedPnl: null, unrealizedPnlPercent: null,
    leverage: null, liquidationPrice: null, marginMode: null, side: null,
  }));
  const open = await readUpbitOpenOrderSnapshot(credentials, transport, signal);
  const checkedAt = now.toISOString();
  return {
    ...emptySnapshot('upbit', 'CONNECTED', checkedAt, open.errorCode),
    connected: true,
    balances,
    positions,
    openOrders: open.openOrders,
    lastGoodAt: checkedAt,
  };
}

async function readBitgetClassicSnapshot(credentials: BitgetCredentials, transport: SignedReadonlyTransport, signal?: AbortSignal, now = new Date()): Promise<CanonicalAccountSnapshot> {
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
  const positions = data(positionRaw).map((row) => ({
    market: 'BITGET', symbol: identity(row.symbol, 'BITGET_POSITION_IDENTITY_INVALID'),
    quantity: nullableNumber(row.total), availableQuantity: nullableNumber(row.available),
    averageEntryPrice: nullableNumber(row.openPriceAvg), currentPrice: nullableNumber(row.markPrice),
    marketValue: null, unrealizedPnl: nullableNumber(row.unrealizedPL), unrealizedPnlPercent: null,
    leverage: nullableNumber(row.leverage), liquidationPrice: nullableNumber(row.liquidationPrice),
    marginMode: typeof row.marginMode === 'string' ? row.marginMode : null,
    side: typeof row.holdSide === 'string' ? row.holdSide : null,
  }));
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

function bitgetAccountMode(value: unknown): 'classic' | 'uta' {
  if (!record(value)) throw new Error('BITGET_ACCOUNT_INFO_RESPONSE_INVALID');
  const code = typeof value.code === 'string' || typeof value.code === 'number'
    ? String(value.code)
    : '';
  if (!code) throw new Error('BITGET_ACCOUNT_INFO_RESPONSE_INVALID');
  if (code === '25245') return 'classic';
  if (code !== '00000') throw bitgetApplicationFailure(code);

  const payload = value.data;
  if (!record(payload)) throw new Error('BITGET_ACCOUNT_INFO_RESPONSE_INVALID');
  const permissions = Array.isArray(payload.permissions)
    ? payload.permissions.filter((item): item is string => typeof item === 'string')
    : [];
  return permissions.includes('uta_trade') || permissions.includes('uta_mgt')
    ? 'uta'
    : 'classic';
}

function bitgetUtaData(value: unknown, code: string): Row {
  if (!record(value)) throw new Error(code);
  const providerCode = typeof value.code === 'string' || typeof value.code === 'number'
    ? String(value.code)
    : '';
  if (!providerCode) throw new Error(code);
  if (providerCode !== '00000') throw bitgetApplicationFailure(providerCode);
  if (!record(value.data)) throw new Error(code);
  return value.data;
}

async function readBitgetUtaSnapshot(
  credentials: BitgetCredentials,
  transport: SignedReadonlyTransport,
  signal?: AbortSignal,
  now = new Date(),
): Promise<CanonicalAccountSnapshot> {
  const pendingPromise = transport(prepareBitgetUtaPendingOrders(credentials), signal)
    .then((value) => ({ value, error: null as AccountReadonlyError | null }))
    .catch((error: unknown) => {
      if (error instanceof AccountReadonlyError) return { value: null, error };
      throw error;
    });

  const [accountRaw, positionRaw, pendingResult] = await Promise.all([
    transport(prepareBitgetUtaAssets(credentials), signal),
    transport(prepareBitgetUtaPositions(credentials), signal),
    pendingPromise,
  ]);

  const accountData = bitgetUtaData(accountRaw, 'BITGET_UTA_ACCOUNT_RESPONSE_INVALID');
  const balances = rows(accountData.assets, 'BITGET_UTA_ACCOUNT_RESPONSE_INVALID').map((row) => ({
    currency: identity(row.coin, 'BITGET_UTA_ACCOUNT_IDENTITY_INVALID'),
    available: nullableNumber(row.available),
    locked: nullableNumber(row.locked),
    total: nullableNumber(row.equity ?? row.balance),
    estimatedKrwValue: null,
  }));
  if (new Set(balances.map((row) => row.currency)).size !== balances.length) {
    throw new Error('BITGET_UTA_ACCOUNT_IDENTITY_DUPLICATE');
  }

  const positionData = bitgetUtaData(positionRaw, 'BITGET_UTA_POSITION_RESPONSE_INVALID');
  const positions = rows(positionData.list, 'BITGET_UTA_POSITION_RESPONSE_INVALID').map((row) => ({
    market: 'BITGET',
    symbol: identity(row.symbol, 'BITGET_UTA_POSITION_IDENTITY_INVALID'),
    quantity: nullableNumber(row.total),
    availableQuantity: nullableNumber(row.available),
    averageEntryPrice: nullableNumber(row.avgPrice),
    currentPrice: nullableNumber(row.markPrice),
    marketValue: null,
    unrealizedPnl: nullableNumber(row.unrealisedPnl),
    unrealizedPnlPercent: null,
    leverage: nullableNumber(row.leverage),
    liquidationPrice: nullableNumber(row.liquidationPrice),
    marginMode: typeof row.marginMode === 'string' ? row.marginMode : null,
    side: typeof row.posSide === 'string' ? row.posSide : null,
  }));

  let openOrders: CanonicalReadonlyOrder[] | null = null;
  let openOrderError: string | null = null;
  if (pendingResult.error) {
    openOrderError = partialOpenOrdersError('BITGET', pendingResult.error);
  } else {
    const envelope = pendingResult.value;
    if (!record(envelope)) throw new Error('BITGET_UTA_OPEN_ORDERS_RESPONSE_INVALID');
    const providerCode = typeof envelope.code === 'string' || typeof envelope.code === 'number'
      ? String(envelope.code)
      : '';
    if (!providerCode) throw new Error('BITGET_UTA_OPEN_ORDERS_RESPONSE_INVALID');
    if (providerCode !== '00000') {
      openOrderError = partialOpenOrdersError('BITGET', bitgetApplicationFailure(providerCode));
    } else {
      if (!record(envelope.data)) throw new Error('BITGET_UTA_OPEN_ORDERS_RESPONSE_INVALID');
      openOrders = rows(envelope.data.list, 'BITGET_UTA_OPEN_ORDERS_RESPONSE_INVALID').map((row) => {
        const quantity = optionalNonNegative(row.qty, 'BITGET_UTA_OPEN_ORDER_QUANTITY_INVALID');
        const filled = optionalNonNegative(row.cumExecQty, 'BITGET_UTA_OPEN_ORDER_FILLED_INVALID');
        return {
          id: typeof row.orderId === 'string' && row.orderId.trim() ? row.orderId.trim() : null,
          market: 'BITGET',
          symbol: identity(row.symbol, 'BITGET_UTA_OPEN_ORDER_SYMBOL_INVALID'),
          side: row.side === 'buy' ? 'BUY' : row.side === 'sell' ? 'SELL' : null,
          price: optionalNonNegative(row.price, 'BITGET_UTA_OPEN_ORDER_PRICE_INVALID'),
          quantity,
          remainingQuantity: remainingQuantity(quantity, filled, 'BITGET_UTA_OPEN_ORDER_FILLED_EXCEEDS_QUANTITY'),
          status: typeof row.orderStatus === 'string' && row.orderStatus.trim() ? row.orderStatus.trim() : null,
        } satisfies CanonicalReadonlyOrder;
      });
      const ids = openOrders.map((row) => row.id).filter((value): value is string => Boolean(value));
      if (new Set(ids).size !== ids.length) throw new Error('BITGET_UTA_OPEN_ORDER_IDENTITY_DUPLICATE');
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

export async function readBitgetSnapshot(
  credentials: BitgetCredentials,
  transport: SignedReadonlyTransport,
  signal?: AbortSignal,
  now = new Date(),
): Promise<CanonicalAccountSnapshot> {
  let mode: 'classic' | 'uta';
  try {
    mode = bitgetAccountMode(
      await transport(prepareBitgetUtaAccountInfo(credentials), signal),
    );
  } catch (error) {
    if (error instanceof AccountReadonlyError && error.code === 'BITGET_REQUEST_REJECTED') {
      mode = 'classic';
    } else {
      throw error;
    }
  }

  return mode === 'uta'
    ? readBitgetUtaSnapshot(credentials, transport, signal, now)
    : readBitgetClassicSnapshot(credentials, transport, signal, now);
}

