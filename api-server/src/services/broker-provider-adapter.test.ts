import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROKER_PROVIDER_CAPABILITIES,
  selectStockProvider,
} from './broker-provider-adapter';
import {
  prepareBitgetFillHistory,
  prepareBitgetOrderHistory,
  prepareTossAccounts,
  prepareTossAmend,
  prepareTossCancel,
  prepareTossBuyingPower,
  prepareTossHoldings,
  prepareTossOrder,
  prepareTossOrderHistory,
  prepareTossToken,
  prepareUpbitClosedOrders,
  prepareUpbitOpenOrders,
  redactPreparedRequest,
  type TossCredentials,
} from './trade-exchange-adapters.service';

const credentials: TossCredentials = {
  clientId: 'client-id-fixture',
  clientSecret: 'client-secret-fixture',
  accessToken: 'access-token-fixture',
};

test('provider capabilities keep markets explicit and never expose withdrawal or transfer', () => {
  assert.deepEqual(BROKER_PROVIDER_CAPABILITIES.toss.markets, ['KR_STOCK', 'US_STOCK']);
  assert.deepEqual(BROKER_PROVIDER_CAPABILITIES.kiwoom.markets, ['KR_STOCK', 'US_STOCK']);
  assert.deepEqual(BROKER_PROVIDER_CAPABILITIES.upbit.markets, ['CRYPTO_SPOT']);
  assert.deepEqual(BROKER_PROVIDER_CAPABILITIES.bitget.markets, ['CRYPTO_FUTURES']);
  for (const capabilities of Object.values(BROKER_PROVIDER_CAPABILITIES)) {
    assert.equal(capabilities.withdrawalSupported, false);
    assert.equal(capabilities.transferSupported, false);
  }
});

test('stock provider selection is Toss-first with Kiwoom fallback', () => {
  assert.equal(selectStockProvider({ toss: true, kiwoom: true }), 'toss');
  assert.equal(selectStockProvider({ toss: false, kiwoom: true }), 'kiwoom');
  assert.equal(selectStockProvider({ toss: false, kiwoom: false }), null);
});

test('Toss official OAuth and private read requests use the documented contracts', () => {
  const token = prepareTossToken(credentials);
  assert.equal(token.path, '/oauth2/token');
  assert.equal(token.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(token.body ?? '', /grant_type=client_credentials/);
  assert.equal(redactPreparedRequest(token).body, '[REDACTED]');

  const accounts = prepareTossAccounts(credentials);
  assert.equal(accounts.method, 'GET');
  assert.equal(accounts.path, '/api/v1/accounts');
  assert.equal(accounts.headers['X-Tossinvest-Account'], undefined);

  const holdings = prepareTossHoldings(credentials, '7', 'aapl');
  assert.equal(holdings.path, '/api/v1/holdings');
  assert.equal(holdings.query, 'symbol=AAPL');
  assert.equal(holdings.headers['X-Tossinvest-Account'], '7');

  const buyingPower = prepareTossBuyingPower(credentials, '7', 'KRW');
  assert.equal(buyingPower.path, '/api/v1/buying-power');
  assert.equal(buyingPower.query, 'currency=KRW');
  assert.equal(buyingPower.headers['X-Tossinvest-Account'], '7');

  const history = prepareTossOrderHistory(credentials, '7', 'OPEN', 'cursor-fixture');
  assert.equal(history.path, '/api/v1/orders');
  assert.equal(history.query, 'status=OPEN&cursor=cursor-fixture');
});

test('Toss order builders enforce quantity/amount and KR/US amend rules', () => {
  const krOrder = prepareTossOrder(credentials, {
    accountSeq: '7', market: 'KR', symbol: '005930', side: 'BUY', orderType: 'LIMIT',
    clientOrderId: 'client-order-1', quantity: 10, price: 70_000,
  });
  assert.equal(krOrder.path, '/api/v1/orders');
  assert.deepEqual(JSON.parse(krOrder.body ?? '{}'), {
    clientOrderId: 'client-order-1', symbol: '005930', side: 'BUY', orderType: 'LIMIT',
    quantity: '10', price: '70000',
  });

  const usAmountOrder = prepareTossOrder(credentials, {
    accountSeq: '7', market: 'US', symbol: 'AAPL', side: 'BUY', orderType: 'MARKET',
    clientOrderId: 'client-order-2', orderAmount: 100.5,
  });
  assert.equal(JSON.parse(usAmountOrder.body ?? '{}').orderAmount, '100.5');

  assert.throws(() => prepareTossOrder(credentials, {
    accountSeq: '7', market: 'KR', symbol: '005930', side: 'BUY', orderType: 'MARKET',
    clientOrderId: 'invalid', orderAmount: 100_000,
  }), /TOSS_AMOUNT_ORDER_US_MARKET_BUY_ONLY/);

  const krAmend = prepareTossAmend(credentials, {
    accountSeq: '7', orderId: 'order/fixture', market: 'KR', quantity: 5, price: 71_000,
  });
  assert.equal(krAmend.path, '/api/v1/orders/order%2Ffixture/modify');
  assert.deepEqual(JSON.parse(krAmend.body ?? '{}'), { orderType: 'LIMIT', quantity: '5', price: '71000' });
  assert.throws(() => prepareTossAmend(credentials, {
    accountSeq: '7', orderId: 'us-order', market: 'US', quantity: 1, price: 185.5,
  }), /TOSS_US_AMEND_QUANTITY_NOT_SUPPORTED/);

  const cancel = prepareTossCancel(credentials, '7', 'order-1');
  assert.equal(cancel.path, '/api/v1/orders/order-1/cancel');
  assert.equal(cancel.body, '{}');
});

test('Toss prepared request redaction never returns bearer or OAuth credentials', () => {
  const redacted = redactPreparedRequest(prepareTossAccounts(credentials));
  assert.equal(redacted.headers.Authorization, '[REDACTED]');
  assert.doesNotMatch(JSON.stringify(redacted), /access-token-fixture|client-secret-fixture/);
});

test('Upbit journal reads use the non-deprecated open and closed order endpoints', () => {
  const upbit = { accessKey: 'access-fixture', secretKey: 'secret-fixture' };
  const open = prepareUpbitOpenOrders(upbit, {
    market: 'krw-btc', state: 'wait', page: 2, limit: 100, orderBy: 'asc',
  }, 'open-nonce');
  assert.equal(open.method, 'GET');
  assert.equal(open.path, '/v1/orders/open');
  assert.equal(open.query, 'market=KRW-BTC&state=wait&page=2&limit=100&order_by=asc');

  const startTimeMs = Date.UTC(2026, 7, 1);
  const closed = prepareUpbitClosedOrders(upbit, {
    market: 'krw-btc', state: 'done', startTimeMs, endTimeMs: startTimeMs + 7 * 86_400_000,
    limit: 1_000, orderBy: 'desc',
  }, 'closed-nonce');
  assert.equal(closed.path, '/v1/orders/closed');
  assert.match(closed.query, /start_time=1785542400000/);
  assert.throws(() => prepareUpbitClosedOrders(upbit, {
    startTimeMs, endTimeMs: startTimeMs + 7 * 86_400_000 + 1,
  }), /UPBIT_CLOSED_ORDER_WINDOW_INVALID/);
  assert.throws(() => prepareUpbitOpenOrders(upbit, { limit: 101 }), /UPBIT_ORDER_LIST_LIMIT_INVALID/);
});

test('Bitget journal reads use official order and fill history windows', () => {
  const bitget = { apiKey: 'key-fixture', secretKey: 'secret-fixture', passphrase: 'pass-fixture' };
  const startTimeMs = Date.UTC(2026, 7, 1);
  const orders = prepareBitgetOrderHistory(bitget, {
    symbol: 'btcusdt', clientOrderId: 'client-1', cursor: 'previous-end', startTimeMs,
    endTimeMs: startTimeMs + 30 * 86_400_000, limit: 100,
  }, '1000');
  assert.equal(orders.method, 'GET');
  assert.equal(orders.path, '/api/v2/mix/order/orders-history');
  assert.match(orders.query, /^productType=USDT-FUTURES&clientOid=client-1&symbol=BTCUSDT/);

  const fills = prepareBitgetFillHistory(bitget, {
    orderId: 'order-1', clientOrderId: 'ignored', startTimeMs, endTimeMs: startTimeMs + 7 * 86_400_000,
  }, '1001');
  assert.equal(fills.path, '/api/v2/mix/order/fill-history');
  assert.match(fills.query, /orderId=order-1/);
  assert.doesNotMatch(fills.query, /clientOid/);
  assert.throws(() => prepareBitgetFillHistory(bitget, {}), /BITGET_FILL_ORDER_REFERENCE_REQUIRED/);
  assert.throws(() => prepareBitgetFillHistory(bitget, {
    orderId: 'order-1', startTimeMs, endTimeMs: startTimeMs + 7 * 86_400_000 + 1,
  }), /BITGET_HISTORY_WINDOW_INVALID/);
});
