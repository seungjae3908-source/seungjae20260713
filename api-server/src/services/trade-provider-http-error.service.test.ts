import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTransientTradingProviderError,
  tradingProviderFromBaseUrl,
  tradingProviderHttpErrorCode,
  tradingProviderNetworkErrorCode,
  tradingProviderTimeoutCode,
} from './trade-provider-http-error.service';

test('provider transport failures retain provider and failure category', () => {
  assert.equal(tradingProviderFromBaseUrl('https://api.upbit.com'), 'UPBIT');
  assert.equal(tradingProviderFromBaseUrl('https://api.bitget.com'), 'BITGET');
  assert.equal(tradingProviderFromBaseUrl('https://api.kiwoom.com'), 'KIWOOM');
  assert.equal(tradingProviderFromBaseUrl('https://openapi.tossinvest.com'), 'TOSS');

  assert.equal(tradingProviderHttpErrorCode('https://openapi.tossinvest.com', 401), 'TOSS_AUTH_FAILED');
  assert.equal(tradingProviderHttpErrorCode('https://api.kiwoom.com', 403), 'KIWOOM_AUTH_OR_IP_REJECTED');
  assert.equal(tradingProviderHttpErrorCode('https://api.upbit.com', 429), 'UPBIT_RATE_LIMITED');
  assert.equal(tradingProviderHttpErrorCode('https://api.bitget.com', 503), 'BITGET_UNAVAILABLE');
  assert.equal(tradingProviderTimeoutCode('https://api.upbit.com'), 'UPBIT_TIMEOUT');
  assert.equal(tradingProviderNetworkErrorCode('https://api.bitget.com'), 'BITGET_NETWORK_ERROR');
});

test('only retryable transport/read failures are classified transient', () => {
  for (const code of [
    'UPBIT_TIMEOUT',
    'BITGET_NETWORK_ERROR',
    'TOSS_RATE_LIMITED',
    'KIWOOM_UNAVAILABLE',
    'KIWOOM_ORDER_LOOKUP_EMPTY',
    'UPBIT_INVALID_RESPONSE',
  ]) {
    assert.equal(isTransientTradingProviderError(code), true, code);
  }
  for (const code of ['TOSS_AUTH_FAILED', 'KIWOOM_AUTH_OR_IP_REJECTED', 'UPBIT_HTTP_400']) {
    assert.equal(isTransientTradingProviderError(code), false, code);
  }
});
