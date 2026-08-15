import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';

import router, {
  setOrderbookKiwoomLoaderForTests,
  setOrderbookPublicTransportForTests,
} from './stock-orderbook';

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

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test.afterEach(() => {
  setOrderbookPublicTransportForTests(null);
  setOrderbookKiwoomLoaderForTests(null);
});

test('US auto policy selects disabled Toss and makes zero outbound requests or fake levels', async () => {
  let outbound = 0;
  setOrderbookPublicTransportForTests({ fetch: async () => {
    outbound += 1;
    throw new Error('unexpected outbound');
  } });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'TOSS_ORDERBOOK_READ_DISABLED');
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
    assert.equal(body.provider, null);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(outbound, 0);

    const unsupported = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL&venue=kiwoom`);
    assert.equal(unsupported.status, 200);
    const unsupportedBody = record(await unsupported.json());
    assert.equal(unsupportedBody.status, 'unavailable');
    assert.equal(unsupportedBody.reason, 'STOCK_ORDERBOOK_VENUE_UNSUPPORTED');
    assert.equal(outbound, 0);
  } finally {
    await close(server);
  }
});

test('invalid symbol fails before outbound and mutation method is not registered', async () => {
  let outbound = 0;
  setOrderbookPublicTransportForTests({ fetch: async () => {
    outbound += 1;
    return Response.json({});
  } });
  const { server, baseUrl } = await startServer();
  try {
    const invalid = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&symbol=BT*C`);
    assert.equal(invalid.status, 400);
    const body = record(await invalid.json());
    assert.equal(body.status, 'invalid');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(outbound, 0);

    const mutation = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(mutation.status, 404);
  } finally {
    await close(server);
  }
});

test('Upbit orderbook uses only public REST and sends no credential headers', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setOrderbookPublicTransportForTests({ fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json([{
      timestamp: Date.now(),
      total_ask_size: 1,
      total_bid_size: 1,
      orderbook_units: [{ ask_price: 101, ask_size: 1, bid_price: 100, bid_size: 1 }],
    }]);
  } });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&market=UPBIT&symbol=KRW-BTC`);
    const body = record(await response.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.symbol, 'BTC');
    assert.equal(typeof body.spreadPct, 'number');
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /^https:\/\/api\.upbit\.com\/v1\/orderbook\?/);
    const headers = new Headers(calls[0]?.init?.headers);
    for (const name of ['authorization', 'access-key', 'access-sign', 'access-passphrase']) {
      assert.equal(headers.has(name), false);
    }
  } finally {
    await close(server);
  }
});

test('Bitget orderbook uses only public depth and fixed futures product type', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setOrderbookPublicTransportForTests({ fetch: async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json({
      code: '00000',
      data: { asks: [['101', '1']], bids: [['100', '1']], ts: String(Date.now()) },
    });
  } });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_futures&market=BITGET&symbol=BTC`);
    const body = record(await response.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.symbol, 'BTCUSDT');
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /^https:\/\/api\.bitget\.com\/api\/v2\/mix\/market\/merge-depth\?/);
    assert.match(calls[0]?.url ?? '', /productType=USDT-FUTURES/);
    const headers = new Headers(calls[0]?.init?.headers);
    for (const name of ['authorization', 'access-key', 'access-sign', 'access-passphrase']) {
      assert.equal(headers.has(name), false);
    }
  } finally {
    await close(server);
  }
});

test('provider failures are canonical unavailable and keep trading side effects false', async () => {
  const { server, baseUrl } = await startServer();
  try {
    setOrderbookKiwoomLoaderForTests(async () => { throw new Error('provider offline'); });
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=KR&symbol=005930`);
    const body = record(await response.json());
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'ORDERBOOK_PROVIDER_UNAVAILABLE');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
  } finally {
    await close(server);
  }
});

test('client cancellation aborts the in-flight public provider request', async () => {
  let providerAborted = false;
  setOrderbookPublicTransportForTests({ fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      providerAborted = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  }) });
  const { server, baseUrl } = await startServer();
  try {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&market=UPBIT&symbol=BTC`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(providerAborted, true);
  } finally {
    await close(server);
  }
});

test('asset class and market mismatches fail closed before any provider or public network request', async () => {
  let publicOutbound = 0;
  let kiwoomOutbound = 0;
  setOrderbookPublicTransportForTests({ fetch: async () => {
    publicOutbound += 1;
    return Response.json({});
  } });
  setOrderbookKiwoomLoaderForTests(async () => {
    kiwoomOutbound += 1;
    return {};
  });
  const { server, baseUrl } = await startServer();
  try {
    for (const query of [
      'assetClass=crypto_spot&market=BITGET&symbol=BTC',
      'assetClass=crypto_futures&market=UPBIT&symbol=BTC',
      'assetClass=stock&market=UPBIT&symbol=005930',
      'assetClass=stock&market=BITGET&symbol=AAPL',
    ]) {
      const response = await fetch(`${baseUrl}/api/orderbook?${query}`);
      assert.equal(response.status, 400);
      const body = record(await response.json());
      assert.equal(body.status, 'invalid');
      assert.equal(body.reason, 'INVALID_ORDERBOOK_TARGET');
      assert.deepEqual(body.asks, []);
      assert.deepEqual(body.bids, []);
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
    }
    assert.equal(publicOutbound, 0);
    assert.equal(kiwoomOutbound, 0);
  } finally {
    await close(server);
  }
});

test('public provider timeout is unavailable without private fallback or fabricated levels', async () => {
  let calls = 0;
  setOrderbookPublicTransportForTests({
    timeoutMs: 10,
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&market=UPBIT&symbol=BTC`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'UPBIT_ORDERBOOK_PROVIDER_TIMEOUT');
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(calls, 1);
  } finally {
    await close(server);
  }
});
