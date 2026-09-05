import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const serverPath = fileURLToPath(new URL('../../api-server/src/routes/market-information.ts', import.meta.url));

function numericConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`const ${name} = ([0-9_]+);`));
  if (!match) throw new Error(`missing numeric constant ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

test('Market Information client timeout cannot preempt the server first-paint fallback', async () => {
  const [clientSource, serverSource] = await Promise.all([
    readFile(clientPath, 'utf8'),
    readFile(serverPath, 'utf8'),
  ]);

  const clientTimeout = numericConstant(clientSource, 'MARKET_INFORMATION_REQUEST_TIMEOUT_MS');
  const serverFirstPaintTimeout = numericConstant(serverSource, 'DEFAULT_STOCK_FIRST_PAINT_TIMEOUT_MS');

  expect(serverFirstPaintTimeout).toBe(4_000);
  expect(clientTimeout).toBe(6_000);
  expect(clientTimeout).toBeGreaterThan(serverFirstPaintTimeout);
  expect(clientSource).toContain("requestPath(input).startsWith('/api/market-information/')");
  expect(clientSource).toContain("errorCode: 'MARKET_INFORMATION_TIMEOUT'");
  expect(clientSource).not.toContain('MARKET_INFORMATION_REQUEST_TIMEOUT_MS = 2_500');

  expect(serverSource).toContain('new MarketInformationFirstPaintTimeoutError(stockFirstPaintTimeoutMs)');
  expect(serverSource).toContain('return res.status(200).json(stockFirstPaintFallback(room));');
});
