import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareUpbitOpenOrders } from './trade-open-orders-adapters.service';

const credentials = { accessKey: 'access', secretKey: 'secret' };

test('Upbit open-order adapter is read-only and pins market/state/limit', () => {
  const request = prepareUpbitOpenOrders(credentials, 'BTC', 'wait', 'nonce-open-wait');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v1/orders/open');
  assert.equal(request.query, 'market=KRW-BTC&state=wait&limit=100');
  assert.equal(request.body, null);
  assert.match(request.headers.Authorization, /^Bearer /);
});

test('Upbit reserved open orders use watch state without a mutation endpoint', () => {
  const request = prepareUpbitOpenOrders(credentials, 'KRW-ETH', 'watch', 'nonce-open-watch');
  assert.equal(request.method, 'GET');
  assert.equal(request.path, '/v1/orders/open');
  assert.equal(request.query, 'market=KRW-ETH&state=watch&limit=100');
  assert.equal(request.body, null);
});
