import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService, withTradePlanLock } from './trade-automation.service';
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
  TradingOrder,
  TradingOrderState,
  TradingPlan,
} from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;
type ReconciliationResolution = {
  state: Exclude<TradingOrderState, 'PLANNED' | 'APPROVAL_PENDING' | 'SUBMITTED' | 'RECOVERY_REQUIRED'>;
  exchangeOrderId: string | null;
  filledQuantity: number;
  averageFillPrice: number | null;
  reason: string;
};

type ReconciliationOutcome = {
  order: TradingOrder;
  resolved: boolean;
  querySent: boolean;
};

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  kiwoomMock: 'https://mockapi.kiwoom.com',
};

function isRecord(value: unknown): value is ExchangePayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function exchangeErrorCode(error: unknown) {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'EXCHANGE_TIMEOUT';
    if (error.message) return error.message.split(':')[0];
  }
  return 'EXCHANGE_RECONCILIATION_FAILED';
}

async function sendReadOnlyExchangeRequest(baseUrl: string, request: PreparedExchangeRequest) {
  const allowed = request.method === 'GET'
    || request.path === '/oauth2/token'
    || request.path === '/api/dostk/acnt';
  if (!allowed) throw new Error('RECONCILIATION_WRITE_REQUEST_BLOCKED');

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
    if (error instanceof TypeError) throw new Error('EXCHANGE_NETWORK_ERROR');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertBitgetSuccess(payload: ExchangePayload) {
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID_RESPONSE')}`);
  }
  return payload.data;
}

function assertUpbitSuccess(payload: ExchangePayload) {
  if (payload.error) throw new Error('UPBIT_QUERY_REJECTED');
  return payload;
}

function assertKiwoomSuccess(payload: ExchangePayload) {
  const rawCode = payload.return_code ?? payload.returnCode ?? payload.code;
  if (rawCode === undefined || rawCode === null) throw new Error('KIWOOM_INVALID_RESPONSE');
  const code = String(rawCode);
  if (!['0', '00000'].includes(code)) throw new Error(`KIWOOM_${code}`);
  return payload;
}

function bitgetResolution(payload: unknown, fallbackOrderId: string | null): ReconciliationResolution | null {
  const rows = Array.isArray(payload) ? payload.filter(isRecord) : isRecord(payload) ? [payload] : [];
  const row = rows[0];
  if (!row) return null;
  const state = String(row.state ?? row.status ?? '').toLowerCase();
  const filledQuantity = finiteNumber(
    row.baseVolume ?? row.filledQty ?? row.accBaseVolume ?? row.filledQuantity,
    0,
  );
  const averageFillPrice = positiveNumber(row.priceAvg ?? row.avgPrice ?? row.averagePrice);
  const exchangeOrderId = String(row.orderId ?? row.order_id ?? fallbackOrderId ?? '').trim() || null;

  if (['live', 'new', 'init', 'not_trigger', 'pending'].includes(state)) {
    return { state: filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'BITGET_ORDER_RECONCILED' };
  }
  if (['partial_fill', 'partially_filled', 'partial-filled'].includes(state)) {
    return { state: 'PARTIALLY_FILLED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'BITGET_ORDER_RECONCILED' };
  }
  if (['filled', 'full_fill', 'fully_filled'].includes(state)) {
    return { state: 'FILLED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'BITGET_ORDER_RECONCILED' };
  }
  if (['cancelled', 'canceled'].includes(state)) {
    return { state: 'CANCELED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'BITGET_ORDER_RECONCILED' };
  }
  if (['rejected', 'failed'].includes(state)) {
    return { state: 'REJECTED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'BITGET_ORDER_RECONCILED' };
  }
  return null;
}

function upbitAverageFill(payload: ExchangePayload) {
  const trades = Array.isArray(payload.trades) ? payload.trades.filter(isRecord) : [];
  let quantity = 0;
  let funds = 0;
  for (const trade of trades) {
    const volume = finiteNumber(trade.volume, 0);
    const tradeFunds = finiteNumber(trade.funds, 0);
    if (volume > 0 && tradeFunds >= 0) {
      quantity += volume;
      funds += tradeFunds;
    }
  }
  return quantity > 0 ? funds / quantity : positiveNumber(payload.avg_price ?? payload.average_price);
}

function upbitResolution(payload: ExchangePayload, fallbackOrderId: string | null): ReconciliationResolution | null {
  const state = String(payload.state ?? '').toLowerCase();
  const filledQuantity = finiteNumber(payload.executed_volume ?? payload.filled_volume, 0);
  const averageFillPrice = upbitAverageFill(payload);
  const exchangeOrderId = String(payload.uuid ?? payload.identifier ?? fallbackOrderId ?? '').trim() || null;

  if (['wait', 'watch'].includes(state)) {
    return { state: filledQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'UPBIT_ORDER_RECONCILED' };
  }
  if (state === 'done') {
    return { state: 'FILLED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'UPBIT_ORDER_RECONCILED' };
  }
  if (['cancel', 'cancelled', 'canceled'].includes(state)) {
    return { state: 'CANCELED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'UPBIT_ORDER_RECONCILED' };
  }
  if (['reject', 'rejected', 'failed'].includes(state)) {
    return { state: 'REJECTED', exchangeOrderId, filledQuantity, averageFillPrice, reason: 'UPBIT_ORDER_RECONCILED' };
  }
  return null;
}

function nestedRows(payload: ExchangePayload) {
  const candidates: unknown[] = [
    payload.data,
    payload.output,
    payload.orders,
    payload.list,
    payload.unfilled,
  ];
  const rows: ExchangePayload[] = [];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) rows.push(...candidate.filter(isRecord));
    else if (isRecord(candidate)) {
      for (const value of Object.values(candidate)) {
        if (Array.isArray(value)) rows.push(...value.filter(isRecord));
      }
    }
  }
  return rows;
}

function kiwoomResolution(payload: ExchangePayload, order: TradingOrder): ReconciliationResolution | null {
  if (!order.exchangeOrderId) return null;
  const row = nestedRows(payload).find((candidate) => String(
    candidate.ord_no ?? candidate.order_no ?? candidate.orderNo ?? '',
  ) === order.exchangeOrderId);
  if (!row) return null;
  const filledQuantity = finiteNumber(row.cntr_qty ?? row.filled_qty ?? row.exec_qty, order.filledQuantity);
  const remainingQuantity = finiteNumber(row.oso_qty ?? row.unfilled_qty ?? row.remain_qty, 0);
  const averageFillPrice = positiveNumber(row.avg_prc ?? row.avg_price ?? row.cntr_prc) ?? order.averageFillPrice;
  return {
    state: filledQuantity > 0 && remainingQuantity > 0 ? 'PARTIALLY_FILLED' : 'ACCEPTED',
    exchangeOrderId: order.exchangeOrderId,
    filledQuantity,
    averageFillPrice,
    reason: 'KIWOOM_UNFILLED_ORDER_RECONCILED',
  };
}

export class TradeExchangeReconciliationService {
  private automation: TradeAutomationService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  async reconcileOrder(userId: string, plan: TradingPlan, order: TradingOrder): Promise<ReconciliationOutcome> {
    return withTradePlanLock(userId, plan.id, async () => {
      const persisted = await this.repository.getOrder(userId, order.id);
      const current = persisted ?? structuredClone(order);
      if (current.state !== 'RECOVERY_REQUIRED') {
        Object.assign(order, current);
        return { order, resolved: true, querySent: false };
      }

      const connection = await this.repository.getConnection(userId, plan.exchange);
      if (!connection?.configured || !connection.encryptedCredentials || connection.accountMode !== plan.accountMode) {
        await this.automation.recordRecoveryAttempt(
          current,
          'RECONCILIATION_CONNECTION_UNAVAILABLE',
          'RECONCILIATION_CONNECTION_UNAVAILABLE',
        );
        Object.assign(order, current);
        return { order, resolved: false, querySent: false };
      }

      let resolution: ReconciliationResolution | null = null;
      let unresolvedCode = 'EXCHANGE_ORDER_STATUS_UNCONFIRMED';
      let querySent = false;
      try {
        const credentials = decryptTradingCredentials(connection.encryptedCredentials);
        if (plan.exchange === 'bitget') {
          querySent = true;
          const payload = assertBitgetSuccess(await sendReadOnlyExchangeRequest(
            BASE_URLS.bitget,
            prepareBitgetOrderQuery(credentials as BitgetCredentials, current.clientOrderId),
          ));
          resolution = bitgetResolution(payload, current.exchangeOrderId);
          unresolvedCode = 'BITGET_ORDER_STATUS_UNCONFIRMED';
        } else if (plan.exchange === 'upbit') {
          querySent = true;
          const payload = assertUpbitSuccess(await sendReadOnlyExchangeRequest(
            BASE_URLS.upbit,
            prepareUpbitOrderQuery(credentials as UpbitCredentials, current.clientOrderId),
          ));
          resolution = upbitResolution(payload, current.exchangeOrderId);
          unresolvedCode = 'UPBIT_ORDER_STATUS_UNCONFIRMED';
        } else if (!current.exchangeOrderId) {
          unresolvedCode = 'KIWOOM_EXCHANGE_ORDER_ID_UNKNOWN';
        } else {
          const mock = plan.accountMode === 'mock';
          const baseUrl = mock ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
          const kiwoomCredentials = credentials as KiwoomCredentials;
          querySent = true;
          const tokenPayload = assertKiwoomSuccess(await sendReadOnlyExchangeRequest(
            baseUrl,
            prepareKiwoomToken(kiwoomCredentials),
          ));
          const token = String(
            tokenPayload.token ?? (isRecord(tokenPayload.data) ? tokenPayload.data.token : '') ?? '',
          );
          if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
          const unfilled = assertKiwoomSuccess(await sendReadOnlyExchangeRequest(
            baseUrl,
            prepareKiwoomUnfilled({ ...kiwoomCredentials, accessToken: token }),
          ));
          resolution = kiwoomResolution(unfilled, current);
          unresolvedCode = 'KIWOOM_ORDER_HISTORY_REQUIRED';
        }
      } catch (error) {
        unresolvedCode = exchangeErrorCode(error);
      }

      await this.automation.recordRecoveryAttempt(
        current,
        resolution ? 'RECONCILIATION_QUERY_RESOLVED' : 'RECONCILIATION_QUERY_UNRESOLVED',
        resolution ? null : unresolvedCode,
        { querySent, exchange: plan.exchange },
      );

      if (!resolution) {
        Object.assign(order, current);
        return { order, resolved: false, querySent };
      }

      await this.automation.transition(current, resolution.state, resolution.reason, {
        exchangeOrderId: resolution.exchangeOrderId,
        filledQuantity: resolution.filledQuantity,
        averageFillPrice: resolution.averageFillPrice,
        errorCode: null,
      });
      Object.assign(order, current);
      return { order, resolved: true, querySent };
    });
  }

  async reconcileRecoverableOrders(userId: string) {
    const orders = (await this.repository.listOrders(userId))
      .filter((order) => order.state === 'RECOVERY_REQUIRED');
    const results: ReconciliationOutcome[] = [];
    for (const order of orders) {
      const plan = await this.repository.getPlan(userId, order.planId);
      if (!plan) {
        await this.automation.recordRecoveryAttempt(
          order,
          'RECONCILIATION_PLAN_MISSING',
          'TRADE_PLAN_NOT_FOUND',
        );
        results.push({ order, resolved: false, querySent: false });
        continue;
      }
      results.push(await this.reconcileOrder(userId, plan, order));
    }
    return {
      orders: results.map((result) => result.order),
      resolved: results.filter((result) => result.resolved).length,
      unresolved: results.filter((result) => !result.resolved).length,
      queriesSent: results.filter((result) => result.querySent).length,
    };
  }
}
