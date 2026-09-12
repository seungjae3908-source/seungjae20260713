import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.tsx', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const bootstrapPath = fileURLToPath(new URL('../src/lib/scanner-response-guard-bootstrap.ts', import.meta.url));
const guardPath = fileURLToPath(new URL('../src/lib/scanner-response-guard.ts', import.meta.url));
const scannerPath = fileURLToPath(new URL('../src/pages/scanner.tsx', import.meta.url));

test('scanner success truth keeps the api.scan boundary while deferring the heavy validator from app cold bootstrap', async () => {
  const [main, authFetch, bootstrap, guard, scanner] = await Promise.all([
    readFile(mainPath, 'utf8'),
    readFile(authFetchPath, 'utf8'),
    readFile(bootstrapPath, 'utf8'),
    readFile(guardPath, 'utf8'),
    readFile(scannerPath, 'utf8'),
  ]);

  expect(guard).toContain("value.ok !== true || value.assetClass !== 'stock'");
  expect(guard).toContain("value.market !== 'KR' && value.market !== 'US'");
  expect(guard).toContain('!Array.isArray(value.cards)');
  expect(guard).toContain("value.orderSubmitted !== false || value.exchangeRequestSent !== false");
  expect(guard).toContain("!HEALTHY_OUTCOMES.has(value.outcome)");
  expect(guard).toContain('ticker: card.symbol');
  expect(guard).toContain('isFresh(value.generatedAt');

  expect(main).not.toContain("from '@/lib/scanner-response-guard'");
  expect(main).toContain("from '@/lib/scanner-response-guard-bootstrap'");
  expect(main).toContain('installDeferredScannerResponseGuard();');
  expect(authFetch).not.toContain("path === '/api/market/scan' && method === 'GET'");
  expect(bootstrap).toContain("import { api } from './api'");
  expect(bootstrap).not.toContain("import { validateScannerResponse } from './scanner-response-guard'");
  expect(bootstrap).toContain("await import('./scanner-response-guard')");
  expect(bootstrap).toContain('const originalScan: ScanMethod = api.scan');
  expect(bootstrap).toContain('const value = await originalScan(...args)');
  expect(bootstrap).toContain('validateScannerResponse(value, {');
  expect(bootstrap).toContain('selected: args[0]');
  expect(bootstrap).toContain('market: args[1]');
  expect(bootstrap).toContain('timeframe: args[2]?.timeframe');
  expect(scanner).toContain('api.scan(selected, market');
  expect(scanner).toContain('조건에 맞는 종목이 없습니다. (조회는 정상 — 오류 아님)');

  const install = main.indexOf('installDeferredScannerResponseGuard();');
  const render = main.indexOf("createRoot(document.getElementById('root')!)");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(render).toBeGreaterThan(install);
});
