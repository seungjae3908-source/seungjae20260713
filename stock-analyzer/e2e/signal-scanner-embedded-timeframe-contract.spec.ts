import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..', '..');
const scannerPageSource = fs.readFileSync(
  path.join(repoRoot, 'stock-analyzer/src/pages/signal-scanner.tsx'),
  'utf8',
);
const serverStrategySource = fs.readFileSync(
  path.join(repoRoot, 'api-server/src/services/scanner-quant-strategy.service.ts'),
  'utf8',
);

test('embedded Scanner swing timeframe stays inside the canonical server contract', () => {
  expect(scannerPageSource).toContain("swing: ['60m', '4H']");
  expect(scannerPageSource).not.toContain("swing: ['4H', '1D']");
  expect(scannerPageSource).toContain("if (strategy === 'swing') return '4H';");
  expect(scannerPageSource).not.toContain("return strategy === 'scalping' ? '5m' : '1D';");

  expect(serverStrategySource).toContain("if (timeframe === '1D') return 'position';");
  expect(serverStrategySource).toContain("if (mode === 'position') return ['4H', '1D'].includes(timeframe);");
  expect(serverStrategySource).toContain("return ['60m', '4H'].includes(timeframe);");
});
