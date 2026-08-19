import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareUpbitOpenOrders } from './trade-open-orders-adapters.service';

const credentials = { accessKey: 'access', secretKey: 'secret' };

test('Upbit open-order adapter is read-only and pins market/state/page/limit/order', () => {
  const request = prepareUpbitOpenOrders(credentials, 'BTC', 'wait', 1, 'nonce-open-wait');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v1/orders/open');
  assert.equal(request.query, 'market=KRW-BTC&state=wait&page=1&limit=100&order_by=asc');
  assert.equal(request.body, null);
  assert.match(request.headers.Authorization, /^Bearer /);
});

test('Upbit reserved open orders support later pages without a mutation endpoint', () => {
  const request = prepareUpbitOpenOrders(credentials, 'KRW-ETH', 'watch', 3, 'nonce-open-watch');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v1/orders/open');
  assert.equal(request.query, 'market=KRW-ETH&state=watch&page=3&limit=100&order_by=asc');
  assert.equal(request.body, null);
});

test('invalid page fails before any provider request can be prepared', () => {
  assert.throws(() => prepareUpbitOpenOrders(credentials, 'BTC', 'wait', 0), /UPBIT_OPEN_ORDER_PAGE_INVALID/);
});
