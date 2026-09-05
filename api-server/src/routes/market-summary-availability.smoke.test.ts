import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import marketSummaryAvailabilityRouter from './market-summary-availability';

type Fixture = {
  status: number;
  body: Record<string, unknown>;
};

function summaryItem(key: string, price: number, ok: boolean) {
  return {
    key,
    label: key.toUpperCase(),
    price,
    changePercent: ok ? 1.25 : 0,
    spark: ok ? [price - 1, price] : [],
    unit: 'index',
    ok,
  };
}

async function start(fixture: Fixture) {
  const app = express();
  app.use('/api/market/summary', marketSummaryAvailabilityRouter);
  app.get('/api/market/summary', (_req, res) => {
    res.status(fixture.status).json(fixture.body);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function request(fixture: Fixture) {
  const server = await start(fixture);
  try {
    const response = await fetch(`${server.baseUrl}/api/market/summary`);
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    await server.close();
  }
}

test('market summary exposes complete public-provider outage without browser-visible 503 or fake prices', async () => {
  const { status, body } = await request({
    status: 503,
    body: {
      ok: false,
      items: [summaryItem('kospi', 0, false), summaryItem('nasdaq', 0, false)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, false);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.errorCode, 'SUMMARY_PROVIDER_UNAVAILABLE');
  assert.equal(body.retryable, true);
  assert.equal(body.availableCount, 0);
  assert.equal(body.totalCount, 2);
  assert.deepEqual(body.missingKeys, ['kospi', 'nasdaq']);
  assert.deepEqual(body.items, []);
});

test('market summary keeps only verified live rows and marks partial provider availability', async () => {
  const { status, body } = await request({
    status: 200,
    body: {
      ok: true,
      items: [summaryItem('kospi', 3200.25, true), summaryItem('nasdaq', 0, false)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, true);
  assert.equal(body.partial, true);
  assert.equal(body.dataState, 'partial');
  assert.equal(body.errorCode, 'SUMMARY_PROVIDER_PARTIAL');
  assert.equal(body.retryable, true);
  assert.equal(body.availableCount, 1);
  assert.equal(body.totalCount, 2);
  assert.deepEqual(body.missingKeys, ['nasdaq']);
  const items = body.items as Array<Record<string, unknown>>;
  assert.equal(items.length, 1);
  assert.equal(items[0]?.key, 'kospi');
  assert.equal(items[0]?.price, 3200.25);
  assert.equal(items[0]?.ok, true);
});

test('market summary reports ready only when every returned row has a verified positive price', async () => {
  const { status, body } = await request({
    status: 200,
    body: {
      ok: true,
      items: [summaryItem('kospi', 3200.25, true), summaryItem('nasdaq', 17000.5, true)],
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
  });

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'ready');
  assert.equal(body.errorCode, null);
  assert.equal(body.retryable, false);
  assert.equal(body.availableCount, 2);
  assert.deepEqual(body.missingKeys, []);
});

test('market summary does not downgrade unexpected backend failures', async () => {
  const { status, body } = await request({
    status: 502,
    body: {
      ok: false,
      items: [],
      error: 'SUMMARY_PROVIDER_ERROR',
    },
  });

  assert.equal(status, 502);
  assert.equal(body.error, 'SUMMARY_PROVIDER_ERROR');
  assert.equal(body.dataState, undefined);
});
