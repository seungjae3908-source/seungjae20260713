import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import healthRouter from './health';
import futuresMarketDataRouter from './futures-market-data';
import { resetFuturesMarketDataStateForTests } from '../services/futures-market-data.service';

const FIXED_NOW = Date.UTC(2026, 7, 2, 0, 0, 0);

function bitgetPayload(pathname: string) {
  const common = { code: '00000', msg: 'success', requestTime: FIXED_NOW };
  if (pathname.endsWith('/contracts')) {
    return { ...common, data: [{ symbol: 'BTCUSDT', symbolStatus: 'normal' }] };
  }
  if (pathname.endsWith('/ticker')) {
    return {
      ...common,
      data: [{
        symbol: 'BTCUSDT',
        lastPr: '100',
        markPrice: '100.5',
        indexPrice: '100',
        change24h: '0.01',
        baseVolume: '10',
        usdtVolume: '1000',
        bidPr: '99.9',
        askPr: '100.1',
        holdingAmount: '1000',
        fundingRate: '0.000068',
        ts: String(FIXED_NOW),
      }],
    };
  }
  if (pathname.endsWith('/symbol-price')) {
    return {
      ...common,
      data: [{ price: '100', markPrice: '100.5', indexPrice: '100', ts: String(FIXED_NOW) }],
    };
  }
  if (pathname.endsWith('/open-interest')) {
    return {
      ...common,
      data: { ts: String(FIXED_NOW), openInterestList: [{ symbol: 'BTCUSDT', size: '1000' }] },
    };
  }
  if (pathname.endsWith('/current-fund-rate')) {
    return {
      ...common,
      data: [{ fundingRate: '0.000068', nextUpdate: String(FIXED_NOW + 8 * 60 * 60_000) }],
    };
  }
  if (pathname.endsWith('/funding-time')) {
    return {
      ...common,
      data: [{ nextFundingTime: String(FIXED_NOW + 8 * 60 * 60_000) }],
    };
  }
  if (pathname.endsWith('/candles')) {
    const data = Array.from({ length: 100 }, (_, index) => {
      const timestamp = FIXED_NOW - (99 - index) * 15 * 60_000;
      return [String(timestamp), '100', '102', '99', '101', '10', '1010'];
    });
    return { ...common, data };
  }
  return { code: '40400', msg: 'fixture not found', requestTime: FIXED_NOW, data: null };
}

async function readJson(response: Response) {
  const text = await response.text();
  assert.match(response.headers.get('content-type') ?? '', /application\/json/i);
  assert.doesNotMatch(text, /(?:stack|api[_-]?key|secret|futures-market-data\.service\.ts)/i);
  return JSON.parse(text) as Record<string, unknown>;
}

test('public futures routes are registered and return safe schemas', async () => {
  resetFuturesMarketDataStateForTests();
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(raw);
    if (url.hostname !== 'api.bitget.com') return nativeFetch(input, init);
    const payload = bitgetPayload(url.pathname);
    const status = String(payload.code) === '00000' ? 200 : 404;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }) as typeof fetch;

  const app = express();
  app.use('/api', healthRouter);
  app.use('/api', futuresMarketDataRouter);
  const server = app.listen(0, '127.0.0.1');

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const healthResponse = await nativeFetch(`${baseUrl}/api/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { status: 'ok' });

    const statusResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/status`);
    assert.equal(statusResponse.status, 200);
    const statusBody = await readJson(statusResponse);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.provider, 'bitget');
    assert.equal(statusBody.market, 'crypto-futures');
    assert.equal(statusBody.publicDataOnly, true);
    assert.equal(statusBody.orderCapability, false);
    assert.equal(typeof statusBody.updatedAt, 'string');
    assert.ok(Array.isArray(statusBody.warnings));

    const snapshotResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/BTCUSDT/snapshot`);
    assert.equal(snapshotResponse.status, 200);
    const snapshotBody = await readJson(snapshotResponse);
    assert.equal(snapshotBody.ok, true);
    const snapshot = snapshotBody.data as Record<string, unknown>;
    assert.equal(snapshot.symbol, 'BTCUSDT');
    assert.equal(snapshot.markPrice, 100.5);
    assert.equal(snapshot.indexPrice, 100);
    assert.equal(snapshot.openInterest, 1000);
    assert.equal(snapshot.fundingRate, 0.000068);
    assert.equal(typeof snapshot.updatedAt, 'string');
    assert.ok(Array.isArray(snapshot.warnings));

    const candlesResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/BTCUSDT/candles?timeframe=15m&limit=100`);
    assert.equal(candlesResponse.status, 200);
    const candlesBody = await readJson(candlesResponse);
    assert.equal(candlesBody.ok, true);
    assert.equal(candlesBody.symbol, 'BTCUSDT');
    assert.equal(candlesBody.timeframe, '15m');
    assert.equal((candlesBody.data as unknown[]).length, 100);
    assert.ok(Array.isArray(candlesBody.warnings));

    const badSymbolResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/FAKEUSDT/snapshot`);
    assert.equal(badSymbolResponse.status, 400);
    const badSymbolBody = await readJson(badSymbolResponse);
    assert.equal(badSymbolBody.code, 'INVALID_FUTURES_SYMBOL');

    const badTimeframeResponse = await nativeFetch(`${baseUrl}/api/crypto/futures/BTCUSDT/candles?timeframe=2m&limit=100`);
    assert.equal(badTimeframeResponse.status, 400);
    const badTimeframeBody = await readJson(badTimeframeResponse);
    assert.equal(badTimeframeBody.code, 'INVALID_FUTURES_TIMEFRAME');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    globalThis.fetch = nativeFetch;
    resetFuturesMarketDataStateForTests();
  }
});
