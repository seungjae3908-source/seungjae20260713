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
  assert.equal(providerSupportsAction('toss', 'ORDER_CANCEL_REPLACE'), false);
});

test('Upbit stays spot BUY/SELL and uses cancel-and-new instead of native modify', () => {
  assert.equal(providerSupportsMarket('upbit', 'CRYPTO_SPOT'), true);
  assert.equal(providerSupportsDirection('upbit', 'SELL'), true);
  assert.equal(providerSupportsDirection('upbit', 'SHORT'), false);
  assert.equal(providerSupportsAction('upbit', 'ORDER_CREATE'), true);
  assert.equal(providerSupportsAction('upbit', 'ORDER_CANCEL'), true);
  assert.equal(providerSupportsAction('upbit', 'ORDER_CANCEL_REPLACE'), true);
  assert.equal(providerSupportsAction('upbit', 'ORDER_MODIFY'), false);
});

test('Bitget stays futures LONG/SHORT and exposes native modify-order capability', () => {
  assert.equal(providerSupportsMarket('bitget', 'CRYPTO_FUTURES'), true);
  assert.equal(providerSupportsDirection('bitget', 'LONG'), true);
  assert.equal(providerSupportsDirection('bitget', 'SHORT'), true);
  assert.equal(providerSupportsAction('bitget', 'ORDER_CREATE'), true);
  assert.equal(providerSupportsAction('bitget', 'ORDER_CANCEL'), true);
  assert.equal(providerSupportsAction('bitget', 'ORDER_MODIFY'), true);
  assert.equal(providerSupportsAction('bitget', 'ORDER_CANCEL_REPLACE'), false);
});
