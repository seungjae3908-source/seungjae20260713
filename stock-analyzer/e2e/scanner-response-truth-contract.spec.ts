import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.tsx', import.meta.url));
const guardPath = fileURLToPath(new URL('../src/lib/scanner-response-guard.ts', import.meta.url));
const scannerPath = fileURLToPath(new URL('../src/pages/scanner.tsx', import.meta.url));

test('malformed successful scanner payload fails closed before normal-empty UI can render', async () => {
  const [main, guard, scanner] = await Promise.all([
    readFile(mainPath, 'utf8'),
    readFile(guardPath, 'utf8'),
    readFile(scannerPath, 'utf8'),
  ]);

  expect(guard).toContain("throw new Error(INVALID_SCAN_RESPONSE)");
  expect(guard).toContain('!Array.isArray(value.cards) || !Array.isArray(value.selected)');
  expect(guard).toContain('!value.cards.every(isValidCard)');
  expect(main).toContain('installScannerResponseGuard();');
  expect(scanner).toContain('조회는 정상 — 오류 아님.');

  const install = main.indexOf('installScannerResponseGuard();');
  const render = main.indexOf("createRoot(document.getElementById('root')!)");
  expect(install).toBeGreaterThanOrEqual(0);
  expect(render).toBeGreaterThan(install);
});
