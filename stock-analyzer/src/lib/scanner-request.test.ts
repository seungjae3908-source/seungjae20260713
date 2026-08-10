import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getActiveQuerySignal,
  withActiveQuerySignal,
} from './query-abort-signal';
import {
  fetchSignalScanner,
  type SignalScannerRequest,
} from './signal-scanner';
import {
  buildSignalScannerRequestUrl,
  SIGNAL_SCANNER_READ_PATHS,
} from './signal-scanner-url';

const repositoryRoot = process.cwd();
const source = (relativePath: string) => fs.readFileSync(
  path.join(repositoryRoot, relativePath),
  'utf8',
);

function installWindowTimerBridge(): void {
  if (typeof window !== 'undefined') return;
  Object.defineProperty(globalThis, 'window', {
    value: globalThis,
    configurable: true,
    writable: true,
  });
}

function scannerRequest(seed: number): SignalScannerRequest {
  return {
    assetClass: 'stock',
    market: 'KR',
    strategy: 'scalping',
    timeframe: '5m',
    conditions: ['거래량 증가'],
    condition: 'trend',
    cursor: seed,
    batchSize: 24,
    minimumScore: 55,
    maximumRiskScore: 70,
  };
}

function scannerSuccess(label: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    requestId: `request-${label}`,
    assetClass: 'stock',
    market: 'KR',
    timeframe: '5m',
    cards: [{
      signalId: `signal-${label}`,
      dataState: 'complete',
      strongSignalEligible: true,
      warnings: [],
    }],
    alerts: [{ idempotencyKey: `alert-${label}` }],
    failures: [],
    execution: {
      requestedCount: 1,
      startedCount: 1,
      completedCount: 1,
      excludedCount: 0,
      providerErrorCount: 0,
      timeoutCount: 0,
      partial: false,
      timedOut: false,
      cancelled: false,
      duplicate: false,
      elapsedMs: 1,
      deadlineMs: 1000,
      itemTimeoutMs: 500,
      maxConcurrency: 1,
    },
    universe: {
      totalCount: 1,
      cursor: 0,
      nextCursor: null,
      source: 'test',
      partial: false,
      stale: false,
      listingStatusCoverage: 'listed-or-unknown',
    },
    dataState: 'complete',
    message: `complete-${label}`,
    generatedAt: '2026-08-10T00:00:00.000Z',
    orderSubmitted: false,
    exchangeRequestSent: false,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function withMockFetch<T>(mock: typeof fetch, work: () => Promise<T>): Promise<T> {
  installWindowTimerBridge();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await work();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('active scanner query signal is available synchronously and restored afterward', () => {
  const outer = new AbortController();
  const inner = new AbortController();
  assert.equal(getActiveQuerySignal(), undefined);

  withActiveQuerySignal(outer.signal, () => {
    assert.equal(getActiveQuerySignal(), outer.signal);
    withActiveQuerySignal(inner.signal, () => {
      assert.equal(getActiveQuerySignal(), inner.signal);
    });
    assert.equal(getActiveQuerySignal(), outer.signal);
  });

  assert.equal(getActiveQuerySignal(), undefined);
});

test('authorized fetch captures the active query signal before async session lookup', () => {
  const authFetch = source('stock-analyzer/src/lib/auth-fetch.ts');
  assert.match(authFetch, /const signal = init\.signal \?\? getActiveQuerySignal\(\)/);
  assert.match(authFetch, /return await fetch\(input, \{ \.\.\.init, headers, signal: controller\.signal \}\)/);
  const signalCapture = authFetch.indexOf('const signal =');
  const sessionLookup = authFetch.indexOf('getSupabase().auth.getSession()');
  assert.ok(sessionLookup >= 0, 'Supabase auth session lookup must remain explicit');
  assert.ok(
    signalCapture >= 0 && signalCapture < sessionLookup,
    'AbortSignal must be captured before the asynchronous auth session lookup',
  );
});

test('scanner query keys cover market, indicators, thresholds, and timeframe race inputs', () => {
  const scanner = source('stock-analyzer/src/pages/scanner.tsx');
  const keyStart = scanner.indexOf('queryKey: [\n      "scan"');
  const keyEnd = scanner.indexOf('],\n    queryFn:', keyStart);
  assert.ok(keyStart >= 0 && keyEnd > keyStart, 'scanner query key must be present');
  const queryKey = scanner.slice(keyStart, keyEnd);
  for (const field of [
    'market',
    'selectedKey',
    'volumeThreshold',
    'tradingValueThreshold',
    'marketCapThreshold',
    'minimumScore',
    'maximumRiskScore',
    'timeframe',
  ]) {
    assert.match(queryKey, new RegExp(`\\b${field}\\b`));
  }
});

test('new signal scanner sends explicit strategy and only scanner read endpoints', () => {
  const scannerPage = source('stock-analyzer/src/pages/signal-scanner.tsx');
  const forbidden = /\/api\/(?:account|orders?|cancel|positions?|execute|approve|private)\b/i;
  const base = {
    conditions: ['거래량 증가'],
    condition: 'trend' as const,
    cursor: 0,
    batchSize: 24,
    minimumScore: 55,
    maximumRiskScore: 70,
  };
  const requests: SignalScannerRequest[] = [
    { ...base, assetClass: 'stock', market: 'KR', strategy: 'scalping', timeframe: '5m' },
    { ...base, assetClass: 'stock', market: 'US', strategy: 'swing', timeframe: '1D' },
    { ...base, assetClass: 'coin_spot', market: 'UPBIT', strategy: 'scalping', timeframe: '3m' },
    { ...base, assetClass: 'coin_futures', market: 'BITGET', strategy: 'swing', timeframe: '4H' },
  ];

  const observedStrategies = new Set<string>();
  for (const request of requests) {
    const built = buildSignalScannerRequestUrl(request);
    const url = new URL(built, 'https://scanner.test');
    assert.equal(SIGNAL_SCANNER_READ_PATHS.includes(url.pathname as typeof SIGNAL_SCANNER_READ_PATHS[number]), true);
    assert.equal(url.searchParams.has('strategy'), true);
    assert.equal(url.searchParams.get('strategy'), request.strategy);
    assert.equal(url.searchParams.get('timeframe'), request.timeframe);
    observedStrategies.add(url.searchParams.get('strategy') ?? '');
    assert.doesNotMatch(url.pathname, forbidden);
    if (request.assetClass === 'stock') {
      assert.equal(url.pathname, '/api/market/scan');
      assert.equal(url.searchParams.get('market'), request.market);
    } else {
      assert.equal(url.searchParams.get('condition'), request.condition);
    }
  }

  assert.deepEqual([...observedStrategies].sort(), ['scalping', 'swing']);
  assert.match(scannerPage, /strategy,\s*timeframe/);
  assert.match(scannerPage, /1m/);
  assert.match(scannerPage, /3m/);
  assert.match(scannerPage, /15m context/);
  assert.match(scannerPage, /1H context/);
  assert.doesNotMatch(scannerPage, forbidden);
});

test('same scanner request key reuses one in-flight upstream request', async () => {
  const request = scannerRequest(101);
  let upstreamCalls = 0;
  let release: ((response: Response) => void) | null = null;

  await withMockFetch(async () => {
    upstreamCalls += 1;
    return await new Promise<Response>((resolve) => { release = resolve; });
  }, async () => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = fetchSignalScanner(request, firstController.signal);
    const second = fetchSignalScanner(request, secondController.signal);

    await Promise.resolve();
    assert.equal(upstreamCalls, 1, 'same requestKey must create at most one upstream request');
    assert.ok(release, 'mock upstream release must be registered');
    release(scannerSuccess('single-flight'));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.requestId, 'request-single-flight');
    assert.equal(secondResult.requestId, 'request-single-flight');
    assert.equal(upstreamCalls, 1);
  });
});

test('409 duplicate keeps last-good data and marks refresh as nonfatal', async () => {
  const request = scannerRequest(102);
  let upstreamCalls = 0;

  await withMockFetch(async () => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) return scannerSuccess('409');
    return new Response(JSON.stringify({ error: 'SCAN_DUPLICATE_REQUEST' }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    await fetchSignalScanner(request, new AbortController().signal);
    const fallback = await fetchSignalScanner(request, new AbortController().signal);

    assert.equal(upstreamCalls, 2);
    assert.equal(fallback.dataState, 'stale');
    assert.equal(fallback.cards.length, 1);
    assert.equal(fallback.execution.duplicate, true);
    assert.equal(fallback.refreshIssue?.status, 409);
    assert.equal(fallback.refreshIssue?.code, 'SCAN_DUPLICATE_REQUEST');
    assert.equal(fallback.alerts.length, 0);
  });
});

test('429 respects Retry-After, keeps last-good, and suppresses immediate upstream retry', async () => {
  const request = scannerRequest(103);
  let upstreamCalls = 0;

  await withMockFetch(async () => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) return scannerSuccess('429');
    return new Response(JSON.stringify({ error: 'SCAN_RATE_LIMITED' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'Retry-After': '7' },
    });
  }, async () => {
    await fetchSignalScanner(request, new AbortController().signal);
    const limited = await fetchSignalScanner(request, new AbortController().signal);
    const backedOff = await fetchSignalScanner(request, new AbortController().signal);

    assert.equal(upstreamCalls, 2, 'Retry-After backoff must skip the immediate third upstream request');
    assert.equal(limited.dataState, 'stale');
    assert.equal(limited.refreshIssue?.status, 429);
    assert.equal(limited.refreshIssue?.retryAfterSeconds, 7);
    assert.equal(backedOff.refreshIssue?.status, 429);
    assert.equal(backedOff.refreshIssue?.code, 'SCAN_RATE_LIMIT_BACKOFF');
    assert.ok((backedOff.refreshIssue?.retryAfterSeconds ?? 0) >= 1);
    assert.equal(backedOff.cards.length, 1);
    assert.equal(backedOff.alerts.length, 0);
  });
});

test('502 provider failure keeps last-good as stale degraded evidence without strong eligibility', async () => {
  const request = scannerRequest(104);
  let upstreamCalls = 0;

  await withMockFetch(async () => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) return scannerSuccess('502');
    return new Response(JSON.stringify({ error: 'SCANNER_PROVIDER_UNAVAILABLE' }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }, async () => {
    await fetchSignalScanner(request, new AbortController().signal);
    const fallback = await fetchSignalScanner(request, new AbortController().signal);

    assert.equal(upstreamCalls, 2);
    assert.equal(fallback.dataState, 'stale');
    assert.equal(fallback.universe.stale, true);
    assert.equal(fallback.execution.partial, true);
    assert.equal(fallback.refreshIssue?.status, 502);
    assert.equal(fallback.cards[0]?.dataState, 'stale');
    assert.equal(fallback.cards[0]?.strongSignalEligible, false);
    assert.match(fallback.refreshIssue?.message ?? '', /공급자 응답이 불안정/);
    assert.equal(fallback.alerts.length, 0);
  });
});

test('QueryClient wraps only scanner queries with the TanStack AbortSignal', () => {
  const app = source('stock-analyzer/src/App.tsx');
  assert.match(app, /resolved\.queryKey\?\.\[0\] !== 'scan'/);
  assert.match(app, /withActiveQuerySignal\(context\.signal, \(\) => queryFn\(context\)\)/);
  assert.match(app, /installScannerAbortBridge\(queryClient\)/);
});

test('scanner readiness UI distinguishes loading, complete, empty, partial, error, and retry', () => {
  const status = source('stock-analyzer/src/components/scanner-readiness-status.tsx');
  for (const marker of [
    'scanner-loading',
    'scanner-success',
    'scanner-empty',
    'scanner-partial',
    'scanner-provider-error',
    '다시 시도',
  ]) {
    assert.match(status, new RegExp(marker));
  }
});
