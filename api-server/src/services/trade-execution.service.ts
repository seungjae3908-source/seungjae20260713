import { randomUUID } from 'node:crypto';
import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService, liveExecutionEnabled } from './trade-automation.service';
import { TradeCancelReconciliationService } from './trade-cancel-reconciliation.service';
import { TradeOrderRecoveryService } from './trade-order-recovery.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import {
  prepareBitgetAccount,
  prepareBitgetContractConfig,
  prepareBitgetLeverage,
  prepareBitgetMarginMode,
  prepareBitgetOrder,
  prepareBitgetOrderQuery,
  prepareBitgetPendingOrders,
  prepareBitgetPositions,
  prepareBitgetTicker,
  prepareKiwoomOrder,
  prepareKiwoomOrderable,
  prepareKiwoomToken,
  prepareKiwoomUnfilled,
  prepareUpbitAccounts,
  prepareUpbitOrder,
  prepareUpbitOrderChance,
  prepareUpbitOrderQuery,
  prepareUpbitOrderTest,
  validateBitgetContractRules,
  type BitgetCredentials,
  type KiwoomCredentials,
  type PreparedExchangeRequest,
  type UpbitCredentials,
} from './trade-exchange-adapters.service';
import {
  buildBitgetExecutionSnapshot,
  buildKiwoomExecutionSnapshot,
  buildPaperExecutionSnapshot,
  buildUpbitExecutionSnapshot,
  prepareBitgetExecutionDepth,
  prepareKiwoomExecutionOrderbook,
  prepareUpbitExecutionOrderbook,
  prepareUpbitExecutionTicker,
} from './trade-execution-snapshot.service';
import {
  TradePreSubmissionRiskError,
  TradePreSubmissionRiskService,
  type PreSubmissionRiskResult,
} from './trade-pre-submission-risk.service';
import { getScannerSignalLifecycleSnapshot } from './scanner-signal-lifecycle.service';
import type {
  TradingOrder,
  TradingPlan,
  TradingRiskDecision,
} from './trade-automation.types';

type ExchangePayload = Record<string, unknown>;

const BASE_URLS = {
  bitget: 'https://api.bitget.com',
  upbit: 'https://api.upbit.com',
  kiwoom: 'https://api.kiwoom.com',
  kiwoomMock: 'https://mockapi.kiwoom.com',
};

const PREFLIGHT_TIMEOUT_MS = 4_000;
const ORDER_TIMEOUT_MS = 12_000;

function isRecord(value: unknown): value is ExchangePayload {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function orderVersion(order: TradingOrder) {
  return Number.isInteger(order.version) && Number(order.version) >= 0 ? Number(order.version) : 0;
}

function planVersion(plan: TradingPlan) {
  return Number.isInteger(plan.version) && Number(plan.version) >= 0 ? Number(plan.version) : 0;
}

async function sendExchangeRequest(
  baseUrl: string,
  request: PreparedExchangeRequest,
  timeoutMs = ORDER_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function assertBitgetSuccess(payload: ExchangePayload) {
  if (String(payload.code ?? '') !== '00000') throw new Error(`BITGET_${String(payload.code ?? 'INVALID_RESPONSE')}`);
  return payload.data;
}

function assertUpbitSuccess(payload: ExchangePayload) {
  if (payload.error) throw new Error('UPBIT_ORDER_REJECTED');
  return payload;
}

function assertKiwoomSuccess(payload: ExchangePayload) {
  const code = String(payload.return_code ?? payload.returnCode ?? payload.code ?? '0');
  if (!['0', '00000'].includes(code)) throw new Error(`KIWOOM_${code}`);
  return payload;
}

function bitgetPreflight(data: unknown[], plan: TradingPlan, clientOrderId: string) {
  const [accountsRaw, positionsRaw, pendingRaw, tickerRaw] = data;
  const accounts = Array.isArray(accountsRaw) ? accountsRaw.filter(isRecord) : [];
  const positions = Array.isArray(positionsRaw) ? positionsRaw.filter(isRecord) : [];
  const pending = isRecord(pendingRaw) && Array.isArray(pendingRaw.entrustedList)
    ? pendingRaw.entrustedList.filter(isRecord) : [];
  const account = accounts.find((row) => String(row.marginCoin ?? '').toUpperCase() === 'USDT');
  if (!account || Number(account.available ?? 0) <= 0) throw new Error('BITGET_INSUFFICIENT_MARGIN');
  if (String(account.posMode ?? '').toLowerCase() === 'hedge_mode') throw new Error('BITGET_ONE_WAY_MODE_REQUIRED');
  const ticker = Array.isArray(tickerRaw) ? tickerRaw.find(isRecord) : isRecord(tickerRaw) ? tickerRaw : null;
  const markPrice = Number(ticker?.markPrice ?? ticker?.lastPr ?? 0);
  const requestedQuantity = Number(plan.quantity ?? 0);
  const requiredMargin = markPrice * requestedQuantity / Math.max(1, Number(plan.leverage ?? 1));
  if (!Number.isFinite(requiredMargin) || requiredMargin <= 0
    || Number(account.available ?? 0) < requiredMargin * 1.01) {
    throw new Error('BITGET_INSUFFICIENT_MARGIN');
  }
  for (const position of positions) {
    if (String(position.symbol ?? '').toUpperCase() !== plan.symbol.toUpperCase()) continue;
    const liquidationPrice = Number(position.liquidationPrice ?? 0);
    const positionMarkPrice = Number(position.markPrice ?? markPrice);
    const liquidationDistance = positionMarkPrice > 0 && liquidationPrice > 0
      ? Math.abs(positionMarkPrice - liquidationPrice) / positionMarkPrice * 100 : Number.POSITIVE_INFINITY;
    if (liquidationDistance <= 5) throw new Error('BITGET_LIQUIDATION_RISK');
    const currentMarginMode = String(position.marginMode ?? '').toLowerCase();
    if (currentMarginMode && currentMarginMode !== plan.marginMode) throw new Error('BITGET_MARGIN_MODE_MISMATCH');
  }
  const opposite = plan.side === 'long' || plan.side === 'buy' ? 'short' : 'long';
  if (positions.some((row) => String(row.symbol).toUpperCase() === plan.symbol.toUpperCase()
    && String(row.holdSide).toLowerCase() === opposite && Number(row.total ?? 0) > 0)) {
    throw new Error('BITGET_OPPOSITE_POSITION_DUPLICATE');
  }
  if (pending.some((row) => String(row.clientOid ?? '') === clientOrderId)) throw new Error('DUPLICATE_EXCHANGE_ORDER');
  return pending.length === 0
    && !positions.some((row) => String(row.symbol).toUpperCase() === plan.symbol.toUpperCase() && Number(row.total ?? 0) > 0);
}

function marketOpenInSeoul(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (values.weekday === 'Sat' || values.weekday === 'Sun') return false;
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

function decisionFrom(result: PreSubmissionRiskResult): TradingRiskDecision {
  return { allowed: result.allowed, blockCodes: result.blockCodes, warnings: result.warnings };
}

export class TradeExecutionService {
  private automation: TradeAutomationService;
  private recovery: TradeOrderRecoveryService;
  private cancelService: TradeCancelReconciliationService;
  private riskService: TradePreSubmissionRiskService;

  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
    this.recovery = new TradeOrderRecoveryService(repository);
    this.cancelService = new TradeCancelReconciliationService(repository);
    this.riskService = new TradePreSubmissionRiskService(repository);
  }

  async execute(userId: string, plan: TradingPlan, candidate: TradingOrder) {
    let order = await this.repository.getOrder(userId, candidate.id);
    if (!order) throw new Error('TRADE_ORDER_NOT_FOUND');
    if (order.state === 'RECOVERY_REQUIRED') return this.recovery.reconcile(userId, plan, order);
    if (order.state !== 'SUBMITTED') return order;

    if (order.submissionStartedAt) {
      await this.automation.transition(order, 'RECOVERY_REQUIRED', 'SUBMISSION_INTENT_REQUIRES_RECONCILIATION', {
        submissionAttemptId: order.submissionAttemptId,
        orderSubmissionAttempted: true,
      });
      return this.recovery.reconcile(userId, plan, order);
    }

    const connection = await this.repository.getConnection(userId, plan.exchange);
    if (!connection?.configured || !connection.encryptedCredentials) {
      return this.automation.transition(order, 'REJECTED', 'EXCHANGE_CONNECTION_NOT_CONFIGURED', {
        errorCode: 'EXCHANGE_CONNECTION_NOT_CONFIGURED',
        orderSubmissionAttempted: false,
      });
    }
    if (connection.accountMode !== plan.accountMode) {
      return this.automation.transition(order, 'REJECTED', 'ACCOUNT_MODE_MISMATCH', {
        errorCode: 'ACCOUNT_MODE_MISMATCH', orderSubmissionAttempted: false,
      });
    }

    const mockKiwoom = plan.exchange === 'kiwoom' && plan.accountMode === 'mock';
    if (plan.accountMode === 'live' && !liveExecutionEnabled(plan.exchange)) {
      return this.automation.transition(order, 'REJECTED', 'LIVE_EXECUTION_DISABLED', {
        errorCode: 'LIVE_EXECUTION_DISABLED', orderSubmissionAttempted: false,
      });
    }
    if (mockKiwoom && process.env.KIWOOM_MOCK_ORDER_ENABLED !== 'true') {
      return this.automation.transition(order, 'REJECTED', 'KIWOOM_MOCK_EXECUTION_DISABLED', {
        errorCode: 'KIWOOM_MOCK_EXECUTION_DISABLED', orderSubmissionAttempted: false,
      });
    }

    const claimId = randomUUID();
    const claimed = await this.repository.claimOrderExecution(order, orderVersion(order), claimId);
    if (!claimed) return await this.repository.getOrder(userId, order.id) ?? order;
    order = claimed;

    try {
      if (plan.accountMode === 'paper' || (plan.accountMode === 'mock' && plan.exchange !== 'kiwoom')) {
        const risk = await this.riskService.evaluate({
          userId,
          expectedPlan: plan,
          order,
          snapshot: buildPaperExecutionSnapshot(plan),
          serverLiveEnabled: true,
        });
        const metadata = this.riskMetadata(risk, false);
        await this.automation.transition(order, 'ACCEPTED', 'PAPER_BROKER_ACCEPTED', metadata);
        return this.automation.transition(order, 'FILLED', 'PAPER_BROKER_FILLED', {
          ...metadata,
          exchangeOrderId: `paper-${order.clientOrderId}`,
          filledQuantity: plan.quantity ?? 0,
          averageFillPrice: plan.limitPrice ?? (plan.quoteAmount && plan.quantity ? plan.quoteAmount / plan.quantity : null),
        });
      }

      const credentials = decryptTradingCredentials(connection.encryptedCredentials);
      const result = plan.exchange === 'bitget'
        ? await this.executeBitget(userId, plan, order, credentials as BitgetCredentials)
        : plan.exchange === 'upbit'
          ? await this.executeUpbit(userId, plan, order, credentials as UpbitCredentials)
          : await this.executeKiwoom(userId, plan, order, credentials as KiwoomCredentials, mockKiwoom);
      if ('skippedOrder' in result) return result.skippedOrder ?? order;

      const metadata = this.riskMetadata(result.risk, true);
      await this.automation.transition(order, 'ACCEPTED', 'EXCHANGE_ACCEPTED', {
        ...metadata,
        exchangeOrderId: result.orderId,
        submissionAttemptId: order.submissionAttemptId,
      });
      if (result.reconciliationRequired) {
        return this.automation.transition(order, 'RECOVERY_REQUIRED', 'POST_ORDER_RECONCILIATION_REQUIRED', {
          ...metadata,
          errorCode: 'POST_ORDER_QUERY_FAILED',
          submissionAttemptId: order.submissionAttemptId,
        });
      }
      return order;
    } catch (error) {
      if (error instanceof TradePreSubmissionRiskError) {
        await this.expirePlanAfterBlockedRecheck(userId, error.result.plan, order);
        return this.automation.transition(order, 'REJECTED', 'PRE_SUBMISSION_RISK_RECHECK_BLOCKED', {
          errorCode: 'PRE_SUBMISSION_RISK_RECHECK_FAILED',
          preSubmissionCheckedAt: error.result.checkedAt,
          preSubmissionDecision: decisionFrom(error.result),
          preSubmissionSnapshot: error.result.snapshot,
          priceDriftPercent: error.result.priceDriftPercent,
          orderSubmissionAttempted: false,
        });
      }
      const errorCode = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_REQUEST_FAILED';
      if (order.submissionStartedAt) {
        return this.automation.transition(order, 'RECOVERY_REQUIRED', 'AMBIGUOUS_PROVIDER_SUBMISSION_RESULT', {
          errorCode,
          submissionAttemptId: order.submissionAttemptId,
          orderSubmissionAttempted: true,
        });
      }
      return this.automation.transition(order, 'REJECTED', 'PRE_SUBMISSION_OR_EXCHANGE_PREFLIGHT_FAILED', {
        errorCode,
        orderSubmissionAttempted: false,
      });
    }
  }

  async reconcile(userId: string, plan: TradingPlan, order: TradingOrder) {
    return this.recovery.reconcile(userId, plan, order);
  }

  async cancel(userId: string, plan: TradingPlan, order: TradingOrder) {
    return this.cancelService.cancel(userId, plan, order);
  }

  private signalSnapshot(userId: string, plan: TradingPlan) {
    return getScannerSignalLifecycleSnapshot(userId, plan.signalId)
      ?? (plan.marketSnapshot.signalState && plan.marketSnapshot.signalObservedAt
        ? { state: plan.marketSnapshot.signalState, observedAt: plan.marketSnapshot.signalObservedAt }
        : null);
  }

  private riskMetadata(risk: PreSubmissionRiskResult, attempted: boolean) {
    return {
      preSubmissionCheckedAt: risk.checkedAt,
      preSubmissionDecision: decisionFrom(risk),
      preSubmissionSnapshot: risk.snapshot,
      priceDriftPercent: risk.priceDriftPercent,
      orderSubmissionAttempted: attempted,
    };
  }

  private async beginSubmissionIntent(order: TradingOrder, risk: PreSubmissionRiskResult) {
    const submissionAttemptId = randomUUID();
    order.submissionStartedAt = new Date().toISOString();
    order.submissionAttemptId = submissionAttemptId;
    order.preSubmissionCheckedAt = risk.checkedAt;
    order.preSubmissionDecision = decisionFrom(risk);
    order.preSubmissionSnapshot = risk.snapshot;
    const expectedClaimId = order.executionClaimId;
    await this.automation.transition(order, 'SUBMITTED', 'PROVIDER_SUBMISSION_INTENT_RECORDED', {
      ...this.riskMetadata(risk, false),
      submissionAttemptId,
      executionClaimId: expectedClaimId,
    });
    return order.state === 'SUBMITTED'
      && order.submissionAttemptId === submissionAttemptId
      && order.executionClaimId === expectedClaimId
      ? order
      : null;
  }

  private async expirePlanAfterBlockedRecheck(userId: string, plan: TradingPlan, order: TradingOrder) {
    const current = await this.repository.getPlan(userId, plan.id);
    if (!current || current.state !== 'SUBMITTED') return;
    if (order.approvedPlanVersion == null || planVersion(current) !== order.approvedPlanVersion) return;
    await this.repository.compareAndSetPlan({
      ...current,
      state: 'EXPIRED',
      updatedAt: new Date().toISOString(),
    }, 'SUBMITTED', planVersion(current));
  }

  private async executeBitget(
    userId: string,
    plan: TradingPlan,
    order: TradingOrder,
    credentials: BitgetCredentials,
  ) {
    const [accounts, positions, pending, contracts, ticker, depth] = await Promise.all([
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetAccount(credentials), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetPositions(credentials), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetPendingOrders(credentials, plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetContractConfig(plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetTicker(plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetExecutionDepth(plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertBitgetSuccess),
    ]);
    const contractRows = Array.isArray(contracts) ? contracts.filter(isRecord) : [];
    const contract = contractRows.find((row) => String(row.symbol ?? '').toUpperCase() === plan.symbol.toUpperCase());
    if (!contract) throw new Error('BITGET_CONTRACT_RULES_UNAVAILABLE');
    const tickerRows = Array.isArray(ticker) ? ticker.filter(isRecord) : [];
    const tickerRow = tickerRows.find((row) => String(row.symbol ?? '').toUpperCase() === plan.symbol.toUpperCase())
      ?? tickerRows[0];
    validateBitgetContractRules(plan, contract, Number(tickerRow?.markPrice ?? tickerRow?.lastPr ?? 0));
    const canChangeMarginMode = bitgetPreflight([accounts, positions, pending, ticker], plan, order.clientOrderId);
    const risk = await this.riskService.evaluate({
      userId,
      expectedPlan: plan,
      order,
      snapshot: buildBitgetExecutionSnapshot({
        plan, accounts, positions, ticker, depth, contract,
        signal: this.signalSnapshot(userId, plan),
      }),
      serverLiveEnabled: liveExecutionEnabled('bitget'),
    });
    if (canChangeMarginMode) {
      assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
        prepareBitgetMarginMode(credentials, plan.symbol, plan.marginMode ?? 'isolated'), PREFLIGHT_TIMEOUT_MS));
    }
    assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
      prepareBitgetLeverage(credentials, plan.symbol, plan.leverage === 3 ? 3 : 2), PREFLIGHT_TIMEOUT_MS));
    if (!await this.beginSubmissionIntent(order, risk)) {
      return { skippedOrder: await this.repository.getOrder(userId, order.id) ?? order };
    }
    const data = assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
      prepareBitgetOrder(credentials, risk.plan, order.clientOrderId), ORDER_TIMEOUT_MS));
    const row = isRecord(data) ? data : {};
    let reconciliationRequired = false;
    try {
      assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
        prepareBitgetOrderQuery(credentials, order.clientOrderId), PREFLIGHT_TIMEOUT_MS));
    } catch { reconciliationRequired = true; }
    return { orderId: String(row.orderId ?? row.clientOid ?? order.clientOrderId), reconciliationRequired, risk };
  }

  private async executeUpbit(
    userId: string,
    plan: TradingPlan,
    order: TradingOrder,
    credentials: UpbitCredentials,
  ) {
    const [accounts, chance, ticker, orderbook] = await Promise.all([
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitAccounts(credentials), PREFLIGHT_TIMEOUT_MS).then(assertUpbitSuccess),
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitOrderChance(credentials, plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertUpbitSuccess),
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitExecutionTicker(plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertUpbitSuccess),
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitExecutionOrderbook(plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertUpbitSuccess),
    ]);
    const rows = Array.isArray(accounts.data) ? accounts.data.filter(isRecord) : [];
    const krw = rows.find((row) => String(row.currency ?? '') === 'KRW');
    if (plan.side === 'buy' && Number(krw?.balance ?? 0) < Number(plan.quoteAmount ?? plan.estimatedKrw)) {
      throw new Error('UPBIT_INSUFFICIENT_BALANCE');
    }
    const baseCurrency = plan.symbol.toUpperCase().replace(/^KRW-/, '');
    const asset = rows.find((row) => String(row.currency ?? '').toUpperCase() === baseCurrency);
    if (plan.side === 'sell' && Number(asset?.balance ?? 0) < Number(plan.quantity ?? 0)) {
      throw new Error('UPBIT_INSUFFICIENT_ASSET_BALANCE');
    }
    if (isRecord(chance.market) && String(chance.market.state ?? 'active') !== 'active') throw new Error('UPBIT_MARKET_HALTED');
    const chanceSide = isRecord(chance[plan.side === 'buy' ? 'bid' : 'ask'])
      ? chance[plan.side === 'buy' ? 'bid' : 'ask'] as ExchangePayload : null;
    const exchangeMinimum = Number(chanceSide?.min_total ?? 0);
    if (exchangeMinimum > 0 && plan.estimatedKrw < exchangeMinimum) throw new Error('UPBIT_MINIMUM_ORDER');
    const risk = await this.riskService.evaluate({
      userId,
      expectedPlan: plan,
      order,
      snapshot: buildUpbitExecutionSnapshot({
        plan, accounts, chance, ticker, orderbook,
        signal: this.signalSnapshot(userId, plan),
      }),
      serverLiveEnabled: liveExecutionEnabled('upbit'),
    });
    assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
      prepareUpbitOrderTest(credentials, risk.plan, order.clientOrderId), PREFLIGHT_TIMEOUT_MS));
    if (!await this.beginSubmissionIntent(order, risk)) {
      return { skippedOrder: await this.repository.getOrder(userId, order.id) ?? order };
    }
    const result = assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
      prepareUpbitOrder(credentials, risk.plan, order.clientOrderId), ORDER_TIMEOUT_MS));
    let reconciliationRequired = false;
    try {
      assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
        prepareUpbitOrderQuery(credentials, order.clientOrderId), PREFLIGHT_TIMEOUT_MS));
    } catch { reconciliationRequired = true; }
    return { orderId: String(result.uuid ?? result.identifier ?? order.clientOrderId), reconciliationRequired, risk };
  }

  private async executeKiwoom(
    userId: string,
    plan: TradingPlan,
    order: TradingOrder,
    credentials: KiwoomCredentials,
    mock: boolean,
  ) {
    if (!marketOpenInSeoul() && process.env.KIWOOM_ALLOW_OFF_HOURS !== 'true') throw new Error('KIWOOM_MARKET_CLOSED');
    const baseUrl = mock ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
    const tokenPayload = assertKiwoomSuccess(await sendExchangeRequest(
      baseUrl, prepareKiwoomToken(credentials), PREFLIGHT_TIMEOUT_MS));
    const token = String(tokenPayload.token ?? (isRecord(tokenPayload.data) ? tokenPayload.data.token : '') ?? '');
    if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
    const authenticated = { ...credentials, accessToken: token };
    const [orderable, unfilled, orderbook] = await Promise.all([
      sendExchangeRequest(baseUrl, prepareKiwoomOrderable(authenticated), PREFLIGHT_TIMEOUT_MS).then(assertKiwoomSuccess),
      sendExchangeRequest(baseUrl, prepareKiwoomUnfilled(authenticated), PREFLIGHT_TIMEOUT_MS).then(assertKiwoomSuccess),
      sendExchangeRequest(baseUrl, prepareKiwoomExecutionOrderbook(token, plan.symbol), PREFLIGHT_TIMEOUT_MS).then(assertKiwoomSuccess),
    ]);
    const risk = await this.riskService.evaluate({
      userId,
      expectedPlan: plan,
      order,
      snapshot: buildKiwoomExecutionSnapshot({
        plan, orderable, unfilled, orderbook,
        signal: this.signalSnapshot(userId, plan),
      }),
      serverLiveEnabled: mock || liveExecutionEnabled('kiwoom'),
    });
    if (!await this.beginSubmissionIntent(order, risk)) {
      return { skippedOrder: await this.repository.getOrder(userId, order.id) ?? order };
    }
    const result = assertKiwoomSuccess(await sendExchangeRequest(
      baseUrl, prepareKiwoomOrder(authenticated, risk.plan), ORDER_TIMEOUT_MS));
    let reconciliationRequired = false;
    try {
      assertKiwoomSuccess(await sendExchangeRequest(
        baseUrl, prepareKiwoomUnfilled(authenticated), PREFLIGHT_TIMEOUT_MS));
    } catch { reconciliationRequired = true; }
    return { orderId: String(result.ord_no ?? result.order_no ?? order.clientOrderId), reconciliationRequired, risk };
  }
}
