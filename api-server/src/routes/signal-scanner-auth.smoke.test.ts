import test from 'node:test';
import assert from 'node:assert/strict';
import express, { type RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { AuthenticatedRequest, MemberProfile } from '../middleware/auth';
import { ScannerRequestGuard } from '../services/scanner-request-guard.service';
import type { ScannerResponse } from '../services/scanner-signal.types';
import { createBoundedMarketScanRouter } from './bounded-market-scan';
import { createCryptoSignalScanRouter } from './crypto-signal-scan';

function member(level: 'associate' | 'regular' | 'admin'): MemberProfile {
  return {
    id: `member-${level}`,
    login_name: level,
    display_name: level,
    role: level === 'admin' ? 'admin' : 'member',
    status: 'approved',
    membership_level: level,
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

function response(assetClass: 'stock' | 'coin_spot' | 'coin_futures'): ScannerResponse {
  return {
    ok: true,
    requestId: `request-${assetClass}`,
    assetClass,
    market: assetClass === 'stock' ? 'KR' : assetClass === 'coin_spot' ? 'UPBIT' : 'BITGET',
    timeframe: '5m',
    cards: [],
    alerts: [],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 1,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 12_000,
      itemTimeoutMs: 4_000,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'test-public-provider',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: '완료',
    generatedAt: new Date().toISOString(),
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
}

async function withServer(
  configure: (app: express.Express) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  configure(app);
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

test('stock scanner returns 401 without a session', async () => {
  await withServer(
    (app) => app.use('/api/market/scan', createBoundedMarketScanRouter({
      scanner: { scan: async () => response('stock') },
      guard: new ScannerRequestGuard(),
    })),
    async (baseUrl) => {
      const result = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(result.status, 401);
      assert.equal((await result.json() as { error: string }).error, 'LOGIN_REQUIRED');
    },
  );
});

test('associate and regular may use the public stock scanner without gaining order or Risk capabilities', async () => {
  const scanner = { scan: async () => response('stock') };
  for (const level of ['associate', 'regular'] as const) {
    await withServer(
      (app) => {
        app.use(inject(member(level)));
        app.use('/api/market/scan', createBoundedMarketScanRouter({ scanner, guard: new ScannerRequestGuard() }));
      },
      async (baseUrl) => {
        const result = await fetch(`${baseUrl}/api/market/scan?market=KR`);
        assert.equal(result.status, 200);
        const body = await result.json() as ScannerResponse;
        assert.equal(body.orderSubmitted, false);
        assert.equal(body.exchangeRequestSent, false);
      },
    );
  }
});

test('associate may scan public Upbit spot and Bitget futures data without receiving general futures capability', async () => {
  await withServer(
    (app) => {
      app.use(inject(member('associate')));
      app.use('/api/scanner/crypto', createCryptoSignalScanRouter({
        scanner: {
          scan: async (request) => response(request.market === 'spot' ? 'coin_spot' : 'coin_futures'),
        },
        guard: new ScannerRequestGuard(),
      }));
    },
    async (baseUrl) => {
      const spot = await fetch(`${baseUrl}/api/scanner/crypto/spot?strategy=scalping&timeframe=5m`);
      assert.equal(spot.status, 200);
      const futures = await fetch(`${baseUrl}/api/scanner/crypto/futures?strategy=scalping&timeframe=5m`);
      assert.equal(futures.status, 200);
    },
  );
});

test('Williams condition stays read-only, maps base scan to breakout and invokes only the overlay', async () => {
  let scannedCondition: string | null = null;
  let overlayCalls = 0;
  await withServer(
    (app) => {
      app.use(inject(member('regular')));
      app.use('/api/scanner/crypto', createCryptoSignalScanRouter({
        scanner: {
          scan: async (request) => {
            scannedCondition = request.condition;
            return response(request.market === 'spot' ? 'coin_spot' : 'coin_futures');
          },
        },
        williamsOverlay: {
          apply: async (input) => {
            overlayCalls += 1;
            return { cards: input.cards, matchedCount: 0, unavailableCount: 0 };
          },
        },
        guard: new ScannerRequestGuard(),
      }));
    },
    async (baseUrl) => {
      const result = await fetch(`${baseUrl}/api/scanner/crypto/spot?strategy=scalping&timeframe=5m&condition=williams`);
      assert.equal(result.status, 200);
      const body = await result.json() as ScannerResponse & { condition?: string };
      assert.equal(body.orderSubmitted, false);
      assert.equal(body.exchangeRequestSent, false);
      assert.equal(body.condition, 'williams');
    },
  );
  assert.equal(scannedCondition, 'breakout');
  assert.equal(overlayCalls, 1);
});

test('non-admin grade=S query tampering fails closed while admin may request S', async () => {
  const scanner = { scan: async () => response('stock') };
  for (const level of ['associate', 'regular'] as const) {
    let scanCalls = 0;
    await withServer(
      (app) => {
        app.use(inject(member(level)));
        app.use('/api/market/scan', createBoundedMarketScanRouter({
          scanner: { scan: async () => { scanCalls += 1; return response('stock'); } },
          guard: new ScannerRequestGuard(),
        }));
      },
      async (baseUrl) => {
        const result = await fetch(`${baseUrl}/api/market/scan?market=KR&grade=S`);
        assert.equal(result.status, 403);
        assert.equal((await result.json() as { error: string }).error, 'SCANNER_GRADE_FORBIDDEN');
      },
    );
    assert.equal(scanCalls, 0);
  }
  await withServer(
    (app) => {
      app.use(inject(member('admin')));
      app.use('/api/market/scan', createBoundedMarketScanRouter({ scanner, guard: new ScannerRequestGuard() }));
    },
    async (baseUrl) => {
      const result = await fetch(`${baseUrl}/api/market/scan?market=KR&grade=S`);
      assert.equal(result.status, 200);
    },
  );
});

test('same member and same conditions receive duplicate 409 while first scan is active', async () => {
  let release: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await withServer(
    (app) => {
      app.use(inject(member('regular')));
      app.use('/api/market/scan', createBoundedMarketScanRouter({
        scanner: {
          scan: async () => {
            await pending;
            return response('stock');
          },
        },
        guard: new ScannerRequestGuard({ maxConcurrentPerMember: 2 }),
      }));
    },
    async (baseUrl) => {
      const first = fetch(`${baseUrl}/api/market/scan?market=KR&indicators=거래량%20증가`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const duplicate = await fetch(`${baseUrl}/api/market/scan?market=KR&indicators=거래량%20증가`);
      assert.equal(duplicate.status, 409);
      assert.equal((await duplicate.json() as { error: string }).error, 'SCAN_DUPLICATE_REQUEST');
      release?.();
      assert.equal((await first).status, 200);
    },
  );
});

test('per-member request quota returns 429 with Retry-After', async () => {
  await withServer(
    (app) => {
      app.use(inject(member('regular')));
      app.use('/api/market/scan', createBoundedMarketScanRouter({
        scanner: { scan: async () => response('stock') },
        guard: new ScannerRequestGuard({ maxRequestsPerWindow: 1, windowMs: 60_000 }),
      }));
    },
    async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/market/scan?market=KR`);
      assert.equal(first.status, 200);
      const second = await fetch(`${baseUrl}/api/market/scan?market=US`);
      assert.equal(second.status, 429);
      assert.equal((await second.json() as { error: string }).error, 'SCAN_RATE_LIMITED');
      assert.ok(Number(second.headers.get('Retry-After')) >= 1);
    },
  );
});