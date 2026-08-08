import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import { createMarketInformationRouter } from './market-information';
import {
  MarketInformationError,
  type MarketInformationMeta,
  type MarketInformationResponse,
  type MarketInformationRoomId,
} from '../services/market-information.service';

function fixture(room: MarketInformationRoomId): MarketInformationResponse {
  const stock = room.startsWith('stocks-');
  const spot = room === 'coins-spot';
  const market = room === 'stocks-kr' ? 'KR' as const
    : room === 'stocks-us' ? 'US' as const
      : spot ? 'spot' as const : 'futures' as const;
  const assetType = stock ? 'stock' as const : spot ? 'coin-spot' as const : 'coin-futures' as const;
  const currency = room === 'stocks-us' ? 'USD' as const : room === 'coins-futures' ? 'USDT' as const : 'KRW' as const;
  const meta: MarketInformationMeta = {
    provider: 'fixture',
    source: 'public fixture',
    market,
    assetType,
    currency,
    providerUpdatedAt: '2026-08-05T00:00:00.000Z',
    observedAt: '2026-08-05T00:00:00.000Z',
    fetchedAt: '2026-08-05T00:00:01.000Z',
    marketTimeZone: stock ? (market === 'KR' ? 'Asia/Seoul' : 'America/New_York') : spot ? 'Asia/Seoul' : 'UTC',
    marketStatus: stock ? 'CLOSED' : '24H',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
  const emptyDerivatives = {
    referenceSymbol: 'BTCUSDT',
    longRatio: null,
    shortRatio: null,
    longShortRatio: null,
    ratioObservedAt: null,
    liquidations: [],
  };
  return {
    ok: true,
    room,
    market,
    assetType,
    currency,
    fetchedAt: '2026-08-05T00:00:01.000Z',
    partial: false,
    sections: {
      indices: { status: 'empty', data: [], meta, message: null },
      rankings: { status: 'ready', data: [], meta, message: null },
      sectors: { status: 'empty', data: [], meta, message: null },
      news: { status: 'empty', data: [], meta, message: null },
      disclosures: { status: 'empty', data: [], meta, message: null },
      derivatives: { status: 'empty', data: emptyDerivatives, meta, message: null },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
}

async function start(service: Parameters<typeof createMarketInformationRouter>[0]) {
  const app = express();
  app.use('/api/market-information', createMarketInformationRouter(service));
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

test('market information router serves all four rooms with public-only request policy', async () => {
  const calls: string[] = [];
  const server = await start({
    async getRoom(room) {
      calls.push(room);
      return fixture(room);
    },
  });
  try {
    for (const room of ['stocks-kr', 'stocks-us', 'coins-spot', 'coins-futures'] as const) {
      const response = await fetch(`${server.baseUrl}/api/market-information/${room}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control') ?? '', /no-cache/);
      const text = await response.text();
      assert.doesNotMatch(text, /api[_-]?key|secret|authorization|bearer/i);
      const body = JSON.parse(text) as MarketInformationResponse;
      assert.equal(body.room, room);
      assert.equal(body.requestPolicy.publicMarketDataOnly, true);
      assert.equal(body.requestPolicy.privateExchangeRequests, 0);
      assert.equal(body.requestPolicy.accountRequests, 0);
      assert.equal(body.requestPolicy.positionRequests, 0);
      assert.equal(body.requestPolicy.orderRequests, 0);
      assert.equal(body.requestPolicy.cancelRequests, 0);
      assert.equal(body.requestPolicy.aiRequests, 0);
    }
    assert.deepEqual(calls, ['stocks-kr', 'stocks-us', 'coins-spot', 'coins-futures']);
  } finally {
    await server.close();
  }
});

test('market information router rejects unknown room without calling providers', async () => {
  let called = false;
  const server = await start({
    async getRoom(room) {
      called = true;
      return fixture(room);
    },
  });
  try {
    const response = await fetch(`${server.baseUrl}/api/market-information/unknown`);
    assert.equal(response.status, 404);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.errorCode, 'MARKET_INFORMATION_ROOM_NOT_FOUND');
    assert.equal(body.retryable, false);
    assert.equal(called, false);
  } finally {
    await server.close();
  }
});

test('market information router returns explicit retryable provider errors and zero private requests', async () => {
  const server = await start({
    async getRoom() {
      throw new MarketInformationError('UPSTREAM_RATE_LIMITED', 429, true, 'provider limited');
    },
  });
  try {
    const response = await fetch(`${server.baseUrl}/api/market-information/coins-spot`);
    assert.equal(response.status, 429);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.errorCode, 'UPSTREAM_RATE_LIMITED');
    assert.equal(body.retryable, true);
    const policy = body.requestPolicy as Record<string, unknown>;
    assert.equal(policy.privateExchangeRequests, 0);
    assert.equal(policy.orderRequests, 0);
  } finally {
    await server.close();
  }
});
