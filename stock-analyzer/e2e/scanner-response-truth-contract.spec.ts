import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.tsx', import.meta.url));
const guardPath = fileURLToPath(new URL('../src/lib/scanner-response-guard.ts', import.meta.url));
const scannerPath = fileURLToPath(new URL('../src/pages/scanner.tsx', import.meta.url));

test('scanner success truth is validated against the canonical backend contract before render', async () => {
  const [main, guard, scanner] = await Promise.all([
    readFile(mainPath, 'utf8'),
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
  expect(main).toContain('installScannerResponseGuard();');
  expect(scanner).toContain('조건에 맞는 종목이 없습니다. (조회는 정상 — 오류 아님)');

  const install = main.indexOf('installScannerResponseGuard();');
  const render = main.indexOf("createRoot(document.getElementById('root')!)");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(render).toBeGreaterThan(install);
});
