import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express from 'express';
import {
  createMarketInformationRouter,
  type MarketInformationRouterOptions,
} from './market-information';
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

async function start(
  service: Parameters<typeof createMarketInformationRouter>[0],
  options?: MarketInformationRouterOptions,
) {
  const app = express();
  app.use('/api/market-information', createMarketInformationRouter(service, options));
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

test('slow stock room returns bounded partial first paint while allowing canonical source warmup to finish', async () => {
  let providerAborted = false;
  let warmed = false;
  let calls = 0;
  let finishWarmup!: (outcome: 'warmed' | 'aborted') => void;
  const warmupFinished = new Promise<'warmed' | 'aborted'>((resolve) => {
    finishWarmup = resolve;
  });
  const server = await start({
    async getRoom(room, signal): Promise<MarketInformationResponse> {
      assert.equal(room, 'stocks-us');
      calls += 1;
      if (warmed) return fixture(room);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          warmed = true;
          finishWarmup('warmed');
          resolve();
        }, 80);
        const abort = () => {
          providerAborted = true;
          finishWarmup('aborted');
          clearTimeout(timer);
          const reason = signal?.reason;
          reject(reason instanceof Error ? reason : new Error('aborted'));
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
      });
      return fixture(room);
    },
  }, { stockFirstPaintTimeoutMs: 30 });

  try {
    const startedAt = Date.now();
    const firstResponse = await fetch(`${server.baseUrl}/api/market-information/stocks-us`);
    const firstElapsedMs = Date.now() - startedAt;
    assert.equal(firstResponse.status, 200);
    assert.ok(firstElapsedMs < 1_000, `first-paint fallback took ${firstElapsedMs}ms`);
    assert.match(firstResponse.headers.get('cache-control') ?? '', /no-cache/);
    const firstBody = await firstResponse.json() as MarketInformationResponse;
    assert.equal(firstBody.room, 'stocks-us');
    assert.equal(firstBody.partial, true);
    for (const key of ['indices', 'rankings', 'sectors', 'news', 'disclosures'] as const) {
      assert.equal(firstBody.sections[key].status, 'unavailable');
      assert.equal(firstBody.sections[key].data.length, 0);
      assert.equal(firstBody.sections[key].meta.errorCode, 'MARKET_INFORMATION_FIRST_PAINT_TIMEOUT');
      assert.equal(firstBody.sections[key].meta.retryable, true);
      assert.match(firstBody.sections[key].message ?? '', /임시 시세나 순위를 만들지 않았/);
    }
    assert.equal(firstBody.sections.derivatives.status, 'unsupported');
    assert.equal(firstBody.requestPolicy.publicMarketDataOnly, true);
    assert.equal(firstBody.requestPolicy.privateExchangeRequests, 0);
    assert.equal(firstBody.requestPolicy.accountRequests, 0);
    assert.equal(firstBody.requestPolicy.balanceRequests, 0);
    assert.equal(firstBody.requestPolicy.positionRequests, 0);
    assert.equal(firstBody.requestPolicy.orderRequests, 0);
    assert.equal(firstBody.requestPolicy.cancelRequests, 0);
    assert.equal(firstBody.requestPolicy.aiRequests, 0);
    assert.equal(providerAborted, false);

    const warmupOutcome = await Promise.race([
      warmupFinished,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ]);
    assert.equal(warmupOutcome, 'warmed');
    assert.equal(providerAborted, false);
    assert.equal(warmed, true);

    const secondStartedAt = Date.now();
    const secondResponse = await fetch(`${server.baseUrl}/api/market-information/stocks-us`);
    const secondElapsedMs = Date.now() - secondStartedAt;
    assert.equal(secondResponse.status, 200);
    assert.ok(secondElapsedMs < 1_000, `warmed response took ${secondElapsedMs}ms`);
    const secondBody = await secondResponse.json() as MarketInformationResponse;
    assert.equal(secondBody.room, 'stocks-us');
    assert.equal(secondBody.partial, false);
    assert.equal(secondBody.sections.rankings.status, 'ready');
    assert.equal(calls, 2);
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
