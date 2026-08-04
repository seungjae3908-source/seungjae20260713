import type { TradingRepository } from './trade-automation.repository';
import { TradeAutomationService, liveExecutionEnabled, withTradePlanLock } from './trade-automation.service';
import { decryptTradingCredentials } from './trade-credential-vault.service';
import {
  prepareBitgetAccount,
  prepareBitgetCancel,
  prepareBitgetContractConfig,
  prepareBitgetLeverage,
  prepareBitgetMarginMode,
  prepareBitgetOrder,
  prepareBitgetOrderQuery,
  prepareBitgetPendingOrders,
  prepareBitgetPositions,
  prepareBitgetTicker,
  prepareKiwoomCancel,
  prepareKiwoomOrder,
  prepareKiwoomOrderable,
  prepareKiwoomToken,
  prepareKiwoomUnfilled,
  prepareUpbitAccounts,
  prepareUpbitCancel,
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
import type { TradingOrder, TradingPlan } from './trade-automation.types';

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

async function sendExchangeRequest(baseUrl: string, request: PreparedExchangeRequest) {
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

export class TradeExecutionService {
  private automation: TradeAutomationService;
  constructor(private repository: TradingRepository) {
    this.automation = new TradeAutomationService(repository);
  }

  async execute(userId: string, plan: TradingPlan, order: TradingOrder) {
    return withTradePlanLock(userId, plan.id, async () => {
      const persisted = await this.repository.getOrder(userId, order.id);
      if (persisted) Object.assign(order, persisted);
      if (order.state !== 'SUBMITTED') return order;
      if (await this.automation.executionBlockedByEmergencyStop(userId)) {
        return this.automation.transition(order, 'REJECTED', 'EMERGENCY_STOP_ACTIVE', {
          errorCode: 'EMERGENCY_STOP_ACTIVE',
        });
      }

      const connection = await this.repository.getConnection(userId, plan.exchange);
      if (!connection?.configured || !connection.encryptedCredentials) {
        return this.automation.transition(order, 'REJECTED', 'EXCHANGE_CONNECTION_NOT_CONFIGURED', {
          errorCode: 'EXCHANGE_CONNECTION_NOT_CONFIGURED',
        });
      }
      if (connection.accountMode !== plan.accountMode) {
        return this.automation.transition(order, 'REJECTED', 'ACCOUNT_MODE_MISMATCH', { errorCode: 'ACCOUNT_MODE_MISMATCH' });
      }

      if (plan.accountMode === 'paper' || (plan.accountMode === 'mock' && plan.exchange !== 'kiwoom')) {
        await this.automation.transition(order, 'ACCEPTED', 'PAPER_BROKER_ACCEPTED');
        return this.automation.transition(order, 'FILLED', 'PAPER_BROKER_FILLED', {
          exchangeOrderId: `paper-${order.clientOrderId}`,
          filledQuantity: plan.quantity ?? 0,
          averageFillPrice: plan.limitPrice ?? (plan.quoteAmount && plan.quantity ? plan.quoteAmount / plan.quantity : null),
        });
      }

      const mockKiwoom = plan.exchange === 'kiwoom' && plan.accountMode === 'mock';
      if (!mockKiwoom && !liveExecutionEnabled(plan.exchange)) {
        return this.automation.transition(order, 'REJECTED', 'LIVE_EXECUTION_DISABLED', { errorCode: 'LIVE_EXECUTION_DISABLED' });
      }
      if (mockKiwoom && process.env.KIWOOM_MOCK_ORDER_ENABLED !== 'true') {
        return this.automation.transition(order, 'REJECTED', 'KIWOOM_MOCK_EXECUTION_DISABLED', { errorCode: 'KIWOOM_MOCK_EXECUTION_DISABLED' });
      }
      if (await this.automation.executionBlockedByEmergencyStop(userId)) {
        return this.automation.transition(order, 'REJECTED', 'EMERGENCY_STOP_ACTIVE', {
          errorCode: 'EMERGENCY_STOP_ACTIVE',
        });
      }

      try {
        const credentials = decryptTradingCredentials(connection.encryptedCredentials);
        const result = plan.exchange === 'bitget'
          ? await this.executeBitget(plan, order, credentials as BitgetCredentials)
          : plan.exchange === 'upbit'
            ? await this.executeUpbit(plan, order, credentials as UpbitCredentials)
            : await this.executeKiwoom(plan, order, credentials as KiwoomCredentials, mockKiwoom);
        await this.automation.transition(order, 'ACCEPTED', 'EXCHANGE_ACCEPTED', { exchangeOrderId: result.orderId });
        if (result.reconciliationRequired) {
          return this.automation.transition(order, 'RECOVERY_REQUIRED', 'POST_ORDER_RECONCILIATION_REQUIRED', {
            errorCode: 'POST_ORDER_QUERY_FAILED',
          });
        }
        return order;
      } catch (error) {
        const errorCode = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_REQUEST_FAILED';
        if (errorCode === 'EXCHANGE_TIMEOUT') {
          return this.automation.transition(order, 'RECOVERY_REQUIRED', 'AMBIGUOUS_EXCHANGE_TIMEOUT', { errorCode });
        }
        return this.automation.transition(order, 'REJECTED', 'EXCHANGE_REJECTED', { errorCode });
      }
    });
  }

  async cancel(userId: string, plan: TradingPlan, order: TradingOrder) {
    return withTradePlanLock(userId, plan.id, async () => {
      const persisted = await this.repository.getOrder(userId, order.id);
      if (persisted) Object.assign(order, persisted);
      if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(order.state)) return order;
      if (order.state !== 'CANCEL_REQUESTED') {
        await this.automation.transition(order, 'CANCEL_REQUESTED', 'USER_OR_SIGNAL_CANCEL_REQUESTED', {
          filledQuantity: order.filledQuantity,
        });
      }
      if (plan.accountMode === 'paper' || (plan.accountMode === 'mock' && plan.exchange !== 'kiwoom')) {
        return this.automation.transition(order, 'CANCELED', 'PAPER_BROKER_CANCELED', {
          filledQuantity: order.filledQuantity,
        });
      }

      const connection = await this.repository.getConnection(userId, plan.exchange);
      if (!connection?.configured || !connection.encryptedCredentials || connection.accountMode !== plan.accountMode) {
        return this.automation.transition(order, 'RECOVERY_REQUIRED', 'CANCEL_CONNECTION_UNAVAILABLE', {
          errorCode: 'CANCEL_CONNECTION_UNAVAILABLE',
        });
      }
      const mockKiwoom = plan.exchange === 'kiwoom' && plan.accountMode === 'mock';
      if ((!mockKiwoom && !liveExecutionEnabled(plan.exchange))
        || (mockKiwoom && process.env.KIWOOM_MOCK_ORDER_ENABLED !== 'true')) {
        return this.automation.transition(order, 'RECOVERY_REQUIRED', 'CANCEL_EXECUTION_DISABLED', {
          errorCode: 'CANCEL_EXECUTION_DISABLED',
        });
      }

      try {
        const credentials = decryptTradingCredentials(connection.encryptedCredentials);
        if (plan.exchange === 'bitget') {
          assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
            prepareBitgetCancel(credentials as BitgetCredentials, plan.symbol, order.clientOrderId)));
        } else if (plan.exchange === 'upbit') {
          assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
            prepareUpbitCancel(credentials as UpbitCredentials, order.clientOrderId)));
        } else {
          const baseUrl = mockKiwoom ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
          const kiwoomCredentials = credentials as KiwoomCredentials;
          const tokenPayload = assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomToken(kiwoomCredentials)));
          const token = String(tokenPayload.token ?? (isRecord(tokenPayload.data) ? tokenPayload.data.token : '') ?? '');
          if (!token || !order.exchangeOrderId) throw new Error('KIWOOM_CANCEL_CONTEXT_MISSING');
          assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomCancel(
            { ...kiwoomCredentials, accessToken: token },
            { symbol: plan.symbol, orderNo: order.exchangeOrderId,
              quantity: Math.max(0, Number(order.requestedQuantity ?? 0) - order.filledQuantity) },
          )));
        }
        return this.automation.transition(order, 'CANCELED', 'EXCHANGE_CANCEL_ACCEPTED', {
          filledQuantity: order.filledQuantity,
        });
      } catch (error) {
        const errorCode = error instanceof Error ? error.message.split(':')[0] : 'EXCHANGE_CANCEL_FAILED';
        return this.automation.transition(order, 'RECOVERY_REQUIRED', 'EXCHANGE_CANCEL_REQUIRES_RECONCILIATION', {
          errorCode,
        });
      }
    });
  }

  private async executeBitget(plan: TradingPlan, order: TradingOrder, credentials: BitgetCredentials) {
    const [accounts, positions, pending, contracts, ticker] = await Promise.all([
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetAccount(credentials)).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetPositions(credentials)).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetPendingOrders(credentials, plan.symbol)).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetContractConfig(plan.symbol)).then(assertBitgetSuccess),
      sendExchangeRequest(BASE_URLS.bitget, prepareBitgetTicker(plan.symbol)).then(assertBitgetSuccess),
    ]);
    const contractRows = Array.isArray(contracts) ? contracts.filter(isRecord) : [];
    const contract = contractRows.find((row) => String(row.symbol ?? '').toUpperCase() === plan.symbol.toUpperCase());
    if (!contract) throw new Error('BITGET_CONTRACT_RULES_UNAVAILABLE');
    const tickerRows = Array.isArray(ticker) ? ticker.filter(isRecord) : [];
    const tickerRow = tickerRows.find((row) => String(row.symbol ?? '').toUpperCase() === plan.symbol.toUpperCase())
      ?? tickerRows[0];
    validateBitgetContractRules(plan, contract, Number(tickerRow?.markPrice ?? tickerRow?.lastPr ?? 0));
    const canChangeMarginMode = bitgetPreflight([accounts, positions, pending, ticker], plan, order.clientOrderId);
    if (canChangeMarginMode) {
      assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
        prepareBitgetMarginMode(credentials, plan.symbol, plan.marginMode ?? 'isolated')));
    }
    assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
      prepareBitgetLeverage(credentials, plan.symbol, plan.leverage === 3 ? 3 : 2)));
    const data = assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
      prepareBitgetOrder(credentials, plan, order.clientOrderId)));
    const row = isRecord(data) ? data : {};
    let reconciliationRequired = false;
    try {
      assertBitgetSuccess(await sendExchangeRequest(BASE_URLS.bitget,
        prepareBitgetOrderQuery(credentials, order.clientOrderId)));
    } catch { reconciliationRequired = true; }
    return { orderId: String(row.orderId ?? row.clientOid ?? order.clientOrderId), reconciliationRequired };
  }

  private async executeUpbit(plan: TradingPlan, order: TradingOrder, credentials: UpbitCredentials) {
    const [accounts, chance] = await Promise.all([
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitAccounts(credentials)).then(assertUpbitSuccess),
      sendExchangeRequest(BASE_URLS.upbit, prepareUpbitOrderChance(credentials, plan.symbol)).then(assertUpbitSuccess),
    ]);
    const rows = Array.isArray(accounts.data) ? accounts.data.filter(isRecord) : Array.isArray(accounts) ? accounts.filter(isRecord) : [];
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
    assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
      prepareUpbitOrderTest(credentials, plan, order.clientOrderId)));
    const result = assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
      prepareUpbitOrder(credentials, plan, order.clientOrderId)));
    let reconciliationRequired = false;
    try {
      assertUpbitSuccess(await sendExchangeRequest(BASE_URLS.upbit,
        prepareUpbitOrderQuery(credentials, order.clientOrderId)));
    } catch { reconciliationRequired = true; }
    return { orderId: String(result.uuid ?? result.identifier ?? order.clientOrderId), reconciliationRequired };
  }

  private async executeKiwoom(
    plan: TradingPlan, order: TradingOrder, credentials: KiwoomCredentials, mock: boolean,
  ) {
    if (!marketOpenInSeoul() && process.env.KIWOOM_ALLOW_OFF_HOURS !== 'true') throw new Error('KIWOOM_MARKET_CLOSED');
    const baseUrl = mock ? BASE_URLS.kiwoomMock : BASE_URLS.kiwoom;
    const tokenPayload = assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomToken(credentials)));
    const token = String(tokenPayload.token ?? (isRecord(tokenPayload.data) ? tokenPayload.data.token : '') ?? '');
    if (!token) throw new Error('KIWOOM_TOKEN_MISSING');
    const authenticated = { ...credentials, accessToken: token };
    assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomOrderable(authenticated)));
    assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomUnfilled(authenticated)));
    const result = assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomOrder(authenticated, plan)));
    let reconciliationRequired = false;
    try {
      assertKiwoomSuccess(await sendExchangeRequest(baseUrl, prepareKiwoomUnfilled(authenticated)));
    } catch { reconciliationRequired = true; }
    return { orderId: String(result.ord_no ?? result.order_no ?? order.clientOrderId), reconciliationRequired };
  }
}
