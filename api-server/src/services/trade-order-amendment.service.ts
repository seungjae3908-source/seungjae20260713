import { createHash } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import { liveExecutionEnabled, TradeAutomationService } from './trade-automation.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import {
  prepareBitgetAmend,
  prepareBitgetOrderQuery,
  prepareKiwoomAmend,
  prepareKiwoomToken,
  prepareKiwoomUnfilled,
  prepareKiwoomUsUnfilled,
  prepareTossAmend,
  prepareTossOrderQuery,
  prepareTossToken,
  prepareUpbitAmend,
  prepareUpbitOrderQuery,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type TossCredentials,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import type {
  TradingOrder,
  TradingOrderAmendment,
  TradingPlan,
} from './trade-automation.types';

type Row = Record<string, unknown>;

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  toss: 'https://openapi.tossinvest.com',
};

const REQUEST_TIMEOUT_MS = 12_000;

export type TradeOrderAmendInput = {
  requestId: string;
  price: number;
  quantity?: number | null;
};

function isRecord(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function requestId(value: string) {
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('AMEND_REQUEST_ID_INVALID');
  }
  return normalized;
}

function nextClientOrderId(userId: string, order: TradingOrder, amendRequestId: string, revision: number) {
  const digest = createHash('sha256')
    .update([userId, order.id, amendRequestId, String(revision)].join(':'))
    .digest('hex')
    .slice(0, 18);
  return `sj-${order.exchange}-a${revision}-${digest}`;
}

function latestAmendment(order: TradingOrder, id: string) {
  return (order.amendments ?? []).find((item) => item.requestId === id) ?? null;
}

function replaceAmendment(order: TradingOrder, request: TradingOrderAmendment) {
  order.amendments = [...(order.amendments ?? []).filter((item) => item.requestId !== request.requestId), request];
  order.lastAmendRequestId = request.requestId;
}

function amendmentQuantity(order: TradingOrder, plan: TradingPlan, input: TradeOrderAmendInput) {
  const remaining = Number(order.remainingQuantity ?? order.requestedQuantity ?? 0);
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('AMEND_REMAINING_QUANTITY_UNAVAILABLE');

  const usPriceOnly = (plan.exchange === 'toss' || plan.exchange === 'kiwoom')
    && plan.market.toUpperCase() === 'US';
  if (usPriceOnly) {
    if (input.quantity != null) throw new Error('US_STOCK_AMEND_QUANTITY_NOT_SUPPORTED');
    return remaining;
  }

  const quantity = input.quantity == null ? remaining : Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('AMEND_QUANTITY_INVALID');
  if (quantity > remaining + 1e-12) throw new Error('AMEND_QUANTITY_INCREASE_NOT_ALLOWED');
  if ((plan.exchange === 'toss' || plan.exchange === 'kiwoom') && !Number.isSafeInteger(quantity)) {
    throw new Error('STOCK_AMEND_QUANTITY_INTEGER_REQUIRED');
  }
  return quantity;
}

function assertAmendRiskBounds(order: TradingOrder, plan: TradingPlan, price: number, quantity: number) {
  if (order.state === 'PARTIALLY_FILLED' || order.filledQuantity > 0) {
    throw new Error('PARTIAL_FILL_AMEND_REQUIRES_CANCEL_AND_REPLAN');
  }
  if (order.state !== 'ACCEPTED') throw new Error('ORDER_NOT_AMENDABLE');
  if (order.cancelRequestClaimId || order.cancelRequestedAt) throw new Error('ORDER_CANCEL_ALREADY_REQUESTED');
  if (order.cancelable === false) throw new Error('ORDER_NOT_CANCELABLE');
  if (plan.orderType !== 'limit') throw new Error('ONLY_LIMIT_ORDER_AMEND_SUPPORTED');
  if (!Number.isFinite(price) || price <= 0) throw new Error('AMEND_PRICE_INVALID');

  const approvedPrice = Number(plan.limitPrice);
  if (!Number.isFinite(approvedPrice) || approvedPrice <= 0) throw new Error('AMEND_APPROVED_LIMIT_PRICE_UNAVAILABLE');
  const maxSlippagePercent = Number(plan.riskEnvelope?.maxSlippagePercent);
  if (!Number.isFinite(maxSlippagePercent) || maxSlippagePercent < 0) {
    throw new Error('AMEND_RISK_ENVELOPE_REQUIRED');
  }

  if (plan.side === 'buy' || plan.side === 'long') {
    const maximum = approvedPrice * (1 + maxSlippagePercent / 100);
    if (price > maximum + 1e-12) throw new Error('AMEND_PRICE_EXCEEDS_APPROVED_RISK_ENVELOPE');
  } else {
    const minimum = approvedPrice * (1 - maxSlippagePercent / 100);
    if (price + 1e-12 < minimum) throw new Error('AMEND_PRICE_EXCEEDS_APPROVED_RISK_ENVELOPE');
  }

  const originalQuantity = Number(order.requestedQuantity ?? quantity);
  if (Number.isFinite(originalQuantity) && quantity > originalQuantity + 1e-12) {
    throw new Error('AMEND_QUANTITY_INCREASE_NOT_ALLOWED');
  }
}

async function sendJson(baseUrl: string, request: PreparedExchangeRequest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const url = `${baseUrl}${request.path}${request.query ? `?${request.query}` : ''}`;
    const response = await fetch(url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown = {};
    if (raw.trim()) {
      try { payload = JSON.parse(raw); } catch { throw new Error('EXCHANGE_INVALID_RESPONSE'); }
    }
    if (!response.ok) throw new Error(`EXCHANGE_HTTP_${response.status}`);
    if (!isRecord(payload)) throw new Error('EXCHANGE_INVALID_RESPONSE');
    return payload;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('EXCHANGE_TIMEOUT');
    if (error instanceof TypeError) throw new Error('EXCHANGE_NETWORK_ERROR');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertBitget(payload: Row) {
  if (String(payload.code ?? '') !== '00000') throw new Error(`BITGET_${String(payload.code ?? 'INVALID_RESPONSE')}`);
  return payload.data;
}

function bitgetOrderRow(payload: Row, expectedClientId: string) {
  const data = assertBitget(payload);
  const row = Array.isArray(data) ? data.find(isRecord) : isRecord(data) ? data : null;
  if (!row || text(row.clientOid) !== expectedClientId) throw new Error('BITGET_AMEND_RECONCILIATION_FAILED');
  return row;
}

function assertUpbit(payload: Row) {
  if (payload.error) throw new Error('UPBIT_AMEND_REJECTED');
  return payload;
}

function upbitActiveOrder(payload: Row, expectedIdentifier: string) {
  assertUpbit(payload);
  if (text(payload.identifier) !== expectedIdentifier) throw new Error('UPBIT_AMEND_RECONCILIATION_FAILED');
  const state = String(payload.state ?? '').toLowerCase();
  if (state !== 'wait' && state !== 'watch') throw new Error('UPBIT_AMEND_NOT_OPEN_AFTER_ACK');
  return payload;
}

function assertToss(payload: Row) {
  if (payload.error) throw new Error('TOSS_AMEND_REJECTED');
  const code = text(payload.code ?? payload.return_code);
  if (code && !['0', '00000', 'SUCCESS'].includes(code.toUpperCase())) throw new Error(`TOSS_${code}`);
  return isRecord(payload.result) ? payload.result : payload;
}

function tossToken(payload: Row) {
  const result = isRecord(payload.result) ? payload.result : isRecord(payload.data) ? payload.data : payload;
  const token = text(result.access_token ?? result.accessToken ?? payload.access_token);
  if (!token) throw new Error('TOSS_TOKEN_MISSING');
  return token;
}

function tossActiveOrder(payload: Row, expectedOrderId: string) {
  const row = assertToss(payload);
  if (text(row.orderId ?? row.order_id) !== expectedOrderId) throw new Error('TOSS_AMEND_RECONCILIATION_FAILED');
  const state = String(row.status ?? row.orderStatus ?? row.state ?? '').toLowerCase();
  if (!['open', 'pending', 'accepted', 'partially_filled', 'partial_fill'].includes(state)) {
    throw new Error('TOSS_AMEND_NOT_OPEN_AFTER_ACK');
  }
  return row;
}

function assertKiwoom(payload: Row) {
  const raw = payload.return_code ?? payload.returnCode ?? payload.code;
  if (raw == null || !['0', '00000'].includes(String(raw))) throw new Error(`KIWOOM_${String(raw ?? 'INVALID_RESPONSE')}`);
  return payload;
}

function kiwoomToken(payload: Row) {
  const nested = isRecord(payload.data) ? payload.data : null;
  const token = text(payload.token ?? nested?.token);
  if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
  return token;
}

function kiwoomOrderId(payload: Row, fallback: string) {
  return text(payload.ord_no ?? payload.order_no) ?? fallback;
}

function kiwoomOpenOrderExists(payload: Row, orderId: string) {
  assertKiwoom(payload);
  const candidates = [payload.oso, payload.result_list, payload.unfilled, payload.orders, payload.ord_list];
  return candidates.some((candidate) => Array.isArray(candidate) && candidate.filter(isRecord)
    .some((row) => text(row.ord_no ?? row.order_no ?? row.orig_ord_no) === orderId));
}

export class TradeOrderAmendmentService {
  private automation: TradeAutomationService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  async amend(userId: string, candidate: TradingOrder, plan: TradingPlan, input: TradeOrderAmendInput) {
    if (candidate.userId !== userId || plan.userId !== userId || candidate.planId !== plan.id) {
      throw new Error('USER_SCOPE_MISMATCH');
    }
    let order = await this.repository.getOrder(userId, candidate.id);
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');

    const normalizedRequestId = requestId(input.requestId);
    const replay = latestAmendment(order, normalizedRequestId);
    if (replay) {
      if (replay.status !== 'ACKNOWLEDGED' && order.state === 'ACCEPTED') {
        const recoveredReplay: TradingOrderAmendment = {
          ...replay,
          status: 'RECOVERY_REQUIRED',
          errorCode: replay.errorCode ?? 'AMEND_INTENT_WITHOUT_TERMINAL_PROVIDER_EVIDENCE',
        };
        replaceAmendment(order, recoveredReplay);
        order.lastErrorCode = recoveredReplay.errorCode;
        order.manualReviewRequired = true;
        order = await this.automation.transition(
          order,
          'RECOVERY_REQUIRED',
          'ORDER_AMEND_REPLAY_REQUIRES_RECONCILIATION',
          {
            amendmentRevision: replay.revision,
            amendmentRequestId: normalizedRequestId,
            providerMutationAttempted: false,
            duplicateProviderMutation: false,
            orderResubmitted: false,
            errorCode: recoveredReplay.errorCode,
          },
        );
      }
      return {
        order,
        replayed: true,
        recoveryRequired: replay.status !== 'ACKNOWLEDGED',
      };
    }

    const price = Number(input.price);
    const quantity = amendmentQuantity(order, plan, input);
    assertAmendRiskBounds(order, plan, price, quantity);

    if (plan.accountMode !== 'live') throw new Error('LIVE_ACCOUNT_REQUIRED_FOR_PROVIDER_AMEND');
    if (!liveExecutionEnabled(plan.exchange)) throw new Error('LIVE_EXECUTION_DISABLED');

    const policy = await this.repository.getPolicy(userId);
    if (policy.emergencyStopped || process.env.TRADING_EMERGENCY_STOP === 'true'
      || await this.repository.getGlobalEmergencyStop()) {
      throw new Error('EMERGENCY_STOP_ACTIVE');
    }

    const connection = await this.repository.getConnection(userId, plan.exchange);
    if (!connection?.configured || !connection.encryptedCredentials || connection.accountMode !== 'live') {
      throw new Error('AMEND_CONNECTION_UNAVAILABLE');
    }

    const revision = (order.amendments ?? []).length + 1;
    const nextClientId = plan.exchange === 'upbit' || plan.exchange === 'bitget'
      ? nextClientOrderId(userId, order, normalizedRequestId, revision)
      : order.clientOrderId;
    const requestedAt = new Date().toISOString();
    const amendment: TradingOrderAmendment = {
      requestId: normalizedRequestId,
      revision,
      status: 'INTENT_RECORDED',
      previousClientOrderId: order.clientOrderId,
      nextClientOrderId: nextClientId,
      previousExchangeOrderId: order.exchangeOrderId,
      nextExchangeOrderId: null,
      requestedQuantity: ((plan.exchange === 'toss' || plan.exchange === 'kiwoom')
        && plan.market.toUpperCase() === 'US') ? null : quantity,
      requestedPrice: price,
      requestedAt,
      acknowledgedAt: null,
      errorCode: null,
    };
    replaceAmendment(order, amendment);
    order = await this.automation.transition(order, 'ACCEPTED', 'ORDER_AMEND_INTENT_RECORDED', {
      amendmentRevision: revision,
      amendmentRequestId: normalizedRequestId,
      providerMutationAttempted: false,
    });

    try {
      const credentials = decryptTradingCredentials(connection.encryptedCredentials);
      const provider = await this.providerAmend(plan, order, credentials, {
        quantity,
        price,
        nextClientId,
      });

      if (!provider.activeConfirmed) {
        throw new Error('AMEND_POST_QUERY_NOT_CONFIRMED');
      }

      const acknowledged = {
        ...amendment,
        status: 'ACKNOWLEDGED' as const,
        nextExchangeOrderId: provider.nextExchangeOrderId,
        acknowledgedAt: new Date().toISOString(),
      };
      replaceAmendment(order, acknowledged);
      order.clientOrderId = provider.nextClientOrderId;
      order.exchangeOrderId = provider.nextExchangeOrderId;
      order.requestedQuantity = quantity;
      order.remainingQuantity = quantity;
      order.currentLimitPrice = price;
      order.updatedAt = acknowledged.acknowledgedAt;

      order = await this.automation.transition(order, 'ACCEPTED', 'ORDER_AMEND_RECONCILED', {
        amendmentRevision: revision,
        amendmentRequestId: normalizedRequestId,
        providerMutationAttempted: true,
        amendmentAcknowledged: true,
      });
      return { order, replayed: false, recoveryRequired: false };
    } catch (error) {
      const code = error instanceof Error ? error.message.split(':')[0] : 'ORDER_AMEND_FAILED';
      const recovery = {
        ...amendment,
        status: 'RECOVERY_REQUIRED' as const,
        errorCode: code,
      };
      replaceAmendment(order, recovery);
      order.lastErrorCode = code;
      order.manualReviewRequired = true;
      order.updatedAt = new Date().toISOString();
      order = await this.automation.transition(order, 'RECOVERY_REQUIRED', 'ORDER_AMEND_OUTCOME_UNCERTAIN', {
        amendmentRevision: revision,
        amendmentRequestId: normalizedRequestId,
        providerMutationAttempted: true,
        amendmentAcknowledged: false,
        errorCode: code,
        orderResubmitted: false,
      });
      return { order, replayed: false, recoveryRequired: true };
    }
  }

  private async providerAmend(
    plan: TradingPlan,
    order: TradingOrder,
    rawCredentials: Record<string, string>,
    input: { quantity: number; price: number; nextClientId: string },
  ) {
    if (plan.exchange === 'bitget') {
      const credentials = rawCredentials as unknown as BitgetCredentials;
      assertBitget(await sendJson(BASE_URLS.bitget, prepareBitgetAmend(credentials, {
        symbol: plan.symbol,
        clientOrderId: order.clientOrderId,
        newClientOrderId: input.nextClientId,
        quantity: input.quantity,
        price: input.price,
      })));
      const row = bitgetOrderRow(
        await sendJson(BASE_URLS.bitget, prepareBitgetOrderQuery(credentials, plan.symbol, input.nextClientId)),
        input.nextClientId,
      );
      return {
        nextClientOrderId: input.nextClientId,
        nextExchangeOrderId: text(row.orderId ?? row.order_id) ?? order.exchangeOrderId,
        activeConfirmed: true,
      };
    }

    if (plan.exchange === 'upbit') {
      const credentials = rawCredentials as unknown as UpbitCredentials;
      assertUpbit(await sendJson(BASE_URLS.upbit, prepareUpbitAmend(credentials, {
        previousIdentifier: order.clientOrderId,
        newIdentifier: input.nextClientId,
        quantity: input.quantity,
        price: input.price,
      })));
      const row = upbitActiveOrder(
        await sendJson(BASE_URLS.upbit, prepareUpbitOrderQuery(credentials, input.nextClientId)),
        input.nextClientId,
      );
      return {
        nextClientOrderId: input.nextClientId,
        nextExchangeOrderId: text(row.uuid) ?? order.exchangeOrderId,
        activeConfirmed: true,
      };
    }

    if (plan.exchange === 'toss') {
      if (!order.exchangeOrderId) throw new Error('TOSS_AMEND_ORDER_ID_REQUIRED');
      const credentials = rawCredentials as unknown as TossCredentials;
      const tokenPayload = await sendJson(BASE_URLS.toss, prepareTossToken(credentials));
      const authenticated = { ...credentials, accessToken: tossToken(tokenPayload) };
      assertToss(await sendJson(BASE_URLS.toss, prepareTossAmend(authenticated, {
        orderId: order.exchangeOrderId,
        market: plan.market.toUpperCase() as 'KR' | 'US',
        quantity: plan.market.toUpperCase() === 'US' ? null : input.quantity,
        price: input.price,
      })));
      const row = tossActiveOrder(
        await sendJson(BASE_URLS.toss, prepareTossOrderQuery(authenticated, order.exchangeOrderId)),
        order.exchangeOrderId,
      );
      return {
        nextClientOrderId: order.clientOrderId,
        nextExchangeOrderId: text(row.orderId ?? row.order_id) ?? order.exchangeOrderId,
        activeConfirmed: true,
      };
    }

    if (!order.exchangeOrderId) throw new Error('KIWOOM_AMEND_ORDER_ID_REQUIRED');
    const credentials = rawCredentials as unknown as KiwoomCredentials;
    const tokenPayload = assertKiwoom(await sendJson(BASE_URLS.kiwoom, prepareKiwoomToken(credentials)));
    const authenticated = { ...credentials, accessToken: kiwoomToken(tokenPayload) };
    const response = assertKiwoom(await sendJson(BASE_URLS.kiwoom, prepareKiwoomAmend(authenticated, plan, {
      orderNo: order.exchangeOrderId,
      quantity: plan.market.toUpperCase() === 'US' ? null : input.quantity,
      price: input.price,
    })));
    const nextOrderId = kiwoomOrderId(response, order.exchangeOrderId);
    const open = plan.market.toUpperCase() === 'US'
      ? await sendJson(BASE_URLS.kiwoom, prepareKiwoomUsUnfilled(authenticated, plan))
      : await sendJson(BASE_URLS.kiwoom, prepareKiwoomUnfilled(authenticated));
    return {
      nextClientOrderId: order.clientOrderId,
      nextExchangeOrderId: nextOrderId,
      activeConfirmed: kiwoomOpenOrderExists(open, nextOrderId),
    };
  }
}
