import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import { isTransientTradingProviderError, tradingProviderHttpErrorCode, tradingProviderNetworkErrorCode, tradingProviderTimeoutCode } from './trade-provider-http-error.service';
import {
  prepareBitgetOrderQuery,
  prepareKiwoomDomesticOrderHistory,
  prepareKiwoomToken,
  prepareKiwoomUnfilled,
  prepareKiwoomUsOrderHistory,
  prepareKiwoomUsUnfilled,
  prepareTossOpenOrders,
  prepareTossOrderQuery,
  prepareTossToken,
  prepareUpbitOrderQuery,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type TossCredentials,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import type {
  TradingExchangeOrderSnapshot,
  TradingFill,
  TradingOrder,
  TradingPlan,
} from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  toss: 'https://openapi.tossinvest.com',
};

const QUANTITY_EPSILON = 1e-12;

function isRecord(value: unknown): value is ExchangePayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  const parsed = String(value ?? '').trim();
  return parsed ? parsed : null;
}

function timestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function invalidResponseCode(baseUrl: string) {
  if (baseUrl.includes('bitget.com')) return 'BITGET_INVALID_RESPONSE';
  if (baseUrl.includes('upbit.com')) return 'UPBIT_INVALID_RESPONSE';
  if (baseUrl.includes('kiwoom.com')) return 'KIWOOM_INVALID_RESPONSE';
  if (baseUrl.includes('tossinvest.com')) return 'TOSS_INVALID_RESPONSE';
  return 'EXCHANGE_INVALID_RESPONSE';
}

async function sendRecoveryRequest(baseUrl: string, request: PreparedExchangeRequest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const url = `${baseUrl}${request.path}${request.query ? `?${request.query}` : ''}`;
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(tradingProviderHttpErrorCode(baseUrl, response.status));
    const raw = await response.text();
    if (!raw.trim()) throw new Error(invalidResponseCode(baseUrl));
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error(invalidResponseCode(baseUrl));
    }
    if (!isRecord(payload)) throw new Error(invalidResponseCode(baseUrl));
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(tradingProviderTimeoutCode(baseUrl));
    if (error instanceof TypeError) throw new Error(tradingProviderNetworkErrorCode(baseUrl));
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function bitgetData(payload: ExchangePayload, expectedClientOid: string) {
  const code = text(payload.code);
  if (!code) throw new Error('BITGET_INVALID_RESPONSE');
  if (code !== '00000') throw new Error(`BITGET_${code}`);
  const candidate = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!isRecord(candidate)) throw new Error('BITGET_INVALID_RESPONSE');
  if (text(candidate.clientOid) !== expectedClientOid) throw new Error('BITGET_INVALID_RESPONSE');
  return candidate;
}

function upbitData(payload: ExchangePayload, expectedIdentifier: string) {
  if (payload.error) throw new Error('UPBIT_ORDER_LOOKUP_FAILED');
  if (text(payload.identifier) !== expectedIdentifier) throw new Error('UPBIT_INVALID_RESPONSE');
  return payload;
}

function stateFromBitget(status: string, filledQuantity: number): TradingExchangeOrderSnapshot['state'] | null {
  if (['live', 'new', 'init', 'pending', 'accepted'].includes(status)) {
    return filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED';
  }
  if (['partially_filled', 'partial_fill', 'partial-filled'].includes(status)) return 'PARTIALLY_FILLED';
  if (['filled', 'full_fill', 'completed'].includes(status)) return 'FILLED';
  if (['cancelled', 'canceled'].includes(status)) return 'CANCELED';
  if (['rejected', 'failed'].includes(status)) return 'REJECTED';
  return null;
}

function stateFromUpbit(status: string, filledQuantity: number): TradingExchangeOrderSnapshot['state'] | null {
  if (['wait', 'watch'].includes(status)) return filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED';
  if (status === 'done') return 'FILLED';
  if (status === 'cancel') return 'CANCELED';
  return null;
}

function fillFromRow(row: ExchangePayload, fallbackId: string, fallbackTime: string | null): TradingFill | null {
  const price = finiteNumber(row.price ?? row.fillPrice ?? row.trade_price);
  const quantity = finiteNumber(row.quantity ?? row.size ?? row.volume ?? row.fillQuantity ?? row.fillSz);
  if (price === null || price <= 0 || quantity === null || quantity <= 0) return null;
  return {
    id: text(row.id ?? row.tradeId ?? row.uuid) ?? fallbackId,
    price,
    quantity,
    feeAmount: finiteNumber(row.feeAmount ?? row.fee ?? row.paid_fee),
    feeCurrency: text(row.feeCurrency ?? row.feeCcy ?? row.fee_currency),
    filledAt: timestamp(row.filledAt ?? row.trade_time_utc ?? row.created_at ?? row.uTime) ?? fallbackTime ?? new Date(0).toISOString(),
  };
}

function bitgetSnapshot(payload: ExchangePayload, plan: TradingPlan, order: TradingOrder): TradingExchangeOrderSnapshot {
  const row = bitgetData(payload, order.clientOrderId);
  if (text(row.symbol)?.toUpperCase() !== plan.symbol.toUpperCase()) {
    throw new Error('BITGET_ORDER_IDENTITY_MISMATCH');
  }
  const providerStatusCode = String(row.status ?? row.state ?? '').toLowerCase();
  const requestedQuantity = finiteNumber(row.size ?? row.quantity ?? row.qty) ?? order.requestedQuantity;
  const filledQuantity = finiteNumber(row.baseVolume ?? row.filledQty ?? row.filledQuantity ?? row.accBaseVolume) ?? 0;
  const remainingQuantity = requestedQuantity === null ? null : Math.max(0, requestedQuantity - filledQuantity);
  const state = stateFromBitget(providerStatusCode, filledQuantity);
  if (!state) throw new Error('BITGET_ORDER_STATUS_UNKNOWN');
  const updatedAt = timestamp(row.uTime ?? row.updatedTime ?? row.updated_at);
  const rawFills = Array.isArray(row.fills) ? row.fills.filter(isRecord) : [];
  const fills = rawFills.map((fill, index) => fillFromRow(fill, `bitget-${order.id}-${index}`, updatedAt)).filter((fill): fill is TradingFill => fill !== null);
  return {
    exchangeOrderId: text(row.orderId ?? row.order_id) ?? order.exchangeOrderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: finiteNumber(row.priceAvg ?? row.averagePrice ?? row.avgPrice),
    fills,
    feeAmount: finiteNumber(row.feeAmount ?? row.fee),
    feeCurrency: text(row.feeCurrency ?? row.feeCcy),
    exchangeCreatedAt: timestamp(row.cTime ?? row.createdTime ?? row.created_at),
    exchangeUpdatedAt: updatedAt,
    cancelable: state === 'ACCEPTED' || state === 'PARTIALLY_FILLED',
    providerStatusCode,
  };
}

function upbitSnapshot(payload: ExchangePayload, plan: TradingPlan, order: TradingOrder): TradingExchangeOrderSnapshot {
  const row = upbitData(payload, order.clientOrderId);
  const expectedMarket = `KRW-${plan.symbol.toUpperCase().replace(/^KRW-/, '')}`;
  if (text(row.market)?.toUpperCase() !== expectedMarket) throw new Error('UPBIT_ORDER_IDENTITY_MISMATCH');
  const providerStatusCode = String(row.state ?? '').toLowerCase();
  const requestedQuantity = finiteNumber(row.volume) ?? order.requestedQuantity;
  const filledQuantity = finiteNumber(row.executed_volume) ?? 0;
  const remainingQuantity = finiteNumber(row.remaining_volume)
    ?? (requestedQuantity === null ? null : Math.max(0, requestedQuantity - filledQuantity));
  const state = stateFromUpbit(providerStatusCode, filledQuantity);
  if (!state) throw new Error('UPBIT_ORDER_STATUS_UNKNOWN');
  const rawFills = Array.isArray(row.trades) ? row.trades.filter(isRecord) : [];
  const createdAt = timestamp(row.created_at);
  const fills = rawFills.map((fill, index) => fillFromRow(fill, `upbit-${order.id}-${index}`, createdAt)).filter((fill): fill is TradingFill => fill !== null);
  const weightedValue = fills.reduce((sum, fill) => sum + fill.price * fill.quantity, 0);
  const weightedQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  return {
    exchangeOrderId: text(row.uuid) ?? order.exchangeOrderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: weightedQuantity > 0 ? weightedValue / weightedQuantity : finiteNumber(row.price),
    fills,
    feeAmount: finiteNumber(row.paid_fee),
    feeCurrency: 'KRW',
    exchangeCreatedAt: createdAt,
    exchangeUpdatedAt: fills.length > 0 ? fills[fills.length - 1].filledAt : createdAt,
    cancelable: state === 'ACCEPTED' || state === 'PARTIALLY_FILLED',
    providerStatusCode,
  };
}


function tossData(payload: ExchangePayload) {
  if (payload.error) throw new Error('TOSS_ORDER_LOOKUP_FAILED');
  const code = text(payload.code ?? payload.return_code);
  if (code && !['0', '00000', 'SUCCESS'].includes(code.toUpperCase())) throw new Error(`TOSS_${code}`);
  return isRecord(payload.result) ? payload.result : payload;
}

function tossToken(payload: ExchangePayload) {
  const row = isRecord(payload.result) ? payload.result : isRecord(payload.data) ? payload.data : payload;
  const token = text(row.access_token ?? row.accessToken ?? payload.access_token);
  if (!token) throw new Error('TOSS_TOKEN_MISSING');
  return token;
}

function stateFromToss(status: string, filledQuantity: number): TradingExchangeOrderSnapshot['state'] | null {
  if (['open', 'pending', 'accepted', 'waiting'].includes(status)) {
    return filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED';
  }
  if (['partially_filled', 'partial_fill', 'partial-filled'].includes(status)) return 'PARTIALLY_FILLED';
  if (['filled', 'completed', 'done'].includes(status)) return 'FILLED';
  if (['cancelled', 'canceled', 'cancel'].includes(status)) return 'CANCELED';
  if (['rejected', 'failed', 'expired'].includes(status)) return 'REJECTED';
  return null;
}

function tossSnapshot(payload: ExchangePayload, plan: TradingPlan, order: TradingOrder): TradingExchangeOrderSnapshot {
  const row = tossData(payload);
  const orderId = text(row.orderId ?? row.order_id);
  if (!orderId || (order.exchangeOrderId && order.exchangeOrderId !== orderId)) {
    throw new Error('TOSS_ORDER_IDENTITY_MISMATCH');
  }
  if (text(row.symbol)?.toUpperCase() !== plan.symbol.toUpperCase()) throw new Error('TOSS_ORDER_IDENTITY_MISMATCH');
  const execution = isRecord(row.execution) ? row.execution : {};
  const requestedQuantity = finiteNumber(row.quantity) ?? order.requestedQuantity;
  const filledQuantity = finiteNumber(execution.filledQuantity ?? row.filledQuantity ?? row.executedQuantity) ?? 0;
  const remainingQuantity = finiteNumber(row.remainingQuantity)
    ?? (requestedQuantity === null ? null : Math.max(0, requestedQuantity - filledQuantity));
  const providerStatusCode = String(row.status ?? row.orderStatus ?? row.state ?? '').toLowerCase();
  const state = stateFromToss(providerStatusCode, filledQuantity);
  if (!state) throw new Error('TOSS_ORDER_STATUS_UNKNOWN');
  return {
    exchangeOrderId: orderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: finiteNumber(execution.averageFillPrice ?? execution.averagePrice ?? row.averageFillPrice),
    fills: [],
    feeAmount: finiteNumber(execution.feeAmount ?? row.feeAmount),
    feeCurrency: text(execution.feeCurrency ?? row.feeCurrency),
    exchangeCreatedAt: timestamp(row.createdAt ?? row.created_at),
    exchangeUpdatedAt: timestamp(row.updatedAt ?? row.updated_at ?? execution.updatedAt),
    cancelable: state === 'ACCEPTED' || state === 'PARTIALLY_FILLED',
    providerStatusCode,
  };
}

function tossOpenOrderId(payload: ExchangePayload, expectedClientOrderId: string) {
  const result = payload.result;
  const values = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.orders) ? result.orders : [];
  for (const row of values.filter(isRecord)) {
    if (text(row.clientOrderId ?? row.client_order_id) === expectedClientOrderId) {
      return text(row.orderId ?? row.order_id);
    }
  }
  return null;
}

function assertKiwoom(payload: ExchangePayload) {
  const raw = payload.return_code ?? payload.returnCode ?? payload.code;
  if (raw == null || !['0', '00000', '20'].includes(String(raw))) {
    throw new Error(`KIWOOM_${String(raw ?? 'INVALID_RESPONSE')}`);
  }
  return payload;
}

function kiwoomToken(payload: ExchangePayload) {
  const nested = isRecord(payload.data) ? payload.data : null;
  const token = text(payload.token ?? nested?.token);
  if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
  return token;
}

function kiwoomRows(payload: ExchangePayload, key: string) {
  const value = payload[key];
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('KIWOOM_INVALID_RESPONSE');
  return value;
}

function kiwoomOrderDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('KIWOOM_ORDER_DATE_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}${map.month}${map.day}`;
}

function kiwoomDomesticOpenSnapshot(
  payload: ExchangePayload,
  plan: TradingPlan,
  order: TradingOrder,
): TradingExchangeOrderSnapshot | null {
  assertKiwoom(payload);
  const row = kiwoomRows(payload, 'oso')
    .find((item) => text(item.ord_no ?? item.order_no) === order.exchangeOrderId);
  if (!row) return null;
  if (text(row.stk_cd)?.replace(/^A/, '').toUpperCase() !== plan.symbol.replace(/^A/, '').toUpperCase()) {
    throw new Error('KIWOOM_ORDER_IDENTITY_MISMATCH');
  }
  const requestedQuantity = finiteNumber(row.ord_qty) ?? order.requestedQuantity;
  const remainingQuantity = finiteNumber(row.oso_qty);
  if (requestedQuantity == null || remainingQuantity == null || remainingQuantity < 0
    || remainingQuantity > requestedQuantity + QUANTITY_EPSILON) {
    throw new Error('KIWOOM_ORDER_QUANTITY_INVALID');
  }
  const filledQuantity = Math.max(0, requestedQuantity - remainingQuantity);
  return {
    exchangeOrderId: order.exchangeOrderId,
    state: filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED',
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: filledQuantity > 0
      ? finiteNumber(row.cntr_tot_amt) != null ? Number(row.cntr_tot_amt) / filledQuantity : finiteNumber(row.cntr_pric)
      : null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    exchangeCreatedAt: null,
    exchangeUpdatedAt: null,
    cancelable: true,
    providerStatusCode: text(row.ord_stt),
  };
}

function kiwoomDomesticHistorySnapshot(
  payload: ExchangePayload,
  plan: TradingPlan,
  order: TradingOrder,
): TradingExchangeOrderSnapshot {
  assertKiwoom(payload);
  const matches = kiwoomRows(payload, 'acnt_ord_cntr_prst_array')
    .filter((item) => text(item.ord_no ?? item.order_no) === order.exchangeOrderId);
  if (!matches.length) throw new Error('KIWOOM_ORDER_LOOKUP_EMPTY');
  if (matches.some((row) => text(row.stk_cd)?.replace(/^A/, '').toUpperCase()
      !== plan.symbol.replace(/^A/, '').toUpperCase())) {
    throw new Error('KIWOOM_ORDER_IDENTITY_MISMATCH');
  }
  const requestedQuantity = Math.max(...matches.map((row) => finiteNumber(row.ord_qty) ?? 0))
    || order.requestedQuantity;
  const uniqueFills = new Map<string, { quantity: number; price: number }>();
  for (const row of matches) {
    const quantity = finiteNumber(row.cntr_qty);
    const price = finiteNumber(row.cntr_uv);
    if (quantity != null && quantity > 0 && price != null && price > 0) {
      uniqueFills.set(text(row.cntr_no) ?? `${quantity}:${price}:${text(row.cntr_tm) ?? ''}`, { quantity, price });
    }
  }
  const filledQuantity = [...uniqueFills.values()].reduce((sum, fill) => sum + fill.quantity, 0);
  const weighted = [...uniqueFills.values()].reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
  const state = requestedQuantity != null && filledQuantity + QUANTITY_EPSILON >= requestedQuantity
    ? 'FILLED' : 'CANCELED';
  return {
    exchangeOrderId: order.exchangeOrderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity: state === 'FILLED' ? 0 : Math.max(0, Number(requestedQuantity ?? 0) - filledQuantity),
    averageFillPrice: filledQuantity > 0 ? weighted / filledQuantity : null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    exchangeCreatedAt: null,
    exchangeUpdatedAt: null,
    cancelable: false,
    providerStatusCode: state.toLowerCase(),
  };
}

function kiwoomUsOpenSnapshot(
  payload: ExchangePayload,
  plan: TradingPlan,
  order: TradingOrder,
): TradingExchangeOrderSnapshot | null {
  assertKiwoom(payload);
  const row = kiwoomRows(payload, 'result_list')
    .find((item) => text(item.ord_no ?? item.order_no) === order.exchangeOrderId);
  if (!row) return null;
  if (text(row.stk_cd)?.toUpperCase() !== plan.symbol.toUpperCase()) throw new Error('KIWOOM_ORDER_IDENTITY_MISMATCH');
  const requestedQuantity = finiteNumber(row.ord_qty) ?? order.requestedQuantity;
  const filledQuantity = finiteNumber(row.cntr_qty) ?? 0;
  const remainingQuantity = finiteNumber(row.ord_remnq)
    ?? (requestedQuantity == null ? null : Math.max(0, requestedQuantity - filledQuantity));
  return {
    exchangeOrderId: order.exchangeOrderId,
    state: filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED',
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: finiteNumber(row.cntr_uv),
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    exchangeCreatedAt: null,
    exchangeUpdatedAt: null,
    cancelable: true,
    providerStatusCode: text(row.ord_stat ?? row.ord_stat_nm),
  };
}

function kiwoomUsHistorySnapshot(
  payload: ExchangePayload,
  plan: TradingPlan,
  order: TradingOrder,
): TradingExchangeOrderSnapshot {
  assertKiwoom(payload);
  const matches = kiwoomRows(payload, 'result_list')
    .filter((item) => text(item.ord_no ?? item.order_no) === order.exchangeOrderId);
  if (!matches.length) throw new Error('KIWOOM_ORDER_LOOKUP_EMPTY');
  if (matches.some((row) => text(row.stk_cd)?.toUpperCase() !== plan.symbol.toUpperCase())) {
    throw new Error('KIWOOM_ORDER_IDENTITY_MISMATCH');
  }
  const requestedQuantity = Math.max(...matches.map((row) => finiteNumber(row.ord_qty) ?? 0))
    || order.requestedQuantity;
  const uniqueFills = new Map<string, { quantity: number; price: number }>();
  for (const row of matches) {
    const quantity = finiteNumber(row.cntr_qty);
    const price = finiteNumber(row.cntr_uv);
    if (quantity != null && quantity > 0 && price != null && price > 0) {
      uniqueFills.set(`${text(row.cntr_time) ?? ''}:${quantity}:${price}`, { quantity, price });
    }
  }
  const filledQuantity = [...uniqueFills.values()].reduce((sum, fill) => sum + fill.quantity, 0);
  const weighted = [...uniqueFills.values()].reduce((sum, fill) => sum + fill.quantity * fill.price, 0);
  const remainingValues = matches.map((row) => finiteNumber(row.ord_remnq)).filter((value): value is number => value != null);
  const remainingQuantity = remainingValues.length ? Math.min(...remainingValues)
    : requestedQuantity == null ? null : Math.max(0, requestedQuantity - filledQuantity);
  const statusText = matches.map((row) => String(row.ord_stat_nm ?? row.ord_stat ?? '')).join(' ');
  let state: TradingExchangeOrderSnapshot['state'] | null = null;
  if (/거부|실패/i.test(statusText)) state = 'REJECTED';
  else if (/취소/i.test(statusText)) state = 'CANCELED';
  else if (requestedQuantity != null && filledQuantity + QUANTITY_EPSILON >= requestedQuantity) state = 'FILLED';
  else if (remainingQuantity === 0) state = 'CANCELED';
  if (!state) throw new Error('KIWOOM_ORDER_STATUS_UNKNOWN');
  return {
    exchangeOrderId: order.exchangeOrderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity,
    averageFillPrice: filledQuantity > 0 ? weighted / filledQuantity : null,
    fills: [],
    feeAmount: null,
    feeCurrency: null,
    exchangeCreatedAt: null,
    exchangeUpdatedAt: null,
    cancelable: false,
    providerStatusCode: statusText || state.toLowerCase(),
  };
}

function quantitiesMatch(left: number, right: number) {
  return Math.abs(left - right) <= QUANTITY_EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
}

function mergeFills(order: TradingOrder, snapshot: TradingExchangeOrderSnapshot) {
  const merged = new Map((order.fills ?? []).map((fill) => [fill.id, fill]));
  for (const fill of snapshot.fills) {
    const existing = merged.get(fill.id);
    if (existing && (existing.price !== fill.price || existing.quantity !== fill.quantity
      || existing.filledAt !== fill.filledAt)) {
      throw new Error('RECONCILIATION_FILL_ID_MISMATCH');
    }
    merged.set(fill.id, fill);
  }
  return [...merged.values()].sort((left, right) => (
    left.filledAt.localeCompare(right.filledAt) || left.id.localeCompare(right.id)
  ));
}

function validateSnapshot(order: TradingOrder, snapshot: TradingExchangeOrderSnapshot): TradingExchangeOrderSnapshot {
  if (order.exchangeOrderId && snapshot.exchangeOrderId && order.exchangeOrderId !== snapshot.exchangeOrderId) {
    throw new Error('RECONCILIATION_ORDER_ID_MISMATCH');
  }
  if (order.requestedQuantity !== null && snapshot.requestedQuantity !== null
    && !quantitiesMatch(order.requestedQuantity, snapshot.requestedQuantity)) {
    throw new Error('RECONCILIATION_REQUESTED_QUANTITY_MISMATCH');
  }
  if (snapshot.filledQuantity + QUANTITY_EPSILON < order.filledQuantity) {
    throw new Error('RECONCILIATION_FILLED_QUANTITY_REGRESSION');
  }
  const requestedQuantity = snapshot.requestedQuantity ?? order.requestedQuantity;
  if (requestedQuantity !== null && snapshot.filledQuantity > requestedQuantity + QUANTITY_EPSILON) {
    throw new Error('RECONCILIATION_FILLED_QUANTITY_EXCEEDED');
  }
  const expectedRemaining = requestedQuantity === null ? snapshot.remainingQuantity
    : Math.max(0, requestedQuantity - snapshot.filledQuantity);
  if (snapshot.remainingQuantity !== null && expectedRemaining !== null
    && !quantitiesMatch(snapshot.remainingQuantity, expectedRemaining)) {
    throw new Error('RECONCILIATION_REMAINING_QUANTITY_MISMATCH');
  }
  if (snapshot.state === 'FILLED' && requestedQuantity !== null
    && snapshot.filledQuantity + QUANTITY_EPSILON < requestedQuantity) {
    throw new Error('RECONCILIATION_TERMINAL_STATE_MISMATCH');
  }
  if (snapshot.state === 'PARTIALLY_FILLED' && requestedQuantity !== null
    && snapshot.filledQuantity + QUANTITY_EPSILON >= requestedQuantity) {
    throw new Error('RECONCILIATION_TERMINAL_STATE_REGRESSION');
  }
  const previousProviderState = String(order.providerStatusCode ?? '').toLowerCase();
  if (['filled', 'done', 'completed'].includes(previousProviderState) && snapshot.state !== 'FILLED') {
    throw new Error('RECONCILIATION_TERMINAL_STATE_REGRESSION');
  }
  const previousUpdatedAt = Date.parse(order.exchangeUpdatedAt ?? '');
  const snapshotUpdatedAt = Date.parse(snapshot.exchangeUpdatedAt ?? '');
  if (Number.isFinite(previousUpdatedAt) && Number.isFinite(snapshotUpdatedAt)
    && snapshotUpdatedAt < previousUpdatedAt) {
    throw new Error('RECONCILIATION_STALE_RESPONSE');
  }
  return {
    ...snapshot,
    exchangeOrderId: snapshot.exchangeOrderId ?? order.exchangeOrderId,
    requestedQuantity,
    remainingQuantity: snapshot.remainingQuantity ?? expectedRemaining,
    averageFillPrice: snapshot.averageFillPrice ?? order.averageFillPrice,
    fills: mergeFills(order, snapshot),
    feeAmount: snapshot.feeAmount ?? order.feeAmount ?? null,
    feeCurrency: snapshot.feeCurrency ?? order.feeCurrency ?? null,
    exchangeCreatedAt: order.exchangeCreatedAt ?? snapshot.exchangeCreatedAt,
    exchangeUpdatedAt: snapshot.exchangeUpdatedAt ?? order.exchangeUpdatedAt ?? null,
  };
}

function transientRecoveryError(code: string) {
  return isTransientTradingProviderError(code)
    || /^(BITGET|UPBIT|KIWOOM|TOSS)_HTTP_404$/.test(code);
}

export class TradeOrderRecoveryService {
  private automation: TradeAutomationService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  async reconcile(userId: string, plan: TradingPlan, order: TradingOrder) {
    if (order.userId !== userId || plan.userId !== userId || order.planId !== plan.id) throw new Error('USER_SCOPE_MISMATCH');
    if (order.state !== 'RECOVERY_REQUIRED') return order;
    if (order.manualReviewRequired) return order;
    if (order.nextRetryAt && Date.parse(order.nextRetryAt) > Date.now()) return order;

    const connection = await this.repository.getConnection(userId, plan.exchange);
    if (!connection?.configured || !connection.encryptedCredentials) {
      return this.pending(order, 'RECOVERY_CONNECTION_NOT_CONFIGURED', true);
    }
    if (connection.accountMode !== plan.accountMode) {
      return this.pending(order, 'RECOVERY_ACCOUNT_MODE_MISMATCH', true);
    }
    if (plan.accountMode === 'paper' || plan.accountMode === 'mock') {
      return this.pending(order, 'PAPER_ORDER_RECOVERY_REQUIRES_REVIEW', true);
    }

    try {
      const credentials = decryptTradingCredentials(connection.encryptedCredentials);
      let snapshot: TradingExchangeOrderSnapshot;

      if (plan.exchange === 'bitget') {
        snapshot = bitgetSnapshot(await sendRecoveryRequest(
          BASE_URLS.bitget,
          prepareBitgetOrderQuery(credentials as BitgetCredentials, plan.symbol, order.clientOrderId),
        ), plan, order);
      } else if (plan.exchange === 'upbit') {
        snapshot = upbitSnapshot(await sendRecoveryRequest(
          BASE_URLS.upbit,
          prepareUpbitOrderQuery(credentials as UpbitCredentials, order.clientOrderId),
        ), plan, order);
      } else if (plan.exchange === 'toss') {
        const tossCredentials = credentials as TossCredentials;
        const tokenPayload = await sendRecoveryRequest(BASE_URLS.toss, prepareTossToken(tossCredentials));
        const authenticated = { ...tossCredentials, accessToken: tossToken(tokenPayload) };
        if (!order.exchangeOrderId) {
          const open = await sendRecoveryRequest(BASE_URLS.toss, prepareTossOpenOrders(authenticated, plan.symbol));
          const discovered = tossOpenOrderId(open, order.clientOrderId);
          if (!discovered) {
            return this.pending(order, 'TOSS_AMBIGUOUS_SUBMISSION_ORDER_ID_UNRESOLVED', true);
          }
          order.exchangeOrderId = discovered;
        }
        snapshot = tossSnapshot(await sendRecoveryRequest(
          BASE_URLS.toss,
          prepareTossOrderQuery(authenticated, order.exchangeOrderId),
        ), plan, order);
      } else {
        if (!order.exchangeOrderId) {
          return this.pending(order, 'KIWOOM_AMBIGUOUS_SUBMISSION_ORDER_ID_UNRESOLVED', true);
        }
        const kiwoomCredentials = credentials as KiwoomCredentials;
        const tokenPayload = assertKiwoom(await sendRecoveryRequest(BASE_URLS.kiwoom, prepareKiwoomToken(kiwoomCredentials)));
        const authenticated = { ...kiwoomCredentials, accessToken: kiwoomToken(tokenPayload) };
        const date = kiwoomOrderDate(order.createdAt);
        if (plan.market.toUpperCase() === 'US') {
          const open = await sendRecoveryRequest(BASE_URLS.kiwoom, prepareKiwoomUsUnfilled(authenticated, plan));
          snapshot = kiwoomUsOpenSnapshot(open, plan, order)
            ?? kiwoomUsHistorySnapshot(await sendRecoveryRequest(
              BASE_URLS.kiwoom,
              prepareKiwoomUsOrderHistory(authenticated, plan, order.exchangeOrderId, date),
            ), plan, order);
        } else {
          const open = await sendRecoveryRequest(BASE_URLS.kiwoom, prepareKiwoomUnfilled(authenticated));
          snapshot = kiwoomDomesticOpenSnapshot(open, plan, order)
            ?? kiwoomDomesticHistorySnapshot(await sendRecoveryRequest(
              BASE_URLS.kiwoom,
              prepareKiwoomDomesticOrderHistory(authenticated, plan, order.exchangeOrderId, date),
            ), plan, order);
        }
      }

      return await this.applySnapshot(order, snapshot);
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_RECONCILIATION_FAILED';
      return this.pending(order, code, !transientRecoveryError(code));
    }
  }

  private async applySnapshot(order: TradingOrder, snapshot: TradingExchangeOrderSnapshot) {
    const validated = validateSnapshot(order, snapshot);
    order.exchangeOrderId = validated.exchangeOrderId ?? order.exchangeOrderId;
    order.requestedQuantity = validated.requestedQuantity;
    order.remainingQuantity = validated.remainingQuantity;
    order.filledQuantity = validated.filledQuantity;
    order.averageFillPrice = validated.averageFillPrice;
    order.fills = validated.fills;
    order.feeAmount = validated.feeAmount;
    order.feeCurrency = validated.feeCurrency;
    order.exchangeCreatedAt = validated.exchangeCreatedAt;
    order.exchangeUpdatedAt = validated.exchangeUpdatedAt;
    order.cancelable = validated.cancelable;
    order.providerStatusCode = validated.providerStatusCode;
    order.retryCount = 0;
    order.nextRetryAt = null;
    order.lastReconciledAt = new Date().toISOString();
    order.lastErrorCode = null;
    order.manualReviewRequired = false;
    const cancellationIntent = Boolean(order.cancelRequestClaimId || order.cancelRequestedAt);
    return this.automation.transition(order, validated.state, 'EXCHANGE_ORDER_RECONCILED', {
      exchangeOrderId: order.exchangeOrderId,
      filledQuantity: order.filledQuantity,
      averageFillPrice: order.averageFillPrice,
      providerStatusCode: order.providerStatusCode,
      cancellationIntent,
      partialFillPreserved: validated.state === 'CANCELED' && validated.filledQuantity > 0,
      filledAfterCancelRequest: cancellationIntent && validated.state === 'FILLED',
      orderResubmitted: false,
      recoveryRequired: false,
    });
  }

  private async pending(order: TradingOrder, errorCode: string, manualReviewRequired: boolean) {
    const now = new Date();
    const retryCount = order.retryCount + 1;
    const requiresReview = manualReviewRequired || retryCount >= 3;
    const delayMs = Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, retryCount - 1)));
    order.retryCount = retryCount;
    order.lastErrorCode = errorCode;
    order.lastReconciledAt = now.toISOString();
    order.nextRetryAt = requiresReview ? null : new Date(now.getTime() + delayMs).toISOString();
    order.manualReviewRequired = requiresReview;
    order.updatedAt = now.toISOString();
    return this.automation.transition(
      order,
      'RECOVERY_REQUIRED',
      requiresReview ? 'EXCHANGE_RECONCILIATION_MANUAL_REVIEW' : 'EXCHANGE_RECONCILIATION_RETRY_SCHEDULED',
      {
        errorCode,
        retryCount,
        nextRetryAt: order.nextRetryAt,
        manualReviewRequired: requiresReview,
        cancellationIntent: Boolean(order.cancelRequestClaimId || order.cancelRequestedAt),
        submissionOutcome: 'unknown',
        recoveryRequired: true,
        orderResubmitted: false,
      },
    );
  }
}
