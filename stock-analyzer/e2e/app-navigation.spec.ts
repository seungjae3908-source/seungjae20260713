import { test, expect, type Page } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  UNIFIED_SEARCH_ROUTE_CONTRACT,
  navigationGroupMatches,
} from '../src/lib/app-navigation';

async function mockNavigationRuntime(page: Page) {
  await page.route('**/api/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      items: [],
      rows: [],
      results: [],
      quotes: [],
      cards: [],
      tickers: [],
      markets: [],
    }),
  }));
}

function observeNavigationRuntime(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  const orderRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) unexpectedHttpErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const method = request.method();
    if (
      method !== 'GET' &&
      /\/api\/.*(?:order|trade|approve|execute)/i.test(request.url())
    ) {
      orderRequests.push(`${method} ${request.url()}`);
    }
  });

  return () => {
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(unexpectedHttpErrors).toEqual([]);
    expect(orderRequests).toEqual([]);
  };
}

test('navigation metadata keeps five top-level sections and active routes', () => {
  expect(APP_NAVIGATION.map((item) => item.id)).toEqual([
    'home',
    'assets',
    'technical',
    'information',
    'settings',
  ]);
  const menuHrefs = APP_NAVIGATION.flatMap((item) => item.menu?.map((child) => child.href) ?? []);
  expect(menuHrefs).toEqual(expect.arrayContaining([
    APP_ROUTES.assets,
    APP_ROUTES.legacyMarketRankings,
    APP_ROUTES.themes,
    APP_ROUTES.watchlist,
    APP_ROUTES.alerts,
    APP_ROUTES.scanner,
    APP_ROUTES.aiChart,
    APP_ROUTES.autoTrading,
    APP_ROUTES.marketOverview,
    APP_ROUTES.learn,
    APP_ROUTES.aiChat,
    APP_ROUTES.portfolio,
  ]));
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.primaryEntry).toBe('/stocks');
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.marketRankingsAfterIntegration).toBe('/market-rankings');
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/stock/005930?back=%2Fstocks')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/stock-info?asset=coin')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[2], '/scanner')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[2], '/auto-trading')).toBe(true);
});

for (const viewport of [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1440, height: 900 },
] as const) {
  test(`${viewport.name} navigation exposes five accessible top-level controls`, async ({ page }) => {
    const assertCleanRuntime = observeNavigationRuntime(page);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await mockNavigationRuntime(page);
    await page.goto('/__phase11-technical-workspace-e2e');

    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole('button')).toHaveCount(5);

    for (const label of ['홈', '종목', '기술', '정보', '설정']) {
      const button = navigation.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    assertCleanRuntime();
  });
}

test('keyboard navigation opens, moves through, and closes the asset menu', async ({ page }) => {
  const assertCleanRuntime = observeNavigationRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNavigationRuntime(page);
  await page.goto('/__phase11-technical-workspace-e2e');

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  const assetsTrigger = navigation.getByRole('button', { name: '종목', exact: true });
  await assetsTrigger.focus();
  await assetsTrigger.press('ArrowDown');

  const menu = page.getByRole('menu', { name: '종목 메뉴' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items).toHaveCount(5);
  await expect(items.nth(0)).toBeFocused();
  await items.nth(0).press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await items.nth(1).press('End');
  await expect(items.nth(4)).toBeFocused();
  await items.nth(4).press('Escape');
  await expect(menu).toBeHidden();
  await expect(assetsTrigger).toBeFocused();
  assertCleanRuntime();
});

test('asset menu reaches the existing search entry without redefining search routes', async ({ page }) => {
  const assertCleanRuntime = observeNavigationRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNavigationRuntime(page);
  await page.goto('/__phase11-technical-workspace-e2e');

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await navigation.getByRole('button', { name: '종목', exact: true }).click();
  await page.getByRole('menuitem', { name: '종목 검색·탐색', exact: true }).click();
  await expect(page).toHaveURL(/\/stocks$/);
  assertCleanRuntime();
});
