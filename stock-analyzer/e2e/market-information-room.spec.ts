import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-05T00:00:00.000Z';
const E2E_USER_ID = '11111111-1111-4111-8111-111111111111';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

type RoomId = 'stocks-kr' | 'stocks-us' | 'coins-spot' | 'coins-futures';
type Diagnostics = {
  assertClean: () => void;
  forbiddenRequests: string[];
};

type MockOptions = {
  delayRoom?: RoomId;
  delayMs?: number;
  partialRoom?: RoomId;
  staleRoom?: RoomId;
  errorRoom?: RoomId;
  errorStatus?: number;
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedSession(page: Page): Promise<void> {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
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
        email: 'e2e-information-room@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정보방 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });
}

function roomConfig(room: RoomId) {
  if (room === 'stocks-kr') return { market: 'KR', assetType: 'stock', currency: 'KRW', exchange: 'KRX', title: '국내주식 정보' } as const;
  if (room === 'stocks-us') return { market: 'US', assetType: 'stock', currency: 'USD', exchange: 'US', title: '미국주식 정보' } as const;
  if (room === 'coins-spot') return { market: 'spot', assetType: 'coin-spot', currency: 'KRW', exchange: 'UPBIT', title: '코인 현물 정보' } as const;
  return { market: 'futures', assetType: 'coin-futures', currency: 'USDT', exchange: 'BITGET', title: '코인 선물 정보' } as const;
}

function meta(room: RoomId, options: { partial?: boolean; stale?: boolean } = {}) {
  const config = roomConfig(room);
  return {
    provider: config.exchange,
    source: `${config.exchange} 공식 공개 데이터`,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    providerUpdatedAt: NOW,
    observedAt: NOW,
    fetchedAt: NOW,
    marketTimeZone: config.market === 'KR' ? 'Asia/Seoul' : config.market === 'US' ? 'America/New_York' : config.market === 'spot' ? 'Asia/Seoul' : 'UTC',
    marketStatus: config.assetType === 'stock' ? 'CLOSED' : '24H',
    isDelayed: options.stale === true,
    isStale: options.stale === true,
    partial: options.partial === true,
    unavailableFields: options.partial ? ['marketCap'] : [],
    errorCode: null,
    retryable: false,
  };
}

function roomResponse(room: RoomId, options: MockOptions) {
  const config = roomConfig(room);
  const partial = options.partialRoom === room;
  const stale = options.staleRoom === room;
  const sectionMeta = meta(room, { partial, stale });
  const rows = room === 'stocks-kr'
    ? [{ symbol: '005930', name: '삼성전자', exchange: 'KRX', currency: 'KRW', price: 78000, changePercent: 0.7, high24h: 79000, low24h: 77000, volume24h: 700000, tradingValue24h: 54000000000, marketCap: null, warning: false, tradingStatus: null, fundingRatePercent: null, nextFundingAt: null, openInterest: null, rangeVolatility24hPercent: null, providerUpdatedAt: NOW }]
    : room === 'stocks-us'
      ? [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', price: 240, changePercent: 1.2, high24h: 242, low24h: 235, volume24h: 500000, tradingValue24h: 120000000, marketCap: null, warning: false, tradingStatus: null, fundingRatePercent: null, nextFundingAt: null, openInterest: null, rangeVolatility24hPercent: null, providerUpdatedAt: NOW }]
      : room === 'coins-spot'
        ? [{ symbol: 'BTC', name: '비트코인', exchange: 'UPBIT', currency: 'KRW', price: 101000000, changePercent: 1.3, high24h: 102000000, low24h: 99000000, volume24h: 1234, tradingValue24h: 125000000000, marketCap: null, warning: false, tradingStatus: 'ACTIVE', fundingRatePercent: null, nextFundingAt: null, openInterest: null, rangeVolatility24hPercent: null, providerUpdatedAt: NOW }]
        : [{ symbol: 'BTCUSDT', name: 'BTCUSDT', exchange: 'BITGET', currency: 'USDT', price: 70000, changePercent: 0.6, high24h: 71000, low24h: 68000, volume24h: 100000, tradingValue24h: 7000000000, marketCap: null, warning: false, tradingStatus: 'normal', fundingRatePercent: 0.01, nextFundingAt: '2026-08-05T08:00:00.000Z', openInterest: 550000, rangeVolatility24hPercent: 4.4, providerUpdatedAt: NOW }];
  const unsupported = (message: string) => ({ status: 'unsupported', data: [], meta: { ...sectionMeta, provider: null, source: null, errorCode: 'PROVIDER_UNSUPPORTED', unavailableFields: ['all'] }, message });
  const unavailable = (message: string) => ({ status: 'unavailable', data: [], meta: { ...sectionMeta, provider: null, source: null, errorCode: 'COIN_NEWS_PROVIDER_NOT_CONNECTED', unavailableFields: ['all'] }, message });
  const stock = config.assetType === 'stock';
  const status = stale ? 'stale' : partial ? 'partial' : 'ready';
  return {
    ok: true,
    room,
    market: config.market,
    assetType: config.assetType,
    currency: config.currency,
    fetchedAt: NOW,
    partial: partial || stale || !stock,
    sections: {
      indices: stock
        ? { status, data: [{ key: config.market === 'KR' ? 'KOSPI' : 'NASDAQ', label: config.market === 'KR' ? '코스피' : '나스닥', value: 3123.45, changePercent: 0.8 }], meta: sectionMeta, message: partial ? '일부 지수만 제공됩니다.' : null }
        : unsupported('코인에는 주식 시장 지수를 표시하지 않습니다.'),
      rankings: { status, data: rows, meta: sectionMeta, message: partial ? '일부 ticker 응답만 표시합니다.' : null },
      sectors: stock
        ? { status, data: [{ key: 'technology', label: config.market === 'KR' ? '반도체' : 'Technology', tradingValue: 123000000, constituentCount: 1, changePercent: null }], meta: sectionMeta, message: null }
        : unsupported('공개 응답은 업종·섹터를 제공하지 않습니다.'),
      news: stock
        ? { status: 'ready', data: [{ id: `${room}-news`, kind: 'news', symbol: rows[0].symbol, title: `${config.title} 공개 뉴스`, summary: '공개 정보', provider: '테스트뉴스', source: '테스트뉴스', url: 'https://example.com/news', publishedAt: NOW }], meta: sectionMeta, message: null }
        : unavailable('검증된 코인 뉴스 provider가 아직 연결되지 않았습니다.'),
      disclosures: stock
        ? { status: 'ready', data: [{ id: `${room}-filing`, kind: 'disclosure', symbol: rows[0].symbol, title: `${config.title} 공식 공시`, summary: '공식 공시', provider: config.market === 'KR' ? 'OpenDART' : 'SEC EDGAR', source: config.market === 'KR' ? '금융감독원 전자공시' : 'SEC', url: 'https://example.com/filing', publishedAt: NOW }], meta: sectionMeta, message: null }
        : unsupported('코인에는 기업 공시를 표시하지 않습니다.'),
      derivatives: room === 'coins-futures'
        ? { status, data: { referenceSymbol: 'BTCUSDT', longRatio: 0.55, shortRatio: 0.45, longShortRatio: 1.22, ratioObservedAt: NOW, liquidations: [{ symbol: 'BTCUSDT', side: 'long', price: 70000, amount: 0.5, occurredAt: NOW }] }, meta: sectionMeta, message: null }
        : { status: 'unsupported', data: { referenceSymbol: 'BTCUSDT', longRatio: null, shortRatio: null, longShortRatio: null, ratioObservedAt: null, liquidations: [] }, meta: { ...sectionMeta, provider: null, source: null, errorCode: 'PROVIDER_UNSUPPORTED', unavailableFields: ['derivatives'] }, message: '이 정보방에는 선물 파생지표를 표시하지 않습니다.' },
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

async function mockInformationApi(page: Page, options: MockOptions = {}): Promise<Diagnostics> {
  await installApprovedSession(page);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const unexpectedHttp: string[] = [];
  const forbiddenRequests: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) requestFailures.push(`${request.method()} ${request.url()} ${reason}`);
  });
  page.on('response', (response) => {
    if (!response.url().includes('/api/')) return;
    const expectedError = options.errorRoom && response.url().endsWith(`/market-information/${options.errorRoom}`);
    if (response.status() >= 400 && !expectedError) unexpectedHttp.push(`${response.status()} ${response.url()}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'e2e-information-admin',
        display_name: '정보방 검증 관리자',
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
        email: 'e2e-information-room@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정보방 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (/\/(accounts?|balances?|positions?|orders?|cancel|trade-automation)(\/|$)|\/crypto\/futures\/auto/i.test(path)) {
      forbiddenRequests.push(`${route.request().method()} ${path}`);
      return fulfill(route, { ok: false, error: 'FORBIDDEN_TEST_REQUEST' }, 500);
    }
    const match = path.match(/^\/api\/market-information\/(stocks-kr|stocks-us|coins-spot|coins-futures)$/);
    if (match) {
      const room = match[1] as RoomId;
      if (options.delayRoom === room) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 800));
      if (options.errorRoom === room) {
        const status = options.errorStatus ?? 503;
        return fulfill(route, {
          ok: false,
          errorCode: status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_HTTP_503',
          retryable: true,
          message: status === 429 ? '제공기관 호출 한도에 도달했습니다.' : '제공기관 장애입니다.',
        }, status);
      }
      return fulfill(route, roomResponse(room, options));
    }
    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/watchlist/sync') return fulfill(route, { ok: true, items: [] });
    return fulfill(route, { ok: true });
  });

  return {
    forbiddenRequests,
    assertClean: () => {
      expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
      expect(pageErrors, pageErrors.join('\n')).toEqual([]);
      expect(requestFailures, requestFailures.join('\n')).toEqual([]);
      expect(unexpectedHttp, unexpectedHttp.join('\n')).toEqual([]);
      expect(forbiddenRequests, forbiddenRequests.join('\n')).toEqual([]);
    },
  };
}

async function openInformationMenu(page: Page) {
  const trigger = page.getByRole('button', { name: '정보', exact: true });
  await trigger.click();
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeVisible();
  return trigger;
}

test('information popup supports outside touch, Escape, focus restoration, and selection close', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/stocks/kr');
  await expect(page.getByRole('heading', { name: '국내주식 정보' })).toBeVisible();

  const trigger = await openInformationMenu(page);
  await expect(page.getByRole('menuitem', { name: '국내', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '해외', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '현물', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '선물', exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();
  await expect(trigger).toBeFocused();

  await openInformationMenu(page);
  await page.getByRole('heading', { name: '국내주식 정보' }).click();
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();

  await openInformationMenu(page);
  await page.getByRole('menuitem', { name: '해외', exact: true }).click();
  await expect(page).toHaveURL(/\/stocks\/us$/);
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();
  await expect(page.getByRole('heading', { name: '미국주식 정보' })).toBeVisible();
  diagnostics.assertClean();
});

test('all four information rooms render source, freshness, refresh, and no private requests', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  const routes = [
    ['/stocks/kr', '국내주식 정보', 'KRX · KRW'],
    ['/stocks/us', '미국주식 정보', 'US · USD'],
    ['/coins/spot', '코인 현물 정보', 'UPBIT · KRW'],
    ['/coins/futures', '코인 선물 정보', 'BITGET · USDT'],
  ] as const;
  for (const [path, title, exchange] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(exchange, { exact: true })).toBeVisible();
    await expect(page.getByText('공개 API 전용', { exact: true })).toBeVisible();
    await expect(page.getByText('private 요청 0', { exact: true })).toBeVisible();
    await expect(page.getByLabel('데이터 출처와 신선도').first()).toContainText('출처');
    await page.getByRole('button', { name: '시장정보 새로고침' }).click();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
  await page.goto('/coins/spot');
  await expect(page.getByText(/펀딩/)).toHaveCount(0);
  await expect(page.getByText(/미결제약정/)).toHaveCount(0);
  await expect(page.getByText('검증된 코인 뉴스 provider가 아직 연결되지 않았습니다.').first()).toBeVisible();
  await page.goto('/coins/futures');
  await expect(page.getByText('선물 공개 파생지표')).toBeVisible();
  await expect(page.getByText('롱 비율')).toBeVisible();
  diagnostics.assertClean();
});

test('rapid KR to US transition aborts stale room query and never applies delayed KR rows', async ({ page }) => {
  const diagnostics = await mockInformationApi(page, { delayRoom: 'stocks-kr', delayMs: 900 });
  await page.goto('/stocks/kr');
  await openInformationMenu(page);
  await page.getByRole('menuitem', { name: '해외', exact: true }).click();
  await expect(page.getByText('Apple Inc.', { exact: true })).toBeVisible();
  await page.waitForTimeout(1100);
  await expect(page.getByText('Apple Inc.', { exact: true })).toBeVisible();
  await expect(page.getByText('삼성전자', { exact: true })).toHaveCount(0);
  diagnostics.assertClean();
});

test('partial, stale, unsupported, 429, and provider error states remain card-scoped', async ({ page }) => {
  const partialDiagnostics = await mockInformationApi(page, { partialRoom: 'stocks-kr', staleRoom: 'stocks-kr' });
  await page.goto('/stocks/kr');
  await expect(page.getByText('부분 데이터', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('stale', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('삼성전자', { exact: true })).toBeVisible();
  partialDiagnostics.assertClean();

  const limitedPage = await page.context().newPage();
  const limitedDiagnostics = await mockInformationApi(limitedPage, { errorRoom: 'coins-spot', errorStatus: 429 });
  await limitedPage.goto('/coins/spot');
  await expect(limitedPage.getByRole('heading', { name: '제공기관 호출 한도에 도달했습니다' })).toBeVisible();
  await expect(limitedPage.getByRole('button', { name: '다시 시도' })).toBeVisible();
  limitedDiagnostics.assertClean();
  await limitedPage.close();
});

test('mobile 360, 390, and 430 layouts have no horizontal overflow and keep 44px touch targets', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/coins/futures');
    await expect(page.getByRole('heading', { name: '코인 선물 정보' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const boxes = await page.getByRole('button').evaluateAll((buttons) => buttons
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => ({ label: button.getAttribute('aria-label') ?? button.textContent ?? '', height: button.getBoundingClientRect().height })));
    const interactive = boxes.filter((box) => /새로고침|상세 화면 이동|정보$/.test(box.label.trim()));
    expect(interactive.length).toBeGreaterThan(0);
    for (const box of interactive) expect(box.height, `${width}px ${box.label}`).toBeGreaterThanOrEqual(44);
  }
  diagnostics.assertClean();
});
