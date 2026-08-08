import { test, expect, type Page, type Route } from '@playwright/test';
import {
  APP_NAVIGATION,
  APP_ROUTES,
  UNIFIED_SEARCH_ROUTE_CONTRACT,
  navigationGroupMatches,
} from '../src/lib/app-navigation';

const NOW = '2026-08-08T09:30:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

type RoomId = 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function roomConfig(room: RoomId) {
  if (room === 'stocks-kr') return { market: 'KR', assetType: 'stock', currency: 'KRW', provider: 'KRX', title: '국내주식 정보' } as const;
  if (room === 'stocks-us') return { market: 'US', assetType: 'stock', currency: 'USD', provider: 'US', title: '미국주식 정보' } as const;
  if (room === 'coins-spot') return { market: 'spot', assetType: 'coin-spot', currency: 'KRW', provider: 'UPBIT', title: '코인 현물 정보' } as const;
  return { market: 'futures', assetType: 'coin-futures', currency: 'USDT', provider: 'BITGET', title: '코인 선물 정보' } as const;
}

function roomResponse(room: RoomId) {
  const config = roomConfig(room);
  const meta = {
    provider: config.provider,
    source: `${config.provider} fixture`,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: config.market === 'KR' ? 'Asia/Seoul' : config.market === 'US' ? 'America/New_York' : 'UTC',
    marketStatus: config.assetType === 'stock' ? 'CLOSED' : '24H',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
  const emptyArray = { status: 'empty', data: [], meta, message: '검증용 빈 데이터' };
  return {
    ok: true,
    room,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    fetchedAt: NOW,
    partial: false,
    sections: {
      indices: emptyArray,
      rankings: emptyArray,
      sectors: emptyArray,
      news: emptyArray,
      disclosures: emptyArray,
      derivatives: {
        status: 'empty',
        data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] },
        meta,
        message: '검증용 빈 데이터',
      },
    },
    requestPolicy: {
      publicMarketDataOnly: true,
      privateExchangeRequests: 0,
      accountRequests: 0,
      balanceRequests: 0,
      positionRequests: 0,
      orderRequests: 0,
      cancelRequests: 0,
      aiRequests: 0,
    },
  };
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
    const room = path.match(/^\/api\/market-information\/(stocks-kr|stocks-us|coins-spot|coins-futures)$/)?.[1] as RoomId | undefined;
    if (room) return fulfill(route, roomResponse(room));
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
    APP_ROUTES.stocksKr,
    APP_ROUTES.stocksUs,
    APP_ROUTES.coinsSpot,
    APP_ROUTES.coinsFutures,
    APP_ROUTES.marketOverview,
    APP_ROUTES.scanner,
    APP_ROUTES.aiChart,
    APP_ROUTES.autoTrading,
  ]));
  expect(menuItems.map((item) => item.href)).not.toContain(APP_ROUTES.unifiedSearchAlias);
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.primaryEntry).toBe('/stocks');
  expect(UNIFIED_SEARCH_ROUTE_CONTRACT.marketRankings).toBe('/market-rankings');
  expect(navigationGroupMatches(group('assets'), '/coins/spot')).toBe(true);
  expect(navigationGroupMatches(group('technical'), '/auto-trading')).toBe(true);
});

for (const width of [360, 390, 430, 1023, 1024, 1440]) {
  test(`five top-level controls and anchored menus avoid overflow at ${width}px`, async ({ page }) => {
    const assertClean = await installApprovedRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.goto('/stocks/kr');
    await expect(page.getByRole('heading', { name: '국내주식 정보' })).toBeVisible();

    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await expect(navigation.getByRole('button')).toHaveCount(5);
    for (const label of ['홈', '종목', '기술', '정보', '설정']) {
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
  await page.goto('/stocks/kr');
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
  assertClean();
});

test('market submenu buttons reach the correct KR, US, spot, and futures screens and close immediately', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto('/stocks/kr');

  const cases = [
    ['국내주식', '/stocks/kr', '국내주식 정보'],
    ['미국주식', '/stocks/us', '미국주식 정보'],
    ['코인 현물', '/coins/spot', '코인 현물 정보'],
    ['코인 선물', '/coins/futures', '코인 선물 정보'],
  ] as const;

  for (const [label, route, heading] of cases) {
    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await navigation.getByRole('button', { name: '종목', exact: true }).click();
    const menu = page.getByRole('menu', { name: '종목 메뉴' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.getByRole('menu', { name: '종목 메뉴' })).toBeHidden();
    await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toHaveAttribute('data-route-title', heading);
    await expect(page).toHaveTitle(new RegExp(heading));
  }

  await expect(page.getByText('선물 공개 파생지표')).toBeVisible();
  assertClean();
});

test('technical menu reaches scanner, AI chart, and approval-order routes without information-route confusion', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/stocks/kr');

  const cases = [
    ['AI 신호검색기', '/scanner', /AI 신호검색기/],
    ['AI 차트', '/ai-chart', /AI 차트 생중계/],
    ['승인형 주문', '/auto-trading', /자동매매/],
  ] as const;

  for (const [label, route, heading] of cases) {
    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await navigation.getByRole('button', { name: '기술', exact: true }).click();
    const menu = page.getByRole('menu', { name: '기술 메뉴' });
    await menu.getByRole('menuitem', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expect(page.getByRole('menu', { name: '기술 메뉴' })).toBeHidden();
    await page.goto('/stocks/kr');
  }
  assertClean();
});

test('direct URL, reload, back/forward, active state, breadcrumb metadata, and visibility return stay stable', async ({ page }) => {
  const assertClean = await installApprovedRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/coins/spot');
  await expect(page.getByRole('heading', { name: '코인 현물 정보' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: '코인 현물 정보' })).toBeVisible();
  await page.goto('/coins/futures');
  await page.goBack();
  await expect(page.getByRole('heading', { name: '코인 현물 정보' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: '코인 선물 정보' })).toBeVisible();

  const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(navigation.getByRole('button', { name: '종목', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation).toHaveAttribute('data-breadcrumb', '종목 / 코인 선물 정보');
  await expect(page.getByRole('list', { name: '현재 위치' })).toContainText('코인 선물 정보');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByRole('heading', { name: '코인 선물 정보' })).toBeVisible();
  assertClean();
});
