import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getActiveQuerySignal,
  withActiveQuerySignal,
} from './query-abort-signal';
import {
  buildSignalScannerRequestUrl,
  SIGNAL_SCANNER_READ_PATHS,
} from './signal-scanner-url';
import type { SignalScannerRequest } from './signal-scanner';

const repositoryRoot = process.cwd();
const source = (relativePath: string) => fs.readFileSync(
  path.join(repositoryRoot, relativePath),
  'utf8',
);

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
  assert.match(authFetch, /return fetch\(input, \{ \.\.\.init, headers, signal \}\)/);
  assert.ok(
    authFetch.indexOf('const signal =') < authFetch.indexOf('await getSupabase().auth.getSession()'),
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
