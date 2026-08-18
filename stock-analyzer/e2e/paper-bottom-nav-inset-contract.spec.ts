import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const pageSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/paper-trading.tsx'),
  'utf8',
);

const bottomNavInset = 'calc(5rem+env(safe-area-inset-bottom))';

test('Paper Trading reserves a real viewport inset above the fixed BottomNav', () => {
  expect(pageSource).toContain('data-testid="paper-trading-shell"');
  expect(pageSource).toContain(`pb-[${bottomNavInset}]`);
  expect(pageSource).toContain('<BottomNav />');
});

test('Paper journal overlay terminates above the same BottomNav inset', () => {
  expect(pageSource).toContain(`bottom-[${bottomNavInset}]`);
  expect(pageSource).not.toContain('absolute inset-0 z-40 overflow-y-auto overscroll-contain bg-background pb-28');
});
