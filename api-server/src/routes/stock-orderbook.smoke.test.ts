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

test('US stock stays unavailable without outbound or fake levels', async () => {
  let outbound = 0;
  setOrderbookPublicTransportForTests({
    fetch: async () => {
      outbound += 1;
      throw new Error('unexpected outbound request');
    },
  });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED');
    assert.equal(body.provider, null);
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
    assert.equal(outbound, 0);
  } finally {
    await close(server);
  }
});

test('legacy US stock path returns the same unavailable contract', async () => {
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/stocks/AAPL/orderbook?market=US`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'unavailable');
    assert.equal(body.reason, 'US_ORDERBOOK_PROVIDER_NOT_CONNECTED');
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);
  } finally {
    await close(server);
  }
});

test('invalid symbols fail closed before outbound and mutation methods are not registered', async () => {
  let outbound = 0;
  setOrderbookPublicTransportForTests({
    fetch: async () => {
      outbound += 1;
      return new Response('{}');
    },
  });
  const { server, baseUrl } = await startServer();
  try {
    for (const path of [
      '/api/orderbook?assetClass=crypto_spot&symbol=BT*C',
      '/api/orderbook?assetClass=crypto_futures&symbol=BTC/USDT',
      '/api/orderbook?assetClass=stock&market=KR&symbol=AAPL',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 400);
      const body = record(await response.json());
      assert.equal(body.status, 'invalid');
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
    }
    assert.equal(outbound, 0);

    const mutation = await fetch(
      `${baseUrl}/api/orderbook?assetClass=stock&market=US&symbol=AAPL`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    assert.equal(mutation.status, 404);
  } finally {
    await close(server);
  }
});

test('Upbit adapter uses only the public orderbook path without authentication headers', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setOrderbookPublicTransportForTests({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json([{
        timestamp: Date.now(),
        total_ask_size: 1,
        total_bid_size: 1,
        orderbook_units: [{ ask_price: 101, ask_size: 1, bid_price: 100, bid_size: 1 }],
      }]);
    },
  });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&market=UPBIT&symbol=KRW-BTC`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.symbol, 'BTC');
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /^https:\/\/api\.upbit\.com\/v1\/orderbook\?/);
    assert.match(calls[0]?.url ?? '', /markets=KRW-BTC/);
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('access-key'), false);
  } finally {
    await close(server);
  }
});

test('Bitget adapter fixes product type and uses no private signature headers', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  setOrderbookPublicTransportForTests({
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json({
        code: '00000',
        data: { asks: [['101', '1']], bids: [['100', '1']], ts: String(Date.now()) },
      });
    },
  });
  const { server, baseUrl } = await startServer();
  try {
    const response = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_futures&market=BITGET&symbol=BTC`);
    assert.equal(response.status, 200);
    const body = record(await response.json());
    assert.equal(body.status, 'ready');
    assert.equal(body.symbol, 'BTCUSDT');
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.url ?? '', /^https:\/\/api\.bitget\.com\/api\/v2\/mix\/market\/merge-depth\?/);
    assert.match(calls[0]?.url ?? '', /symbol=BTCUSDT/);
    assert.match(calls[0]?.url ?? '', /productType=USDT-FUTURES/);
    const headers = new Headers(calls[0]?.init?.headers);
    for (const name of ['authorization', 'access-key', 'access-sign', 'access-passphrase']) {
      assert.equal(headers.has(name), false);
    }
  } finally {
    await close(server);
  }
});

test('public adapters expose 429 and timeout as explicit provider errors', async () => {
  const { server, baseUrl } = await startServer();
  try {
    setOrderbookPublicTransportForTests({
      fetch: async () => new Response('{}', { status: 429 }),
    });
    const limited = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&symbol=BTC`);
    assert.equal(limited.status, 200);
    assert.equal(record(await limited.json()).reason, 'UPBIT_ORDERBOOK_RATE_LIMITED');

    setOrderbookPublicTransportForTests({
      timeoutMs: 10,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
    });
    const timeout = await fetch(`${baseUrl}/api/orderbook?assetClass=crypto_futures&symbol=BTCUSDT`);
    assert.equal(timeout.status, 200);
    assert.equal(record(await timeout.json()).reason, 'BITGET_ORDERBOOK_PROVIDER_TIMEOUT');
  } finally {
    await close(server);
  }
});

test('client cancellation aborts the in-flight public provider request', async () => {
  let providerAborted = false;
  setOrderbookPublicTransportForTests({
    fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        providerAborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }),
  });
  const { server, baseUrl } = await startServer();
  try {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/api/orderbook?assetClass=crypto_spot&symbol=BTC`, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(pending, /abort/i);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(providerAborted, true);
  } finally {
    await close(server);
  }
});

test('Kiwoom not-configured and provider failures remain explicit and read-only', async () => {
  const { server, baseUrl } = await startServer();
  try {
    setOrderbookKiwoomLoaderForTests(async () => {
      throw new Error('KIWOOM_NOT_CONFIGURED');
    });
    const unconfigured = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=KR&symbol=005930`);
    assert.equal(unconfigured.status, 200);
    let body = record(await unconfigured.json());
    assert.equal(body.status, 'provider_error');
    assert.equal(body.reason, 'ORDERBOOK_PROVIDER_NOT_CONFIGURED');
    assert.deepEqual(body.asks, []);
    assert.deepEqual(body.bids, []);

    setOrderbookKiwoomLoaderForTests(async () => {
      throw new Error('provider offline');
    });
    const unavailable = await fetch(`${baseUrl}/api/orderbook?assetClass=stock&market=KR&symbol=005930`);
    body = record(await unavailable.json());
    assert.equal(body.reason, 'ORDERBOOK_PROVIDER_UNAVAILABLE');
    assert.equal(body.orderSubmitted, false);
    assert.equal(body.exchangeRequestSent, false);
  } finally {
    await close(server);
  }
});
