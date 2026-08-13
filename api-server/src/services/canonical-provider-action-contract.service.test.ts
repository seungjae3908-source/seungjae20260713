import test from 'node:test';
import assert from 'node:assert/strict';
import {
  providerSupportsAction,
  providerSupportsDirection,
  providerSupportsMarket,
} from './canonical-provider-action-contract.service';

test('Toss owns KR and US stock actions', () => {
  assert.equal(providerSupportsMarket('toss', 'KR_STOCK'), true);
  assert.equal(providerSupportsMarket('toss', 'US_STOCK'), true);
  assert.equal(providerSupportsDirection('toss', 'BUY'), true);
  assert.equal(providerSupportsDirection('toss', 'LONG'), false);
  assert.equal(providerSupportsAction('toss', 'ORDER_MODIFY'), true);
});

test('Upbit stays spot BUY/SELL and Bitget stays futures LONG/SHORT', () => {
  assert.equal(providerSupportsMarket('upbit', 'CRYPTO_SPOT'), true);
  assert.equal(providerSupportsDirection('upbit', 'SELL'), true);
  assert.equal(providerSupportsDirection('upbit', 'SHORT'), false);
  assert.equal(providerSupportsMarket('bitget', 'CRYPTO_FUTURES'), true);
  assert.equal(providerSupportsDirection('bitget', 'LONG'), true);
  assert.equal(providerSupportsDirection('bitget', 'SHORT'), true);
});
