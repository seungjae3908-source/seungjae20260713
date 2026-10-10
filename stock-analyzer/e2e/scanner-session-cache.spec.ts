import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { ScannerBoundedLastGoodCache, scannerSessionCacheKey } from '../src/lib/scanner-session-cache';

test('identical scanner queries never coalesce across member identities', () => {
  const url = '/api/market/scan?market=US&timeframe=5m';
  const alice = scannerSessionCacheKey(url, 'member-A');
  const bob = scannerSessionCacheKey(url, 'member-B');
  expect(alice).not.toBe(bob);
  expect(scannerSessionCacheKey(url, 'member-A')).toBe(alice);
  expect(scannerSessionCacheKey(url, null)).not.toBe(alice);
  expect(alice).not.toContain('Bearer ');
  expect(bob).not.toContain('Bearer ');
});

test('last-good cached results are bounded, expire, and are never returned for another member', () => {
  let now = 1000;
  const cache = new ScannerBoundedLastGoodCache<{ signalId: string }>(2, 250, () => now);
  const keyA = scannerSessionCacheKey('q', 'A');
  const keyB = scannerSessionCacheKey('q', 'B');
  const keyC = scannerSessionCacheKey('q', 'C');
  cache.set(keyA, { signalId: 'A' });
  expect(cache.get(keyB)).toBeUndefined();
  cache.set(keyB, { signalId: 'B' });
  expect(cache.get(keyA)?.signalId).toBe('A');
  cache.set(keyC, { signalId: 'C' });
  expect(cache.get(keyB)).toBeUndefined();
  expect(cache.get(keyA)?.signalId).toBe('A');
  now += 251;
  expect(cache.get(keyA)).toBeUndefined();
  expect(cache.get(keyC)).toBeUndefined();
});

test('scanner page scopes both request identity and stale UI state to active session', () => {
  const page = readFileSync(new URL('../src/pages/signal-scanner.tsx', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src/lib/signal-scanner.ts', import.meta.url), 'utf8');
  expect(page).toContain('const auth = useAuth();');
  expect(page).toContain('const memberScope = auth.user?.id ?? null;');
  expect(page).toContain('JSON.stringify([request, memberScope])');
  expect(page).toContain('fetchSignalScanner(request, controller.signal, memberScope)');
  expect(lib).toContain('scannerSessionCacheKey(buildSignalScannerRequestUrl(request), memberScope)');
  expect(lib).toContain('new ScannerBoundedLastGoodCache<ScannerResponse>()');
});
