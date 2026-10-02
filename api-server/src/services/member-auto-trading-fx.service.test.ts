import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberAutoTradingKrwRate } from './member-auto-trading-fx.service';

const NOW = Date.parse('2026-09-19T02:00:00.000Z');

test('KR stock and Upbit spot are native KRW without an external request', async () => {
  for (const market of ['KR_STOCK', 'CRYPTO_SPOT'] as const) {
    const result = await resolveMemberAutoTradingKrwRate(market, {
      nowMs: NOW,
      yahooQuote: async () => { throw new Error('SHOULD_NOT_CALL'); },
      publicJson: async () => { throw new Error('SHOULD_NOT_CALL'); },
    });
    assert.equal(result.krwPerQuoteCurrency, 1);
    assert.equal(result.source, 'NATIVE_KRW');
  }
});

test('US stock reuses the Yahoo USDKRW public quote', async () => {
  const result = await resolveMemberAutoTradingKrwRate('US_STOCK', {
    nowMs: NOW,
    yahooQuote: async (ticker) => ({
      ticker,
      price: 1380.5,
      updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
    }),
  });
  assert.equal(result.krwPerQuoteCurrency, 1380.5);
  assert.equal(result.source, 'YAHOO:USDKRW=X');
});

test('crypto futures uses public Upbit KRW-USDT rather than assuming USDT equals USD', async () => {
  let requested = '';
  const result = await resolveMemberAutoTradingKrwRate('CRYPTO_FUTURES', {
    nowMs: NOW,
    publicJson: async (url) => {
      requested = String(url);
      return [{ trade_price: 1382.2, timestamp: NOW - 10_000 }];
    },
  });
  assert.match(requested, /KRW-USDT/u);
  assert.equal(result.krwPerQuoteCurrency, 1382.2);
  assert.equal(result.source, 'UPBIT:KRW-USDT');
});

test('stale or missing FX evidence fails closed', async () => {
  await assert.rejects(
    () => resolveMemberAutoTradingKrwRate('US_STOCK', {
      nowMs: NOW,
      yahooQuote: async () => ({ price: 1380, updatedAt: new Date(NOW - 25 * 60 * 60_000).toISOString() }),
    }),
    /BACKGROUND_USDKRW_RATE_STALE/u,
  );
  await assert.rejects(
    () => resolveMemberAutoTradingKrwRate('CRYPTO_FUTURES', {
      nowMs: NOW,
      publicJson: async () => [{ trade_price: 1380, timestamp: NOW - 11 * 60_000 }],
    }),
    /BACKGROUND_USDTKRW_RATE_STALE/u,
  );
});
