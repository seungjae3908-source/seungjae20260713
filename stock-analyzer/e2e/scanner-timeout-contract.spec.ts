import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../src/lib/auth-fetch.ts', import.meta.url));
const scannerRoutePath = fileURLToPath(new URL('../../api-server/src/routes/bounded-market-scan.ts', import.meta.url));
const supabasePath = fileURLToPath(new URL('../../api-server/src/lib/supabase.ts', import.meta.url));

function numericConstant(source: string, pattern: RegExp, name: string): number {
  const match = source.match(pattern);
  if (!match) throw new Error(`missing numeric constant ${name}`);
  return Number(match[1].replaceAll('_', ''));
}

test('stock scanner client timeout covers authentication plus the server scan budget', async () => {
  const [clientSource, scannerSource, supabaseSource] = await Promise.all([
    readFile(clientPath, 'utf8'),
    readFile(scannerRoutePath, 'utf8'),
    readFile(supabasePath, 'utf8'),
  ]);

  const clientTimeout = numericConstant(clientSource, /const STOCK_SCANNER_REQUEST_TIMEOUT_MS = ([0-9_]+);/, 'STOCK_SCANNER_REQUEST_TIMEOUT_MS');
  const scanDeadline = numericConstant(scannerSource, /STOCK_SCANNER_ROUTE_DEADLINE_MS = ([0-9_]+);/, 'STOCK_SCANNER_ROUTE_DEADLINE_MS');
  const supabaseAttempt = numericConstant(supabaseSource, /const SUPABASE_READ_ATTEMPT_TIMEOUT_MS = ([0-9_]+);/, 'SUPABASE_READ_ATTEMPT_TIMEOUT_MS');

  // Authentication may use two bounded Supabase read attempts before the scan
  // deadline starts; keep at least 2s for result shaping on top of both.
  expect(scanDeadline).toBe(8_000);
  expect(clientTimeout).toBeGreaterThanOrEqual(2 * supabaseAttempt + scanDeadline + 2_000);
  expect(clientSource).toContain("method === 'GET' && requestPath(input) === '/api/market/scan'");
});
