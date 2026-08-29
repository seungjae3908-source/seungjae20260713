import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('shared structural layouts use the 1200px desktop contract', async () => {
  const [home, technical, tabs, autoTrading] = await Promise.all([
    source('src/pages/home.tsx'),
    source('src/pages/technical-workspace.tsx'),
    source('src/components/responsive-tabs.tsx'),
    source('src/pages/auto-trading.tsx'),
  ]);

  expect(home).toContain('ADAPTIVE_VIEWPORT_BREAKPOINTS.desktopMin');
  expect(technical).toContain('ADAPTIVE_VIEWPORT_BREAKPOINTS.desktopMin');
  expect(tabs).toContain('min-[1200px]:grid');
  expect(tabs).not.toContain('lg:grid lg:overflow-visible');
  expect(autoTrading).toContain('min-[1200px]:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]');
  expect(autoTrading).not.toContain('lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]');
});

test('alert filters preserve the app-wide 44px touch target contract', async () => {
  const alerts = await source('src/pages/alerts.tsx');

  expect(alerts).toContain("compact ? 'flex min-h-11 gap-0.5 px-1 text-[11px]' : 'flex min-h-11 gap-1 px-2 text-xs sm:text-sm'");
  expect(alerts).not.toContain('min-h-10');
});
