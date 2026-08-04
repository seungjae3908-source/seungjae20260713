import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getActiveQuerySignal,
  withActiveQuerySignal,
} from './query-abort-signal';

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
