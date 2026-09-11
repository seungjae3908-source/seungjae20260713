import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.tsx', import.meta.url));
const authFetchPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const guardPath = fileURLToPath(new URL('../src/lib/scanner-response-guard.ts', import.meta.url));
const scannerPath = fileURLToPath(new URL('../src/pages/scanner.tsx', import.meta.url));

test('scanner success truth is validated on demand before any successful scan response reaches render', async () => {
  const [main, authFetch, guard, scanner] = await Promise.all([
    readFile(mainPath, 'utf8'),
    readFile(authFetchPath, 'utf8'),
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
  expect(main).not.toContain('installScannerResponseGuard();');
  expect(authFetch).not.toContain("import { validateScannerResponse } from '@/lib/scanner-response-guard'");
  expect(authFetch).toContain("path === '/api/market/scan' && method === 'GET'");
  expect(authFetch).toContain("await import('@/lib/scanner-response-guard')");
  expect(authFetch).toContain('validateScannerResponse(payload, scannerRequestExpectation(input))');
  expect(authFetch).toContain("error.message === 'INVALID_SCAN_RESPONSE' || error.message === 'UNHEALTHY_SCAN_RESPONSE'");
  expect(scanner).toContain('api.scan(selected, market');
  expect(scanner).toContain('조건에 맞는 종목이 없습니다. (조회는 정상 — 오류 아님)');

  const scanGate = authFetch.indexOf("path === '/api/market/scan' && method === 'GET'");
  const responseReturn = authFetch.lastIndexOf('return response;');
  expect(scanGate).toBeGreaterThanOrEqual(0);
  expect(responseReturn).toBeGreaterThan(scanGate);
});
