// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';

import router from './stock-orderbook';

async function startServer() {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function close(server: import('node:http').Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('US stock API stays explicitly unavailable without outbound or fake levels', async () => {
  const nativeFetch = globalThis.fetch;
  let outbound = 0;
  const { server, baseUrl } = await startServer();
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(baseUrl)) {
        outbound += 1;
        throw new Error('unexpected outbound request');
      }
      return nativeFetch(input, init);
    }) as typeof fetch;

    const response = await globalThis.fetch(
      `${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.assetClass, 'stock');
    assert.equal(body.market, 'US');
    assert.equal(body.symbol, 'AAPL');
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED');
    assert.equal(body.provider, null);
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(outbound, 0);
  } finally {
    globalThis.fetch = nativeFetch;
    await close(server);
  }
});

test('legacy stock path returns the same read-only unavailable contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/stocks/AAPL/orderbook?market=US`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.assetClass, 'stock');
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED');
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
  } finally {
    await close(server);
  }
});

test('invalid target fails closed and mutation methods are not registered', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const invalid = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&symbol=***`);
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.status, 'invalid');
    assert.equal(invalidBody.reason, 'INVALID_ORDERBOOK_TARGET');
    assert.equal(invalidBody.orderSubmitted, false);
    assert.equal(invalidBody.exchangeRequestSent, false);

    const mutation = await fetch(
      `${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(mutation.status, 404);
  } finally {
    await close(server);
  }
});
