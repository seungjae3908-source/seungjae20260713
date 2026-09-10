import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { requireSpotCryptoTickerResponse } from '../src/lib/crypto-ticker-response';

const nowMs = Date.parse('2026-09-09T00:00:00.000Z');

const validRow = {
  market: 'KRW-BTC',
  symbol: 'BTC',
  price: 100_000_000,
  change: 'RISE' as const,
  changeRate: 0.01,
  changePercent: 1,
  changePrice: 1_000_000,
  high24h: 101_000_000,
  low24h: 98_000_000,
  volume24h: 1234,
  tradingValue24h: 123_400_000_000,
  timestamp: nowMs,
};

function payload(overrides: Record<string, unknown> = {}) {
  return {
    exchange: 'UPBIT',
    quoteCurrency: 'KRW',
    tickers: [validRow],
    count: 1,
    updatedAt: new Date(nowMs - 10_000).toISOString(),
    ...overrides,
  };
}

test('genuine empty Upbit ticker success remains valid', () => {
  const empty = payload({ tickers: [], count: 0 });
  expect(requireSpotCryptoTickerResponse(empty, nowMs)).toEqual(empty);
});

test('malformed HTTP 200 cannot become safe-looking empty crypto state', () => {
  expect(() => requireSpotCryptoTickerResponse({
    exchange: 'UPBIT',
    quoteCurrency: 'KRW',
    count: 0,
    updatedAt: new Date(nowMs).toISOString(),
  }, nowMs)).toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');

  expect(() => requireSpotCryptoTickerResponse(payload({ count: 0 }), nowMs))
    .toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
});

test('missing or noncanonical ticker fields fail closed instead of becoming zero/normal values', () => {
  const { changePercent: _missing, ...withoutChangePercent } = validRow;
  expect(() => requireSpotCryptoTickerResponse(payload({ tickers: [withoutChangePercent] }), nowMs))
    .toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  expect(() => requireSpotCryptoTickerResponse(payload({ tickers: [{ ...validRow, price: '100000000' }] }), nowMs))
    .toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
  expect(() => requireSpotCryptoTickerResponse(payload({ tickers: [{ ...validRow, market: 'USDT-BTC' }] }), nowMs))
    .toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
});

test('explicit provider nulls remain missing evidence rather than fabricated zero', () => {
  const nullable = {
    ...validRow,
    price: null,
    changeRate: null,
    changePercent: null,
    changePrice: null,
    high24h: null,
    low24h: null,
    volume24h: null,
    tradingValue24h: null,
    timestamp: null,
  };
  expect(requireSpotCryptoTickerResponse(payload({ tickers: [nullable] }), nowMs).tickers[0]?.price).toBeNull();
});

test('stale or future-dated spot ticker HTTP 200 fails closed', () => {
  expect(() => requireSpotCryptoTickerResponse(payload({
    updatedAt: new Date(nowMs - 2 * 60 * 1000 - 1).toISOString(),
  }), nowMs)).toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');

  expect(() => requireSpotCryptoTickerResponse(payload({
    updatedAt: new Date(nowMs + 5 * 1000 + 1).toISOString(),
  }), nowMs)).toThrow('INVALID_SPOT_CRYPTO_TICKER_RESPONSE');
});

test('authorized fetch validates the canonical ticker route before consumers read JSON', () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/auth-fetch.ts'), 'utf8');
  expect(source).toContain("endsWith('/crypto/spot/tickers')");
  expect(source).toContain('requireSpotCryptoTickerResponse(await response.clone().json())');
  expect(source).toContain("throw new Error('INVALID_SPOT_CRYPTO_TICKER_RESPONSE')");
});
