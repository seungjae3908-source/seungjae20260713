import { randomUUID } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService } from './trade-automation.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import {
  prepareBitgetOrderQuery,
  prepareKiwoomToken,
  prepareKiwoomUnfilled,
  prepareUpbitOrderQuery,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import type {
  TradingExchangeOrderSnapshot,
  TradingFill,
  TradingOrder,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  kiwoomMock: 'https://mockapi.kiwoom.com',
};

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
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) throw new Error(`EXCHANGE_HTTP_${response.status}`);
    return isRecord(payload) ? payload : { data: payload };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('EXCHANGE_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function bitgetData(payload: ExchangePayload) {
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID_RESPONSE')}`);
  }
  const candidate = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!isRecord(candidate)) throw new Error('BITGET_ORDER_LOOKUP_EMPTY');
  return candidate;
}

function upbitData(payload: ExchangePayload) {
  if (payload.error) throw new Error('UPBIT_ORDER_LOOKUP_FAILED');
  return payload;
}

function kiwoomData(payload: ExchangePayload) {
  const code = String(payload.return_code ?? payload.returnCode ?? payload.code ?? '0');
  if (!['0', '00000'].includes(code)) throw new Error(`KIWOOM_${code}`);
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

function bitgetSnapshot(payload: ExchangePayload, order: TradingOrder): TradingExchangeOrderSnapshot {
  const row = bitgetData(payload);
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

function upbitSnapshot(payload: ExchangePayload, order: TradingOrder): TradingExchangeOrderSnapshot {
  const row = upbitData(payload);
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

function rowsFromKiwoom(payload: ExchangePayload) {
  const candidates = [payload.data, payload.output, payload.orders, payload.ord_list, payload.unfilled];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
    if (isRecord(candidate)) {
      for (const nested of Object.values(candidate)) {
        if (Array.isArray(nested)) return nested.filter(isRecord);
      }
    }
  }
  return [];
}

function kiwoomSnapshot(payload: ExchangePayload, order: TradingOrder): TradingExchangeOrderSnapshot {
  const rows = rowsFromKiwoom(kiwoomData(payload));
  if (!order.exchangeOrderId) throw new Error('KIWOOM_ORDER_ID_REQUIRED_FOR_RECOVERY');
  const row = rows.find((candidate) => text(candidate.ord_no ?? candidate.order_no ?? candidate.orig_ord_no) === order.exchangeOrderId);
  if (!row) throw new Error('KIWOOM_ORDER_LOOKUP_INCONCLUSIVE');
  const requestedQuantity = finiteNumber(row.ord_qty ?? row.order_qty) ?? order.requestedQuantity;
  const remainingQuantity = finiteNumber(row.unfilled_qty ?? row.remain_qty ?? row.mis_qty);
  const filledQuantity = finiteNumber(row.filled_qty ?? row.exec_qty)
    ?? (requestedQuantity !== null && remainingQuantity !== null ? Math.max(0, requestedQuantity - remainingQuantity) : order.filledQuantity);
  const state: TradingExchangeOrderSnapshot['state'] = remainingQuantity === 0 && filledQuantity > 0
    ? 'FILLED'
    : filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED';
  const providerStatusCode = text(row.status ?? row.ord_status ?? row.order_status) ?? 'unfilled';
  return {
    exchangeOrderId: order.exchangeOrderId,
    state,
    requestedQuantity,
    filledQuantity,
    remainingQuantity: remainingQuantity ?? (requestedQuantity === null ? null : Math.max(0, requestedQuantity - filledQuantity)),
    averageFillPrice: finiteNumber(row.avg_price ?? row.exec_avg_price),
    fills: [],
    feeAmount: null,
    feeCurrency: 'KRW',
    exchangeCreatedAt: timestamp(row.ord_time ?? row.created_at),
    exchangeUpdatedAt: timestamp(row.updated_at ?? row.ord_time),
    cancelable: state === 'ACCEPTED' || state === 'PARTIALLY_FILLED',
    providerStatusCode,
  };
}

function transientRecoveryError(code: string) {
  return code === 'EXCHANGE_TIMEOUT' || code.startsWith('EXCHANGE_HTTP_')
    || code.endsWith('_ORDER_LOOKUP_EMPTY') || code.endsWith('_ORDER_LOOKUP_FAILED');
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
    if (plan.accountMode === 'paper' || (plan.accountMode === 'mock' && plan.exchange !== 'kiwoom')) {
      return this.pending(order, 'PAPER_ORDER_RECOVERY_REQUIRES_REVIEW', true);
    }

    try {
      const credentials = decryptTradingCredentials(connection.encryptedCredentials);
      let snapshot: TradingExchangeOrderSnapshot;
      if (plan.exchange === 'bitget') {
        snapshot = bitgetSnapshot(await sendRecoveryRequest(BASE_URLS.bitget,
          prepareBitgetOrderQuery(credentials as BitgetCredentials, order.clientOrderId)), order);
      } else if (plan.exchange === 'upbit') {
        snapshot = upbitSnapshot(await sendRecoveryRequest(BASE_URLS.upbit,
          prepareUpbitOrderQuery(credentials as UpbitCredentials, order.clientOrderId)), order);
      } else {
        const baseUrl = plan.accountMode === 'mock' ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
        const kiwoomCredentials = credentials as KiwoomCredentials;
        const tokenPayload = kiwoomData(await sendRecoveryRequest(baseUrl, prepareKiwoomToken(kiwoomCredentials)));
        const accessToken = text(tokenPayload.token ?? (isRecord(tokenPayload.data) ? tokenPayload.data.token : null));
        if (!accessToken) throw new Error('KIWOOM_TOKEN_MISSING');
        snapshot = kiwoomSnapshot(await sendRecoveryRequest(baseUrl,
          prepareKiwoomUnfilled({ ...kiwoomCredentials, accessToken })), order);
      }
      return this.applySnapshot(order, snapshot);
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_RECONCILIATION_FAILED';
      return this.pending(order, code, !transientRecoveryError(code));
    }
  }

  private async applySnapshot(order: TradingOrder, snapshot: TradingExchangeOrderSnapshot) {
    order.exchangeOrderId = snapshot.exchangeOrderId ?? order.exchangeOrderId;
    order.requestedQuantity = snapshot.requestedQuantity;
    order.remainingQuantity = snapshot.remainingQuantity;
    order.filledQuantity = snapshot.filledQuantity;
    order.averageFillPrice = snapshot.averageFillPrice;
    order.fills = snapshot.fills;
    order.feeAmount = snapshot.feeAmount;
    order.feeCurrency = snapshot.feeCurrency;
    order.exchangeCreatedAt = snapshot.exchangeCreatedAt;
    order.exchangeUpdatedAt = snapshot.exchangeUpdatedAt;
    order.cancelable = snapshot.cancelable;
    order.providerStatusCode = snapshot.providerStatusCode;
    order.retryCount = 0;
    order.nextRetryAt = null;
    order.lastReconciledAt = new Date().toISOString();
    order.lastErrorCode = null;
    order.manualReviewRequired = false;
    return this.automation.transition(order, snapshot.state, 'EXCHANGE_ORDER_RECONCILED', {
      exchangeOrderId: order.exchangeOrderId,
      filledQuantity: order.filledQuantity,
      averageFillPrice: order.averageFillPrice,
      providerStatusCode: order.providerStatusCode,
      orderSubmissionAttempted: false,
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
    await this.repository.saveOrder(order);
    await this.repository.appendEvent({
      id: randomUUID(),
      userId: order.userId,
      orderId: order.id,
      fromState: 'RECOVERY_REQUIRED',
      toState: 'RECOVERY_REQUIRED',
      reason: requiresReview ? 'EXCHANGE_RECONCILIATION_MANUAL_REVIEW' : 'EXCHANGE_RECONCILIATION_RETRY_SCHEDULED',
      metadata: {
        errorCode,
        retryCount,
        nextRetryAt: order.nextRetryAt,
        manualReviewRequired: requiresReview,
        orderSubmissionAttempted: false,
      },
      createdAt: now.toISOString(),
    });
    return order;
  }
}
