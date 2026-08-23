import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const pageSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/paper-trading.tsx'),
  'utf8',
);

test('Paper Trading gives BottomNav its own flex row instead of overlaying controls', () => {
  expect(pageSource).toContain('data-testid="paper-trading-shell"');
  expect(pageSource).toContain('className="flex h-full min-h-0 flex-col overflow-hidden"');
  expect(pageSource).toContain('data-testid="paper-trading-content"');
  expect(pageSource).toContain('className="relative min-h-0 flex-1 overflow-hidden"');
  expect(pageSource).toContain('<BottomNav />');
  expect(pageSource).not.toContain('pb-[calc(5rem+env(safe-area-inset-bottom))]');
});

test('Paper journal overlay is bounded by the content row above BottomNav', () => {
  expect(pageSource).toContain('className="absolute inset-0 z-40 overflow-y-auto overscroll-contain bg-background pb-6"');
  expect(pageSource).not.toContain('bottom-[calc(5rem+env(safe-area-inset-bottom))]');
});
