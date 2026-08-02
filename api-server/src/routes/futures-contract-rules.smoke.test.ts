import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import futuresMarketDataRouter from './futures-market-data';
import { resetFuturesContractRulesStateForTests } from '../services/futures-contract-rules.service';

const FIXED_NOW = Date.UTC(2026, 7, 2, 0, 0, 0);

async function startServer() {
  const app = express();
  app.use('/api', futuresMarketDataRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function safeJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|authorization|crypto-auto|place-order)/i);
  return JSON.parse(text) as Record<string, unknown>;
}

test('contract rules route returns public read-only rules and rejects an unknown symbol', async () => {
  resetFuturesContractRulesStateForTests();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw);
    if (url.hostname !== 'api.bitget.com') return nativeFetch(input);
    const symbol = url.searchParams.get('symbol');
    const data = symbol === 'BTCUSDT'
      ? [{
          symbol: 'BTCUSDT',
          symbolStatus: 'normal',
          sizeMultiplier: '0.001',
          minTradeNum: '0.001',
          minTradeUSDT: '5',
          volumePlace: '3',
          pricePlace: '1',
          priceEndStep: '1',
          minLever: '1',
          maxLever: '125',
        }]
      : [];
    return new Response(JSON.stringify({
      code: '00000',
      msg: 'success',
      requestTime: FIXED_NOW,
      data,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;

  const { server, baseUrl } = await startServer();
  try {
    const response = await nativeFetch(`${baseUrl}/api/crypto/futures/BTCUSDT/contract-rules`);
    assert.equal(response.status, 200);
    const body = await safeJson(response);
    assert.equal(body.ok, true);
    assert.equal(body.publicDataOnly, true);
    assert.equal(body.orderCapability, false);
    const data = body.data as Record<string, unknown>;
    assert.equal(data.symbol, 'BTCUSDT');
    assert.equal(data.source, 'bitget');
    assert.equal(data.quantityStep, 0.001);
    assert.equal(data.minimumQuantity, 0.001);
    assert.equal(data.minimumNotional, 5);
    assert.equal(data.quantityPrecision, 3);
    assert.equal(data.pricePrecision, 1);
    assert.equal(data.priceStep, 0.1);
    assert.equal(data.maximumLeverage, 125);
    assert.equal(data.maintenanceMarginRate, null);
    assert.equal(data.status, 'live');
    assert.equal(typeof data.updatedAt, 'string');
    assert.ok(Array.isArray(data.warnings));
    assert.equal('order' in data, false);
    assert.equal('apiKey' in data, false);

    resetFuturesContractRulesStateForTests();
    const badResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/FAKEUSDT/contract-rules`);
    assert.equal(badResponse.status, 400);
    const badBody = await safeJson(badResponse);
    assert.equal(badBody.code, 'INVALID_FUTURES_SYMBOL');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = nativeFetch;
    resetFuturesContractRulesStateForTests();
  }
});

test('contract rules route returns safe 503 when provider is unavailable without cache', async () => {
  resetFuturesContractRulesStateForTests();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('provider unavailable with internal details');
  }) as typeof fetch;

  const { server, baseUrl } = await startServer();
  try {
    const response = await nativeFetch(`${baseUrl}/api/crypto/futures/BTCUSDT/contract-rules`);
    assert.equal(response.status, 503);
    const body = await safeJson(response);
    assert.equal(body.ok, false);
    assert.equal(body.code, 'FUTURES_CONTRACT_RULES_UNAVAILABLE');
    assert.doesNotMatch(String(body.message ?? ''), /internal details/i);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = nativeFetch;
    resetFuturesContractRulesStateForTests();
  }
});
