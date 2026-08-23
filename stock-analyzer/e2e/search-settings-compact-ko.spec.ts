import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

test('search and settings primary surfaces are short and Korean-first', () => {
  const search = source('src/pages/unified-asset-search.tsx');
  const settings = source('src/pages/more.tsx');

  expect(search).toContain('<CenteredPageHeader title="종목" />');
  expect(search).toContain('grid grid-cols-3 gap-2');
  expect(search).toContain('sm:grid-cols-5');
  expect(search).toContain('시장 순위');
  expect(search).not.toContain('infoItems={[');
  expect(search).not.toContain('overflow-x-auto');

  expect(settings).toContain("{ id: 'risk', title: '위험관리'");
  expect(settings).toContain("{ id: 'scanner', title: '검색기'");
  expect(settings).toContain("{ id: 'telegram', title: '텔레그램'");
  expect(settings).toContain("{ id: 'provider', title: '데이터 연결'");
  expect(settings).toContain('data-testid="settings-compact-grid"');
  expect(settings).toContain('grid-cols-2');
  expect(settings).toContain('lg:grid-cols-3');
  expect(settings).not.toContain("title: 'Risk'");
  expect(settings).not.toContain("title: 'Scanner'");
  expect(settings).not.toContain("title: 'Telegram'");
  expect(settings).not.toContain("title: 'Provider'");
  expect(settings).not.toContain('infoItems={[');
  expect(settings).not.toContain('source of truth');
  expect(settings).not.toContain('PARTIAL/DEGRADED/STALE');
});

for (const width of [360, 390, 412, 430]) {
  test(`unified search ${width}px keeps all market filters visible without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/__phase11-unified-search-e2e');

    const tabs = page.getByTestId('unified-market-tabs');
    await expect(tabs).toBeVisible();
    for (const label of ['전체', '국내', '미국', '코인 현물', '코인 선물']) {
      await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible();
    }

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('unified search desktop keeps a single row of market filters', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/__phase11-unified-search-e2e');

  const tabs = page.getByTestId('unified-market-tabs');
  await expect(tabs).toBeVisible();
  const boxes = await tabs.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  expect(new Set(boxes.map((value) => Math.round(value))).size).toBe(1);
});
