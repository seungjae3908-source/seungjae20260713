import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/technical-workspace.tsx'),
  'utf8',
);

const bottomNavInset = 'pb-[calc(5rem+env(safe-area-inset-bottom))]';

test('Technical workspace reserves viewport space above the fixed BottomNav', () => {
  expect(source).toContain('data-testid="technical-workspace"');
  expect(source).toContain(bottomNavInset);
  expect(source).toContain('<BottomNav />');
});

test('Embedded scanner and AI chart remain inside the inset workspace viewport', () => {
  expect(source).toContain('<SignalScannerPage embedded={desktop} />');
  expect(source).toContain('<AiChartPage embedded />');
});
