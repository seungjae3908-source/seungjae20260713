import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import marketRouter from './market';
import {
  SectorPopularAvailabilityError,
  SectorPopularService,
  type SectorPopularResult,
} from '../services/sector-popular.service';

type Reader = typeof SectorPopularService.getSectorPopular;

async function requestWith(reader: Reader, market: 'KR' | 'US' = 'KR') {
  const original = SectorPopularService.getSectorPopular;
  SectorPopularService.getSectorPopular = reader;
  const app = express();
  app.use('/api', marketRouter);
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
    const body = await response.json() as Record<string, unknown>;
    return { status: response.status, body };
  } finally {
    SectorPopularService.getSectorPopular = original;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('sector popular provider evidence outage is explicit 200 provider_error without fabricated ranks', async () => {
  const { status, body } = await requestWith(async () => {
    throw new SectorPopularAvailabilityError(
      'SECTOR_POPULAR_PROVIDER_EVIDENCE_UNAVAILABLE',
      'KR',
    );
  });

  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.available, false);
  assert.equal(body.partial, false);
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.retryable, true);
  assert.equal(body.error, 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE');
  assert.equal(body.errorCode, 'SECTOR_POPULAR_PROVIDER_EVIDENCE_UNAVAILABLE');
  assert.deepEqual(body.sectors, []);
  assert.equal(typeof body.updatedAt, 'string');
});

test('sector popular classification evidence outage is also explicit provider_error', async () => {
  const { status, body } = await requestWith(async () => {
    throw new SectorPopularAvailabilityError(
      'SECTOR_POPULAR_CLASSIFICATION_EVIDENCE_UNAVAILABLE',
      'KR',
    );
  });

  assert.equal(status, 200);
  assert.equal(body.dataState, 'provider_error');
  assert.equal(body.errorCode, 'SECTOR_POPULAR_CLASSIFICATION_EVIDENCE_UNAVAILABLE');
  assert.deepEqual(body.sectors, []);
});

test('sector popular successful evidence stays ready and keeps verified rows', async () => {
  const fixture: SectorPopularResult = {
    market: 'KR',
    sortBasis: '거래대금 기준',
    updatedAt: new Date().toISOString(),
    sectors: [{
      key: 'semiconductor',
      label: '반도체',
      rows: [{
        rank: 1,
        ticker: '005930',
        name: '삼성전자',
        market: 'KR',
        currency: 'KRW',
        price: 70000,
        changePercent: 1.2,
        tradingValue: 1000000,
        volume: 10000,
      }],
    }],
  };
  const { status, body } = await requestWith(async () => fixture);

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.available, true);
  assert.equal(body.dataState, 'ready');
  const sectors = body.sectors as Array<Record<string, unknown>>;
  assert.equal(sectors.length, 1);
});

test('sector popular unexpected backend failure remains HTTP 502', async () => {
  const { status, body } = await requestWith(async () => {
    throw new Error('unexpected bug');
  });

  assert.equal(status, 502);
  assert.equal(body.error, 'SECTOR_POPULAR_PROVIDER_ERROR');
  assert.equal(body.dataState, undefined);
});
