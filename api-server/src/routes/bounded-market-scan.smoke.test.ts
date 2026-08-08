import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest, MemberProfile } from '../middleware/auth';
import { ScanProviderUnavailableError } from '../services/bounded-scanner.service';
import { ScannerRequestGuard } from '../services/scanner-request-guard.service';
import type { ScannerResponse } from '../services/scanner-signal.types';
import { createBoundedMarketScanRouter, type StockScannerRunner } from './bounded-market-scan';

interface ScanResponseBody {
  ok?: boolean;
  partial?: boolean;
  elapsedMs?: number;
  dataState?: string;
  error?: string;
  cards?: unknown[];
  execution?: {
    partial?: boolean;
    timedOut?: boolean;
    timeoutCount?: number;
    elapsedMs?: number;
  };
}

type ScannerResponseOverrides = Omit<Partial<ScannerResponse>, 'execution'> & {
  execution?: Partial<ScannerResponse['execution']>;
};

const completeResult = (overrides: ScannerResponseOverrides = {}): ScannerResponse => {
  const { execution, ...responseOverrides } = overrides;
  return {
    ok: true,
    requestId: 'request-smoke-stock',
    assetClass: 'stock',
    market: 'KR',
    timeframe: '1D',
    cards: [],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 2,
      startedCount: 2,
      completedCount: 2,
      excludedCount: 2,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 100,
      deadlineMs: 12_000,
      itemTimeoutMs: 4_000,
      maxConcurrency: 2,
      ...execution,
    },
    universe: {
      totalCount: 2,
      cursor: 0,
      nextCursor: null,
      source: 'test-public-provider',
      partial: execution?.partial ?? false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: '스캔은 정상 완료됐지만 조건에 맞는 종목이 없습니다.',
    generatedAt: '2026-08-05T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
    ...responseOverrides,
  };
};

function member(): MemberProfile {
  return {
    id: 'member-regular-smoke',
    login_name: 'regular-smoke',
    display_name: 'regular-smoke',
    role: 'member',
    status: 'approved',
    membership_level: 'regular',
    is_active: true,
  };
}

function inject(profile: MemberProfile): RequestHandler {
  return (req, _res, next) => {
    const authenticated = req as AuthenticatedRequest;
    authenticated.member = profile;
    authenticated.accessToken = 'test-token';
    next();
  };
}

async function withServer(
  scanner: StockScannerRunner,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(inject(member()));
  app.use('/api/market/scan', createBoundedMarketScanRouter({
    scanner,
    guard: new ScannerRequestGuard(),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('normal zero-match scan returns HTTP 200 empty', async () => {
  await withServer(
    { scan: async () => completeResult() },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR&indicators=PER%20낮음`);
      assert.equal(response.status, 200);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.ok, true);
      assert.equal(body.partial, false);
      assert.equal(body.execution?.partial, false);
      assert.equal(body.elapsedMs, 100);
      assert.equal(body.elapsedMs, body.execution?.elapsedMs);
      assert.equal(body.dataState, 'complete');
      assert.deepEqual(body.cards, []);
    },
  );
});

test('scalping and swing primary timeframes cannot be mixed', async () => {
  let scannerCalls = 0;
  await withServer(
    { scan: async () => { scannerCalls += 1; return completeResult(); } },
    async (baseUrl) => {
      const wrongScalping = await fetch(`${baseUrl}/api/market/scan?market=KR&strategy=scalping&timeframe=1D`);
      assert.equal(wrongScalping.status, 400);
      assert.equal((await wrongScalping.json() as ScanResponseBody).error, 'SCAN_STRATEGY_TIMEFRAME_MISMATCH');

      const wrongSwing = await fetch(`${baseUrl}/api/market/scan?market=US&strategy=swing&timeframe=3m`);
      assert.equal(wrongSwing.status, 400);
      assert.equal((await wrongSwing.json() as ScanResponseBody).error, 'SCAN_STRATEGY_TIMEFRAME_MISMATCH');
    },
  );
  assert.equal(scannerCalls, 0);
});

test('scalping 3m request reaches scanner with explicit separated strategy', async () => {
  let capturedStrategy = '';
  let capturedTimeframe = '';
  await withServer(
    {
      scan: async (request) => {
        capturedStrategy = request.strategyMode ?? '';
        capturedTimeframe = String(request.filters.timeframe ?? '');
        return completeResult({ timeframe: '3m' });
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=US&strategy=scalping&timeframe=3m`);
      assert.equal(response.status, 200);
    },
  );
  assert.equal(capturedStrategy, 'scalping');
  assert.equal(capturedTimeframe, '3m');
});

test('some item timeouts return explicit partial HTTP 200', async () => {
  await withServer(
    {
      scan: async () => completeResult({
        execution: {
          requestedCount: 10,
          startedCount: 5,
          completedCount: 4,
          timeoutCount: 1,
          partial: true,
          timedOut: true,
          elapsedMs: 11_900,
        },
        dataState: 'partial',
        message: '일부 데이터가 지연됐습니다.',
      }),
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(response.status, 200);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.partial, true);
      assert.equal(body.execution?.partial, true);
      assert.equal(body.execution?.timedOut, true);
      assert.equal(body.execution?.timeoutCount, 1);
      assert.equal(body.elapsedMs, 11_900);
      assert.equal(body.elapsedMs, body.execution?.elapsedMs);
      assert.equal(body.dataState, 'partial');
    },
  );
});

test('unreliable provider scan remains strict HTTP 502', async () => {
  await withServer(
    {
      scan: async () => {
        throw new ScanProviderUnavailableError('provider unavailable');
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(response.status, 502);
      const body = await response.json() as ScanResponseBody;
      assert.equal(body.ok, false);
      assert.equal(body.error, 'SCAN_PROVIDER_ERROR');
      assert.equal(body.dataState, 'unavailable');
      assert.deepEqual(body.cards, []);
    },
  );
});

test('scanner smoke path sends zero order-capable requests', async () => {
  const requestedPaths: string[] = [];
  await withServer(
    { scan: async () => completeResult({ market: 'US' }) },
    async (baseUrl) => {
      const url = `${baseUrl}/api/market/scan?market=US&strategy=swing&timeframe=1D`;
      requestedPaths.push(new URL(url).pathname);
      const response = await fetch(url);
      assert.equal(response.status, 200);
      const body = await response.json() as ScannerResponse;
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
    },
  );
  assert.deepEqual(requestedPaths, ['/api/market/scan']);
  assert.ok(requestedPaths.every((path) => !/(?:account|order|cancel|trade|position|execute|approve|private)/i.test(path)));
});
