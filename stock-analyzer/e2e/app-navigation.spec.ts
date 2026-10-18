import { test, expect, type Page, type Route } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  MOBILE_NAVIGATION,
  SIDEBAR_NAVIGATION,
  UNIFIED_SEARCH_ROUTE_CONTRACT,
  navigationGroupMatches,
} from '../src/lib/app-navigation';

const NOW = '2026-08-08T09:30:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

const REMOVED_ROUTES = [
  '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures', '/market-overview',
  '/market-rankings', '/market-browser', '/themes', '/news-information', '/learn', '/recommendations',
] as const;

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installApprovedRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-navigation-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'navigation@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '내비게이션 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  const diagnostics = {
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    unexpectedHttp: [] as string[],
    forbiddenRequests: [] as string[],
  };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) diagnostics.unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/api\/(?:accounts?|balances?|positions?|orders?|cancel)(?:\/|$)/i.test(path)) {
      diagnostics.forbiddenRequests.push(`${request.method()} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'navigation-admin',
        display_name: '내비게이션 검증 관리자',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'navigation@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '내비게이션 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/trade-automation/status') {
      return fulfill(route, {
        policy: {
          mode: 'approval', automaticEnabled: false, emergencyStopped: false,
          exchangeEnabled: { bitget: false, upbit: false, kiwoom: false },
          enabledAssets: { bitget: [], upbit: [], kiwoom: [] }, enabledStrategies: [],
          totalCapitalKrw: 1000000, maxOrderKrw: 100000, dailyLossLimitPercent: 5,
          maxAssetPercent: 30, maxOpenPositions: 5, maxDailyOrders: 10,
          maxConsecutiveLosses: 3, bitgetLeverage: 2,
        },
        connections: [], emergencyStopped: false,
        credentialVault: { encryptionConfigured: false, keyValueExposed: false }, lastOrder: null,
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [], quotes: [], cards: [], alerts: [], markets: [], tickers: [] });
  });

  return () => {
    expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
    expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
    expect(diagnostics.unexpectedHttp, diagnostics.unexpectedHttp.join('\n')).toEqual([]);
    expect(diagnostics.forbiddenRequests, diagnostics.forbiddenRequests.join('\n')).toEqual([]);
  };
}

function group(id: 'assets' | 'technical' | 'information' | 'settings') {
  const found = APP_NAVIGATION.find((item) => item.id === id);
  if (!found) throw new Error(`missing navigation group: ${id}`);
  return found;
}

test('navigation metadata has five owners, actual final-main routes, and no duplicate menu hrefs', () => {
  expect(APP_NAVIGATION.map((item) => item.id)).toEqual(['home', 'assets', 'technical', 'information', 'settings']);
  const menuItems = APP_NAVIGATION.flatMap((item) => item.menu ?? []);
  expect(new Set(menuItems.map((item) => item.href)).size).toBe(menuItems.length);
  expect(menuItems.map((item) => item.href)).toEqual(expect.arrayContaining([
    APP_ROUTES.assets,
    APP_ROUTES.watchlist,
    APP_ROUTES.alerts,
    APP_ROUTES.scanner,
    APP_ROUTES.aiChart,
    APP_ROUTES.autoTrading,
    APP_ROUTES.aiChat,
    APP_ROUTES.researchCenter,
  ]));
  expect(menuItems.map((item) => item.href)).not.toContain(APP_ROUTES.unifiedSearchAlias);
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT).toEqual({ primaryEntry: '/stocks', searchAlias: '/search' });
  expect(navigationGroupMatches(group('assets'), '/watchlist')).toBe(true);
  expect(group('assets').menu?.map((item) => item.label)).toEqual(['통합검색', '관심종목', '가격 알림']);
  expect(group('information').menu?.map((item) => item.label)).toEqual(['AI 정보', '연구센터', '포트폴리오']);
  const allHrefs = [
    ...menuItems.map((item) => item.href),
    ...MOBILE_NAVIGATION.flatMap((item) => [item.href, ...(item.menu ?? []).map((menu) => menu.href)]),
    ...APP_NAVIGATION.map((item) => item.href),
  ];
  for (const removed of REMOVED_ROUTES) {
    expect(allHrefs, removed).not.toContain(removed);
    expect(Object.values(APP_ROUTES), removed).not.toContain(removed);
    for (const owner of APP_NAVIGATION) expect(navigationGroupMatches(owner, removed), `${owner.id} ${removed}`).toBe(false);
  }
  expect(navigationGroupMatches(group('technical'), '/auto-trading')).toBe(true);

  // Mobile tab bar: 자동매매 is a first-class tab; every sidebar destination stays reachable.
  expect(MOBILE_NAVIGATION.map((item) => item.label)).toEqual(['홈', '종목', '검색기', '자동매매', '자산']);
  expect(MOBILE_NAVIGATION.find((item) => item.id === 'auto-trading')?.href).toBe(APP_ROUTES.autoTrading);
  const mobileHrefs = new Set(MOBILE_NAVIGATION.flatMap((item) => [item.href, ...(item.menu ?? []).map((menu) => menu.href)]));
  for (const section of SIDEBAR_NAVIGATION) {
    for (const item of section.items) expect(mobileHrefs.has(item.href), item.href).toBe(true);
  }
  expect(SIDEBAR_NAVIGATION.map((section) => section.label)).toEqual(['홈', '종목', '기술', '정보', '설정']);
});

test('desktop sidebar owns the primary navigation at 1440px and the mobile tab bar is hidden', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/stocks');
  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation).toHaveCount(1);
  await expect(navigation).toHaveAttribute('data-testid', 'desktop-sidebar');
  await expect(navigation).toHaveAttribute('data-route-title', '통합검색');
  for (const label of ['홈', '통합검색', '관심종목', '가격 알림', '검색기', '과거검증', '기술매매', '연구센터', '포트폴리오', 'AI 정보', '앱 설정']) {
    await expect(navigation.getByRole('menuitem', { name: label, exact: true })).toBeVisible();
  }
  for (const removedLabel of ['국내주식', '미국주식', '코인현물', '코인선물', '지수·시황', '시장 순위', '시장 탐색', 'AI 추천', '테마', '투자 공부']) {
    await expect(navigation.getByRole('menuitem', { name: removedLabel, exact: true })).toHaveCount(0);
  }
  await expect(navigation.getByRole('menuitem', { name: '통합검색', exact: true })).toHaveAttribute('aria-current', 'page');
  // Section headings are buttons that move focus into their always-visible menu.
  await navigation.getByRole('button', { name: '기술', exact: true }).click();
  const technicalMenu = page.getByRole('menu', { name: '기술 메뉴' });
  await expect(technicalMenu).toBeVisible();
  await expect(technicalMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(technicalMenu.getByRole('menuitem').nth(1)).toBeFocused();
  const box = await navigation.boundingBox();
  expect(Math.round(box?.width ?? 0)).toBe(216);
  await expect(page.locator('nav[aria-label="주요 메뉴"]')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  assertClean();
});

for (const width of [360, 390, 430, 1023, 1024]) {
  test(`five top-level controls and anchored menus avoid overflow at ${width}px`, async ({ page }) => {
    const assertClean = await installApprovedRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.goto('/stocks');
    await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();

    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await expect(navigation.getByRole('button')).toHaveCount(5);
    for (const label of ['홈', '종목', '검색기', '자동매매', '자산']) {
      const button = navigation.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0, `${width}px ${label}`).toBeGreaterThanOrEqual(44);
    }

    await navigation.getByRole('button', { name: '종목', exact: true }).click();
    const menu = page.getByRole('menu', { name: '종목 메뉴' });
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    const triggerBox = await navigation.getByRole('button', { name: '종목', exact: true }).boundingBox();
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual((triggerBox?.y ?? 0) + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    assertClean();
  });
}

test('keyboard, focus, Escape, Enter and Space operate anchored popovers', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/stocks');
  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  const assetsTrigger = navigation.getByRole('button', { name: '종목', exact: true });

  await assetsTrigger.focus();
  await assetsTrigger.press('ArrowDown');
  const assetsMenu = page.getByRole('menu', { name: '종목 메뉴' });
  await expect(assetsMenu).toBeVisible();
  const items = assetsMenu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await items.first().press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await items.nth(1).press('End');
  await expect(items.last()).toBeFocused();
  await items.last().press('Escape');
  await expect(assetsMenu).toBeHidden();
  await expect(assetsTrigger).toBeFocused();

  await assetsTrigger.press('Enter');
  await expect(assetsMenu).toBeVisible();
  await assetsTrigger.press('Space');
  await expect(assetsMenu).toBeHidden();

  // Enter toggles an already-open menu without a keyboard-focus race.
  await assetsTrigger.press('Enter');
  await expect(assetsMenu).toBeVisible();
  await assetsTrigger.press('Enter');
  await expect(assetsMenu).toBeHidden();
  assertClean();
});

test('removed screen URLs redirect to home instead of 404 and the asset menu lists only kept screens', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 430, height: 932 });
  for (const route of REMOVED_ROUTES) {
    await page.goto(route, { waitUntil: 'commit' });
    await expect(page, route).toHaveURL(/\/$/u);
    await expect(page.getByRole('heading', { name: '홈', level: 1 })).toBeVisible();
    await expect(page.getByText('페이지를 찾을 수 없습니다')).toHaveCount(0);
  }

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await navigation.getByRole('button', { name: '종목', exact: true }).click();
  const menu = page.getByRole('menu', { name: '종목 메뉴' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveText(['통합검색', '관심종목', '가격 알림']);
  await menu.getByRole('menuitem', { name: '가격 알림', exact: true }).click();
  await expect(page).toHaveURL(/\/alerts$/u);
  await expect(page.getByRole('menu', { name: '종목 메뉴' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toHaveAttribute('data-route-title', '가격 알림');
  assertClean();
});

test('desktop sidebar reaches scanner, AI chart, and auto-trading routes without information-route confusion', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/stocks');

  const cases = [
    ['검색기', '/scanner', /AI 신호검색기/],
    ['AI차트', '/ai-chart', /AI 차트 생중계/],
    ['기술매매', '/auto-trading', /자동매매/],
  ] as const;

  for (const [label, route, heading] of cases) {
    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await navigation.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('menuitem', { name: label, exact: true })).toHaveAttribute('aria-current', 'page');
    await page.goto('/stocks');
  }
  assertClean();
});

test('mobile tab bar exposes 자동매매 directly and the scanner menu reaches AI chart', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/stocks');
  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await navigation.getByRole('button', { name: '자동매매', exact: true }).click();
  await expect(page).toHaveURL(/\/auto-trading$/u);
  await expect(page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '자동매매', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('navigation', { name: '주요 메뉴' }).getByRole('button', { name: '검색기', exact: true }).click();
  const menu = page.getByRole('menu', { name: '검색기 메뉴' });
  await menu.getByRole('menuitem', { name: 'AI차트', exact: true }).click();
  await expect(page).toHaveURL(/\/ai-chart$/u);
  assertClean();
});

test('direct URL, reload, back/forward, active state, breadcrumb metadata, and visibility return stay stable', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/stocks');
  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
  await page.goto('/alerts');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '알림', level: 1 })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation.getByRole('button', { name: '종목', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation).toHaveAttribute('data-breadcrumb', '종목 / 가격 알림');
  await expect(page.getByRole('list', { name: '현재 위치' })).toContainText('가격 알림');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: '알림', level: 1 })).toBeVisible();
  assertClean();
});
