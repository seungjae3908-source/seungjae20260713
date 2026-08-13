import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_PROVIDER_BY_MARKET } from './three-provider-predeploy-readiness.service';

test('canonical provider mapping remains fixed', () => {
  assert.deepEqual(CANONICAL_PROVIDER_BY_MARKET, {
    KR_STOCK: 'toss',
    US_STOCK: 'toss',
    CRYPTO_SPOT: 'upbit',
    CRYPTO_FUTURES: 'bitget',
  });
});
