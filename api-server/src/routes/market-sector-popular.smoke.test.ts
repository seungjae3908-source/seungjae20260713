import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createSectorPopularHandler } from './market-sector-popular';

type Service = Parameters<typeof createSectorPopularHandler>[0];

async function request(service: Service, market = 'KR') {
  const app = express();
  app.get('/api/market/sector-popular', createSectorPopularHandler(service));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/market/sector-popular?market=${market}`,
    );
    return {
      status: response.status,
      body: await response.json() as Record<string, unknown>,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sector popular exposes provider evidence unavailability as a truth-preserving 200 envelope', async () => {
  const service: Service = {
    getSectorPopular: async () => {
      throw new Error('SECTOR_POPULAR_PROVIDER_EVIDENCE_UNAVAILABLE:KR');
    },
  };
  const { status, body } = await request(service);
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, false);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.retryable, true);
  assert.equal(body.market, 'KR');
  assert.equal(body.errorCode, 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE');
  assert.deepEqual(body.sectors, []);
  assert.equal(typeof body.updatedAt, 'string');
});

test('sector popular exposes missing classification evidence without inventing sector rows', async () => {
  const service: Service = {
    getSectorPopular: async () => {
      throw new Error('SECTOR_POPULAR_CLASSIFICATION_EVIDENCE_UNAVAILABLE:US');
    },
  };
  const { status, body } = await request(service, 'US');
  assert.equal(status, 200);
  assert.equal(body.market, 'US');
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.errorCode, 'SECTOR_POPULAR_CLASSIFICATION_UNAVAILABLE');
  assert.deepEqual(body.sectors, []);
});

test('sector popular keeps unknown backend failures as non-2xx errors', async () => {
  const service: Service = {
    getSectorPopular: async () => {
      throw new Error('PROGRAMMING_BUG');
    },
  };
  const { status, body } = await request(service);
  assert.equal(status, 502);
  assert.equal(body.error, 'SECTOR_POPULAR_PROVIDER_ERROR');
  assert.equal(body.dataState, undefined);
});
