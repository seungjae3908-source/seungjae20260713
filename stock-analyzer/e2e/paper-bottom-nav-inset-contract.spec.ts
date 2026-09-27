import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const paperSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/paper-trading.tsx'),
  'utf8',
);
const tradingSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/auto-trading.tsx'),
  'utf8',
);

test('Paper Trading delegates to the unified shell and preserves a real BottomNav safe-area inset', () => {
  expect(paperSource).toContain('<AutoTradingPage initialMode="paper" />');
  expect(tradingSource).toContain("initialMode === 'paper' ? 'paper-trading-shell' : 'auto-trading-page'");
  expect(tradingSource).toContain('pb-[calc(6rem+env(safe-area-inset-bottom))]');
  expect(tradingSource).toContain('<BottomNav />');
});

test('embedded trading workspace does not reserve the standalone BottomNav inset', () => {
  expect(tradingSource).toContain("embedded");
  expect(tradingSource).toContain("'min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4'");
  expect(tradingSource).not.toContain('journal-sync-overlay');
});
