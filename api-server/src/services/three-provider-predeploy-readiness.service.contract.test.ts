import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_PROVIDER_BY_MARKET } from './three-provider-predeploy-readiness.service';

test('provider authority contract', () => {
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.KR_STOCK, 'toss');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.US_STOCK, 'toss');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.CRYPTO_SPOT, 'upbit');
  assert.equal(CANONICAL_PROVIDER_BY_MARKET.CRYPTO_FUTURES, 'bitget');
});
