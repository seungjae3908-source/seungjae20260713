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
  } as const;
}

function roomResponse(room: 'stocks-kr' | 'coins-futures') {
  const futures = room === 'coins-futures';
  const roomMeta = meta(futures ? 'futures' : 'KR');
  const ready = <T,>(data: T) => ({ status: 'ready' as const, data, meta: roomMeta, message: null });
  const unsupportedArray = (message: string) => ({
    status: 'unsupported' as const,
    data: [],
    meta: { ...roomMeta, provider: null, source: null, unavailableFields: ['all'], errorCode: 'PROVIDER_UNSUPPORTED' },
    message,
  });
  const ranking = futures ? [{
    symbol: 'BTCUSDT', name: '비트코인', exchange: 'BITGET', currency: 'USDT', price: 65000,
    changePercent: 1.2, high24h: 66000, low24h: 63000, volume24h: 1000,
    tradingValue24h: 2000, marketCap: null, warning: false, tradingStatus: 'normal',
    fundingRatePercent: 0.01, nextFundingAt: '2026-08-22T08:00:00.000Z', openInterest: 4000,
    rangeVolatility24hPercent: 4.6, providerUpdatedAt: NOW,
  }] : [{
    symbol: '005930', name: '삼성전자', exchange: 'KRX', currency: 'KRW', price: 70000,
    changePercent: 1.2, high24h: 71000, low24h: 69000, volume24h: 1000,
    tradingValue24h: 2000, marketCap: null, warning: false, tradingStatus: null,
    fundingRatePercent: null, nextFundingAt: null, openInterest: null,
    rangeVolatility24hPercent: null, providerUpdatedAt: NOW,
  }];
  return {
    ok: true,
    room,
    market: futures ? 'futures' : 'KR',
    assetType: futures ? 'coin-futures' : 'stock',
    currency: futures ? 'USDT' : 'KRW',
    fetchedAt: NOW,
    partial: futures,
    sections: {
      indices: futures
        ? unsupportedArray('코인에는 주식 시장 지수를 표시하지 않습니다.')
        : ready([{ key: 'main', label: '코스피', value: 3200, changePercent: 0.5 }]),
      sectors: futures
        ? unsupportedArray('공개 응답은 업종·섹터를 제공하지 않습니다.')
        : ready([{ key: 'sector', label: '반도체', constituentCount: 3, tradingValue: 1000000, changePercent: null }]),
      rankings: ready(ranking),
      news: futures
        ? { status: 'unavailable' as const, data: [], meta: { ...roomMeta, provider: null, source: null, unavailableFields: ['all'], errorCode: 'COIN_NEWS_PROVIDER_NOT_CONNECTED' }, message: '검증된 코인 뉴스 provider가 아직 연결되지 않았습니다.' }
        : ready([{ id: 'n1', kind: 'news' as const, title: '시장 뉴스', symbol: '005930', summary: '공개 정보', provider: '공개뉴스', source: '공개뉴스', publishedAt: NOW, url: 'https://example.com/news' }]),
      disclosures: futures
        ? unsupportedArray('코인에는 기업 공시를 표시하지 않습니다.')
        : ready([{ id: 'd1', kind: 'disclosure' as const, title: '시장 공시', symbol: '005930', summary: '공개 공시', provider: 'OpenDART', source: '공개공시', publishedAt: NOW, url: 'https://example.com/disclosure' }]),
      derivatives: futures
        ? ready({ referenceSymbol: 'BTCUSDT', longRatio: 0.52, shortRatio: 0.48, longShortRatio: 1.08, ratioObservedAt: NOW, liquidations: [] })
        : { status: 'unsupported' as const, data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] }, meta: { ...roomMeta, provider: null, source: null, unavailableFields: ['derivatives'], errorCode: 'PROVIDER_UNSUPPORTED' }, message: '이 정보방에는 선물 파생지표를 표시하지 않습니다.' },
    },
    requestPolicy: {
      publicMarketDataOnly: true as const,
      privateExchangeRequests: 0 as const,
      accountRequests: 0 as const,
      balanceRequests: 0 as const,
      positionRequests: 0 as const,
      orderRequests: 0 as const,
      cancelRequests: 0 as const,
      aiRequests: 0 as const,
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

test('market-room source is Korean-first and follows the app-wide 1200px desktop breakpoint', () => {
  const pageSource = source('src/pages/market-information.tsx');
  expect(pageSource).toContain("type MobileRoomTab = 'market' | 'ranking' | 'news' | 'futures';");
  expect(pageSource).toContain("{ value: 'market', label: '시장' }");
  expect(pageSource).toContain("{ value: 'ranking', label: '순위' }");
  expect(pageSource).toContain("{ value: 'news', label: '소식' }");
  expect(pageSource).toContain("label: '선물'");
  expect(pageSource).toContain("const query = '(min-width: 1200px)';");
  expect(pageSource).not.toContain("const query = '(min-width: 1024px)'");
  expect(pageSource).not.toContain("@/lib/adaptive-layout");
  expect(pageSource).toContain('미결제약정');
  expect(pageSource).toContain('오래됨');
  expect(pageSource).not.toContain('>stale<');
  expect(pageSource).not.toContain('private 요청 0');
  expect(pageSource).not.toContain('주문·취소 0');
  expect(pageSource).not.toContain('animate-pulse');
  expect(pageSource).not.toContain('<span>OI ');
});

for (const width of [360, 390, 412, 430, 1024, 1180]) {
  test(`stock market room ${width}px stays touch-first with one section and no horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 1024 ? 820 : 844 });
    await installMocks(page);
    await page.goto('/stocks/kr');

    await expect(page.getByTestId('market-room-mobile-tabs')).toBeVisible();
    await expect(page.getByTestId('market-room-desktop-dashboard')).toHaveCount(0);
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

for (const width of [1200, 1440]) {
  test(`desktop market room ${width}px keeps all sections together without mobile tabs`, async ({ page }) => {
    await page.setViewportSize({ width, height: 960 });
    await installMocks(page);
    await page.goto('/coins/futures');
    await expect(page.getByTestId('market-room-mobile-tabs')).toHaveCount(0);
    await expect(page.getByTestId('market-room-desktop-dashboard')).toBeVisible();
    await expect(page.getByTestId('market-room-overview')).toBeVisible();
    await expect(page.getByTestId('market-room-rankings')).toBeVisible();
    await expect(page.getByTestId('market-room-futures')).toBeVisible();
    await expect(page.getByTestId('market-room-news')).toBeVisible();
  });
}
