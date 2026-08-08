import { test, expect, type Page } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  UNIFIED_SEARCH_ROUTE_CONTRACT,
  navigationGroupMatches,
} from '../src/lib/app-navigation';

const NAVIGATION_FIXTURE_PATH = '/__phase11-ai-chat-e2e';

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

function menuByGroup(groupId: 'assets' | 'technical' | 'information') {
  const group = APP_NAVIGATION.find((item) => item.id === groupId);
  if (!group?.menu) throw new Error(`navigation menu not found: ${groupId}`);
  return group.menu;
}

test('navigation metadata keeps five top-level sections and assigns each core feature once', () => {
  expect(APP_NAVIGATION.map((item) => item.id)).toEqual([
    'home',
    'assets',
    'technical',
    'information',
    'settings',
  ]);

  const assetsMenu = menuByGroup('assets');
  const technicalMenu = menuByGroup('technical');
  const informationMenu = menuByGroup('information');

  expect(assetsMenu.map((item) => item.href)).toEqual(expect.arrayContaining([
    APP_ROUTES.assets,
    APP_ROUTES.stocksKr,
    APP_ROUTES.stocksUs,
    APP_ROUTES.coinsSpot,
    APP_ROUTES.coinsFutures,
    APP_ROUTES.unifiedMarketRankings,
    APP_ROUTES.recommendations,
    APP_ROUTES.themes,
    APP_ROUTES.watchlist,
    APP_ROUTES.alerts,
  ]));
  expect(technicalMenu.map((item) => item.href)).toEqual([
    APP_ROUTES.scanner,
    APP_ROUTES.aiChart,
    APP_ROUTES.autoTrading,
    APP_ROUTES.backtests,
    APP_ROUTES.paperTrading,
  ]);
  expect(informationMenu.map((item) => item.href)).toEqual([
    APP_ROUTES.marketOverview,
    APP_ROUTES.learn,
    APP_ROUTES.aiChat,
    APP_ROUTES.portfolio,
  ]);

  const allMenuIds = APP_NAVIGATION.flatMap((item) => item.menu?.map((child) => child.id) ?? []);
  expect(new Set(allMenuIds).size).toBe(allMenuIds.length);

  expect(assetsMenu.find((item) => item.id === 'stocks-kr')).toMatchObject({
    href: '/stocks/kr',
    capability: 'canAccessBasicInfo',
  });
  expect(assetsMenu.find((item) => item.id === 'stocks-us')).toMatchObject({
    href: '/stocks/us',
    capability: 'canAccessBasicInfo',
  });
  expect(assetsMenu.find((item) => item.id === 'coins-spot')).toMatchObject({
    href: '/coins/spot',
    capability: 'canAccessSpot',
  });
  expect(assetsMenu.find((item) => item.id === 'coins-futures')).toMatchObject({
    href: '/coins/futures',
    capability: 'canAccessFutures',
  });
  expect(technicalMenu.find((item) => item.id === 'auto-trading')).toMatchObject({
    href: '/auto-trading',
    capability: 'canAccessRiskPreview',
  });

  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.primaryEntry).toBe('/stocks');
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.searchAlias).toBe('/search');
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.marketRankingsAfterIntegration).toBe('/market-rankings');
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/stock/005930?back=%2Fstocks')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/stock-info?asset=coin')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/stocks/kr')).toBe(true);
  expect(navigationGroupMatches(APP_NAVIGATION[1], '/coins/futures')).toBe(true);
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
    await page.goto(NAVIGATION_FIXTURE_PATH);

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

test('keyboard navigation autofocuses, cycles through, and closes the asset menu', async ({ page }) => {
  const assertCleanRuntime = observeNavigationRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNavigationRuntime(page);
  await page.goto(NAVIGATION_FIXTURE_PATH);

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  const assetsTrigger = navigation.getByRole('button', { name: '종목', exact: true });
  await assetsTrigger.focus();
  await assetsTrigger.press('ArrowDown');

  const menu = page.getByRole('menu', { name: '종목 메뉴' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  const itemCount = await items.count();
  expect(itemCount).toBeGreaterThan(0);
  await expect(items.nth(0)).toBeFocused();
  if (itemCount > 1) {
    await items.nth(0).press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
  }
  await items.nth(Math.min(1, itemCount - 1)).press('End');
  await expect(items.nth(itemCount - 1)).toBeFocused();
  await items.nth(itemCount - 1).press('Tab');
  await expect(items.nth(0)).toBeFocused();
  await items.nth(0).press('Shift+Tab');
  await expect(items.nth(itemCount - 1)).toBeFocused();
  await items.nth(itemCount - 1).press('Escape');
  await expect(menu).toBeHidden();
  await expect(assetsTrigger).toBeFocused();
  assertCleanRuntime();
});

test('pointer opening autofocuses and outside click restores the trigger focus', async ({ page }) => {
  const assertCleanRuntime = observeNavigationRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNavigationRuntime(page);
  await page.goto(NAVIGATION_FIXTURE_PATH);

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  const assetsTrigger = navigation.getByRole('button', { name: '종목', exact: true });
  await assetsTrigger.click();

  const menu = page.getByRole('menu', { name: '종목 메뉴' });
  const firstItem = menu.getByRole('menuitem').first();
  await expect(firstItem).toBeFocused();
  await page.locator('main').click({ position: { x: 8, y: 8 } });
  await expect(menu).toBeHidden();
  await expect(assetsTrigger).toBeFocused();
  assertCleanRuntime();
});

test('asset menu reaches the integrated unified search entry', async ({ page }) => {
  const assertCleanRuntime = observeNavigationRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await mockNavigationRuntime(page);
  await page.goto(NAVIGATION_FIXTURE_PATH);

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await navigation.getByRole('button', { name: '종목', exact: true }).click();
  await page.getByRole('menuitem', { name: '통합 종목검색', exact: true }).click();
  await expect(page).toHaveURL(/\/stocks$/);
  assertCleanRuntime();
});
