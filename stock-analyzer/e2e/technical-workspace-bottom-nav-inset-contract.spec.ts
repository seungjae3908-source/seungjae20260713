import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/pages/technical-workspace.tsx'),
  'utf8',
);

const legacyBottomNavInset = 'pb-[calc(5rem+env(safe-area-inset-bottom))]';

test('Technical workspace lets the flex body consume the viewport above BottomNav', () => {
  expect(source).toContain('data-testid="technical-workspace"');
  expect(source).toContain('flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background');
  expect(source).toContain('className="min-h-0 min-w-0 flex-1 overflow-hidden"');
  expect(source).not.toContain(legacyBottomNavInset);
  expect(source).toContain('<BottomNav />');
});

test('Embedded scanner and AI chart remain inside the flex workspace viewport', () => {
  expect(source).toContain('<SignalScannerPage embedded={desktop} />');
  expect(source).toContain('<AiChartPage embedded />');
});
