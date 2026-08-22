import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '33333333-3333-4333-8333-333333333333';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-08-22T06:30:00.000Z';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-room-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시장방 UI 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

function meta(market: 'KR' | 'futures') {
  return {
    provider: market === 'KR' ? 'KRX' : 'BITGET',
    source: market === 'KR' ? 'KRX 공개' : 'Bitget 공개',
    market,
    assetType: market === 'KR' ? 'stock' : 'coin-futures',
    currency: market === 'KR' ? 'KRW' : 'USDT',
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: market === 'KR' ? 'Asia/Seoul' : 'UTC',
    marketStatus: market === 'KR' ? 'CLOSED' : '24H',
    isDelayed: false,
    isStale: false,
    partial: false,
    unavailableFields: [],
    errorCode: null,
    retryable: false,
  };
}

function roomResponse(room: 'stocks-kr' | 'coins-futures') {
  const futures = room === 'coins-futures';
  const roomMeta = meta(futures ? 'futures' : 'KR');
  const ready = <T,>(data: T) => ({ status: 'ready', data, meta: roomMeta, message: null });
  return {
    ok: true,
    room,
    market: futures ? 'futures' : 'KR',
    assetType: futures ? 'coin-futures' : 'stock',
    currency: futures ? 'USDT' : 'KRW',
    fetchedAt: NOW,
    partial: false,
    sections: {
      indices: ready([{ key: 'main', label: futures ? '비트코인' : '코스피', value: futures ? 65000 : 3200, changePercent: 0.5 }]),
      sectors: ready([{ key: 'sector', label: futures ? '대형 코인' : '반도체', constituentCount: 3, tradingValue: 1000000 }]),
      rankings: ready([{ exchange: futures ? 'BITGET' : 'KRX', symbol: futures ? 'BTCUSDT' : '005930', name: futures ? '비트코인' : '삼성전자', price: futures ? 65000 : 70000, currency: futures ? 'USDT' : 'KRW', changePercent: 1.2, volume24h: 1000, tradingValue24h: 2000, marketCap: 3000, fundingRatePercent: futures ? 0.01 : null, openInterest: futures ? 4000 : null, warning: false }]),
      news: ready([{ id: 'n1', title: '시장 뉴스', symbol: futures ? 'BTC' : '005930', source: '공개뉴스', publishedAt: NOW, url: 'https://example.com/news' }]),
      disclosures: ready([{ id: 'd1', title: '시장 공시', symbol: futures ? 'BTC' : '005930', source: '공개공시', publishedAt: NOW, url: 'https://example.com/disclosure' }]),
      derivatives: futures
        ? ready({ referenceSymbol: 'BTCUSDT', longRatio: 0.52, shortRatio: 0.48, longShortRatio: 1.08, ratioObservedAt: NOW, liquidations: [] })
        : { status: 'unsupported', data: { referenceSymbol: null, longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] }, meta: roomMeta, message: '미지원' },
    },
  };
}

async function installMocks(page: Page) {
  await installSession(page);
  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'market-room-ui',
        display_name: '시장방 UI 관리자',
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
        email: 'market-room-ui@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시장방 UI 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/market-information/stocks-kr') return fulfill(route, roomResponse('stocks-kr'));
    if (pathname === '/api/market-information/coins-futures') return fulfill(route, roomResponse('coins-futures'));
    if (pathname === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    return fulfill(route, { ok: true, items: [], results: [] });
  });
}

test('market-room source is Korean-first and mobile summary-tab based', () => {
  const pageSource = source('src/pages/market-information.tsx');
  expect(pageSource).toContain("type MobileRoomTab = 'market' | 'ranking' | 'news' | 'futures';");
  expect(pageSource).toContain("{ value: 'market', label: '시장' }");
  expect(pageSource).toContain("{ value: 'ranking', label: '순위' }");
  expect(pageSource).toContain("{ value: 'news', label: '소식' }");
  expect(pageSource).toContain("label: '선물'");
  expect(pageSource).toContain('미결제약정');
  expect(pageSource).toContain('오래됨');
  expect(pageSource).not.toContain('>stale<');
  expect(pageSource).not.toContain('private 요청 0');
  expect(pageSource).not.toContain('주문·취소 0');
  expect(pageSource).not.toContain('animate-pulse');
  expect(pageSource).not.toContain('<span>OI ');
});

for (const width of [360, 390, 412, 430]) {
  test(`stock market room ${width}px shows one mobile section without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installMocks(page);
    await page.goto('/stocks/kr');

    await expect(page.getByTestId('market-room-mobile-tabs')).toBeVisible();
    await expect(page.getByTestId('market-room-overview')).toBeVisible();
    await expect(page.getByTestId('market-room-rankings')).toHaveCount(0);
    await expect(page.getByTestId('market-room-news')).toHaveCount(0);

    await page.getByRole('tab', { name: '순위' }).click();
    await expect(page.getByTestId('market-room-rankings')).toBeVisible();
    await expect(page.getByTestId('market-room-overview')).toHaveCount(0);

    const overflow = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('futures mobile gets a separate futures tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page);
  await page.goto('/coins/futures');
  await page.getByRole('tab', { name: '선물' }).click();
  await expect(page.getByTestId('market-room-futures')).toBeVisible();
  await expect(page.getByText('미결제약정', { exact: false })).toHaveCount(0);
});

test('desktop market room keeps all sections together without mobile tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installMocks(page);
  await page.goto('/coins/futures');
  await expect(page.getByTestId('market-room-mobile-tabs')).toHaveCount(0);
  await expect(page.getByTestId('market-room-desktop-dashboard')).toBeVisible();
  await expect(page.getByTestId('market-room-overview')).toBeVisible();
  await expect(page.getByTestId('market-room-rankings')).toBeVisible();
  await expect(page.getByTestId('market-room-futures')).toBeVisible();
  await expect(page.getByTestId('market-room-news')).toBeVisible();
});
