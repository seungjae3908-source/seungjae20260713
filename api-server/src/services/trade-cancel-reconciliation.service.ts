import { randomUUID } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import { liveExecutionEnabled, TradeAutomationService } from './trade-automation.service';
import { TradeOrderRecoveryService } from './trade-order-recovery.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import { tradingProviderHttpErrorCode, tradingProviderNetworkErrorCode, tradingProviderTimeoutCode } from './trade-provider-http-error.service';
import {
  prepareBitgetCancel,
  prepareKiwoomCancel,
  prepareKiwoomToken,
  prepareTossCancel,
  prepareTossToken,
  prepareUpbitCancel,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type TossCredentials,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import type { TradingOrder, TradingPlan } from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  kiwoomMock: 'https://mockapi.kiwoom.com',
  toss: 'https://openapi.tossinvest.com',
};

const TERMINAL_STATES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED']);
const CANCELABLE_STATES = new Set([
  'SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED',
]);

function isRecord(value: unknown): value is ExchangePayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function sendCancelRequest(baseUrl: string, request: PreparedExchangeRequest) {
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
    if (!response.ok) throw new Error(tradingProviderHttpErrorCode(baseUrl, response.status));
    return isRecord(payload) ? payload : { data: payload };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(tradingProviderTimeoutCode(baseUrl));
    if (error instanceof TypeError) throw new Error(tradingProviderNetworkErrorCode(baseUrl));
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertBitgetSuccess(payload: ExchangePayload) {
  if (String(payload.code ?? '') !== '00000') {
    throw new Error(`BITGET_${String(payload.code ?? 'INVALID_RESPONSE')}`);
  }
  return payload;
}

function assertUpbitSuccess(payload: ExchangePayload) {
  if (payload.error) throw new Error('UPBIT_CANCEL_REJECTED');
  return payload;
}

function assertKiwoomSuccess(payload: ExchangePayload) {
  const code = String(payload.return_code ?? payload.returnCode ?? payload.code ?? '0');
  if (!['0', '00000'].includes(code)) throw new Error(`KIWOOM_${code}`);
  return payload;
}

function tokenFrom(payload: ExchangePayload) {
  const nested = isRecord(payload.data) ? payload.data : null;
  const token = String(payload.token ?? nested?.token ?? '').trim();
  if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
  return token;
}

function tossTokenFrom(payload: ExchangePayload) {
  const nested = isRecord(payload.result) ? payload.result : isRecord(payload.data) ? payload.data : null;
  const token = String(payload.access_token ?? nested?.access_token ?? '').trim();
  if (!token) throw new Error('TOSS_TOKEN_MISSING');
  return token;
}

function assertTossSuccess(payload: ExchangePayload) {
  if (payload.error) throw new Error('TOSS_CANCEL_REJECTED');
  const code = String(payload.code ?? payload.return_code ?? '').trim();
  if (code && !['0', '00000', 'SUCCESS'].includes(code.toUpperCase())) throw new Error(`TOSS_${code}`);
  return payload;
}

export class TradeCancelReconciliationService {
  private automation: TradeAutomationService;
  private recovery: TradeOrderRecoveryService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
    this.recovery = new TradeOrderRecoveryService(repository);
  }

  async cancel(userId: string, plan: TradingPlan, candidate: TradingOrder) {
    if (candidate.userId !== userId || plan.userId !== userId || candidate.planId !== plan.id) {
      throw new Error('USER_SCOPE_MISMATCH');
    }
    let order = await this.repository.getOrder(userId, candidate.id);
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');
    if (TERMINAL_STATES.has(order.state) || !CANCELABLE_STATES.has(order.state)) return order;

    if (order.cancelRequestClaimId) {
      if (order.state === 'CANCEL_REQUESTED' && !order.cancelAcknowledgedAt && !order.lastErrorCode) {
        return order;
      }
      return this.reconcileCancellation(userId, plan, order);
    }

    const claimId = randomUUID();
    const now = new Date().toISOString();
    order.cancelRequestClaimId = claimId;
    order.cancelRequestedAt = now;

    if (order.state === 'RECOVERY_REQUIRED') {
      order = await this.automation.transition(order, 'RECOVERY_REQUIRED', 'CANCEL_INTENT_RECORDED_DURING_RECOVERY', {
        cancelRequestClaimId: claimId,
        cancelRequestedAt: now,
        cancelRequestSubmitted: false,
        orderSubmissionAttempted: false,
      });
      if (order.cancelRequestClaimId !== claimId) return order;
      return this.reconcileCancellation(userId, plan, order);
    }

    order.cancelSubmittedAt = now;
    order = await this.automation.transition(order, 'CANCEL_REQUESTED', 'EXCHANGE_CANCEL_CLAIMED', {
      cancelRequestClaimId: claimId,
      cancelRequestedAt: now,
      cancelSubmittedAt: now,
      cancelRequestSubmitted: true,
      filledQuantity: order.filledQuantity,
      orderSubmissionAttempted: false,
    });
    if (order.cancelRequestClaimId !== claimId || order.state !== 'CANCEL_REQUESTED') return order;

    if (plan.accountMode === 'paper' || (plan.accountMode === 'mock' && plan.exchange !== 'kiwoom')) {
      return this.automation.transition(order, 'CANCELED', 'PAPER_BROKER_CANCELED', {
        filledQuantity: order.filledQuantity,
        cancelRequestClaimId: claimId,
        orderSubmissionAttempted: false,
      });
    }

    const connection = await this.repository.getConnection(userId, plan.exchange);
    if (!connection?.configured || !connection.encryptedCredentials || connection.accountMode !== plan.accountMode) {
      order.lastErrorCode = 'CANCEL_CONNECTION_UNAVAILABLE';
      order = await this.toRecovery(order, 'CANCEL_CONNECTION_UNAVAILABLE', false);
      return this.reconcileCancellation(userId, plan, order);
    }

    const mockKiwoom = plan.exchange === 'kiwoom' && plan.accountMode === 'mock';
    if ((!mockKiwoom && !liveExecutionEnabled(plan.exchange))
      || (mockKiwoom && process.env.KIWOOM_MOCK_ORDER_ENABLED !== 'true')) {
      order.lastErrorCode = 'CANCEL_EXECUTION_DISABLED';
      order = await this.toRecovery(order, 'CANCEL_EXECUTION_DISABLED', false);
      return this.reconcileCancellation(userId, plan, order);
    }

    try {
      const credentials = decryptTradingCredentials(connection.encryptedCredentials);
      if (plan.exchange === 'bitget') {
        assertBitgetSuccess(await sendCancelRequest(
          BASE_URLS.bitget,
          prepareBitgetCancel(credentials as BitgetCredentials, plan.symbol, order.clientOrderId),
        ));
      } else if (plan.exchange === 'upbit') {
        assertUpbitSuccess(await sendCancelRequest(
          BASE_URLS.upbit,
          prepareUpbitCancel(credentials as UpbitCredentials, order.clientOrderId),
        ));
      } else if (plan.exchange === 'toss') {
        const tossCredentials = credentials as TossCredentials;
        const tokenPayload = await sendCancelRequest(BASE_URLS.toss, prepareTossToken(tossCredentials));
        if (!order.exchangeOrderId) throw new Error('TOSS_CANCEL_CONTEXT_MISSING');
        const cancelPayload = assertTossSuccess(await sendCancelRequest(
          BASE_URLS.toss,
          prepareTossCancel({ ...tossCredentials, accessToken: tossTokenFrom(tokenPayload) }, order.exchangeOrderId),
        ));
        const result = isRecord(cancelPayload.result) ? cancelPayload.result : cancelPayload;
        const cancelOperationId = String(result.orderId ?? result.order_id ?? '').trim();
        if (!cancelOperationId || cancelOperationId === order.exchangeOrderId) {
          throw new Error('TOSS_CANCEL_OPERATION_ID_INVALID');
        }
        order.cancelOperationId = cancelOperationId;
      } else {
        const baseUrl = mockKiwoom ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
        const kiwoomCredentials = credentials as KiwoomCredentials;
        const tokenPayload = assertKiwoomSuccess(await sendCancelRequest(
          baseUrl,
          prepareKiwoomToken(kiwoomCredentials),
        ));
        if (!order.exchangeOrderId) throw new Error('KIWOOM_CANCEL_CONTEXT_MISSING');
        const remainingQuantity = Math.max(
          0,
          Number(order.remainingQuantity
            ?? (Number(order.requestedQuantity ?? 0) - order.filledQuantity)),
        );
        assertKiwoomSuccess(await sendCancelRequest(
          baseUrl,
          prepareKiwoomCancel(
            { ...kiwoomCredentials, accessToken: tokenFrom(tokenPayload) },
            plan,
            { orderNo: order.exchangeOrderId, quantity: remainingQuantity },
          ),
        ));
      }
      order.cancelAcknowledgedAt = new Date().toISOString();
      order.lastErrorCode = null;
      order = await this.toRecovery(order, 'EXCHANGE_CANCEL_ACKNOWLEDGED_RECONCILE', true);
    } catch (error) {
      const errorCode = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_CANCEL_FAILED';
      order.lastErrorCode = errorCode;
      order = await this.toRecovery(order, 'EXCHANGE_CANCEL_OUTCOME_UNCERTAIN', false);
    }

    return this.reconcileCancellation(userId, plan, order);
  }

  private async toRecovery(order: TradingOrder, reason: string, cancelAcknowledged: boolean) {
    if (TERMINAL_STATES.has(order.state)) return order;
    if (order.state === 'RECOVERY_REQUIRED') return order;
    return this.automation.transition(order, 'RECOVERY_REQUIRED', reason, {
      errorCode: order.lastErrorCode,
      cancelRequestClaimId: order.cancelRequestClaimId,
      cancelSubmittedAt: order.cancelSubmittedAt,
      cancelAcknowledgedAt: order.cancelAcknowledgedAt,
      cancelOperationId: order.cancelOperationId,
      cancelAcknowledged,
      orderSubmissionAttempted: false,
    });
  }

  private async reconcileCancellation(userId: string, plan: TradingPlan, candidate: TradingOrder) {
    let order = candidate;
    if (TERMINAL_STATES.has(order.state)) return order;
    if (order.state !== 'RECOVERY_REQUIRED') {
      order = await this.automation.transition(order, 'RECOVERY_REQUIRED', 'CANCEL_QUERY_FIRST_RECONCILIATION', {
        cancelRequestClaimId: order.cancelRequestClaimId,
        orderSubmissionAttempted: false,
      });
    }
    if (order.state !== 'RECOVERY_REQUIRED') return order;

    order = await this.recovery.reconcile(userId, plan, order);
    if (TERMINAL_STATES.has(order.state) || order.state === 'RECOVERY_REQUIRED') return order;

    if (order.state === 'ACCEPTED' || order.state === 'PARTIALLY_FILLED' || order.state === 'CANCEL_REQUESTED') {
      const now = new Date();
      const retryCount = order.retryCount + 1;
      const requiresReview = retryCount >= 3;
      order.retryCount = retryCount;
      order.lastErrorCode = 'CANCEL_STILL_PENDING';
      order.lastReconciledAt = now.toISOString();
      order.nextRetryAt = requiresReview ? null : new Date(now.getTime() + 30_000 * (2 ** (retryCount - 1))).toISOString();
      order.manualReviewRequired = requiresReview;
      return this.automation.transition(order, 'RECOVERY_REQUIRED',
        requiresReview ? 'CANCEL_RECONCILIATION_MANUAL_REVIEW' : 'CANCEL_RECONCILIATION_RETRY_SCHEDULED', {
          cancelRequestClaimId: order.cancelRequestClaimId,
          filledQuantity: order.filledQuantity,
          remainingQuantity: order.remainingQuantity,
          retryCount,
          nextRetryAt: order.nextRetryAt,
          manualReviewRequired: requiresReview,
          orderSubmissionAttempted: false,
        });
    }

    return order;
  }
}
