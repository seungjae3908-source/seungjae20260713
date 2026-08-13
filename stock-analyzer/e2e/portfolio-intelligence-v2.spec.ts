import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-13T09:20:00.000Z';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const AUTH_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

const holdings = [{
  id: 'holding-1', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW',
  quantity: 10, average_price: 70000, purchase_date: '2026-08-01', created_at: NOW,
}];

const intelligence = {
  status: 'PARTIAL', asOf: NOW,
  totalAssets: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 750000 },
  investmentPrincipal: { status: 'READY', normalizedKRW: 700000, knownNormalizedKRW: 700000 },
  valuationPnl: { status: 'READY', normalizedKRW: 50000, returnPercent: 7.142857 },
  nativeBalances: {
    KRW: { amount: 750000, status: 'PARTIAL', source: 'known-stock-valuation-only' },
    USD: { amount: 0, status: 'PARTIAL', source: 'known-stock-valuation-only' },
    USDT: { amount: null, status: 'UNAVAILABLE', source: 'private-provider-not-called' },
  },
  normalizedKRW: { status: 'PARTIAL', knownNormalizedKRWAmount: 750000, totalNormalizedKRWAmount: null },
  fx: { status: 'READY', quotes: [{ rate: 1385, pair: 'USD/KRW', source: 'yahoo-public:KRW=X', asOf: NOW, quality: 'DELAYED' }] },
  cash: { status: 'UNAVAILABLE', totalKRW: null },
  minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
  investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
  assets: { krStocks: 750000, usStocks: 0, cryptoSpot: null, cryptoFuturesEquity: null, cash: null },
  allocation: { status: 'PARTIAL', knownTotalKRW: 750000, buckets: { KR_STOCKS: 100, US_STOCKS: 0, CRYPTO_SPOT: null, CRYPTO_FUTURES_EQUITY: null, CASH: null } },
  holdings: [{ id: 'holding-1', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 10, averagePrice: 70000, currentPrice: 75000, nativeValue: 750000, normalizedKRW: 750000 }],
  topHoldings: [{ id: 'holding-1', ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 10, averagePrice: 70000, currentPrice: 75000, nativeValue: 750000, normalizedKRW: 750000 }],
  top5Concentration: { status: 'READY', percent: 100 },
  correlation: { status: 'INSUFFICIENT_SAMPLE', sampleSize: 0, correlation: null, pair: [] },
  riskClassification: { status: 'PARTIAL', level: null, reason: 'CASH_AND_CRYPTO_EXPOSURE_UNAVAILABLE' },
  allocationPolicy: {
    profile: 'BALANCED', status: 'PARTIAL', comparison: [
      { assetClass: 'CASH', currentPercent: null, minPercent: 10, maxPercent: 25, state: 'UNAVAILABLE' },
      { assetClass: 'KR_STOCKS', currentPercent: 100, minPercent: 25, maxPercent: 40, state: 'OVERWEIGHT' },
      { assetClass: 'US_STOCKS', currentPercent: 0, minPercent: 30, maxPercent: 50, state: 'UNDERWEIGHT' },
      { assetClass: 'CRYPTO', currentPercent: null, minPercent: 5, maxPercent: 20, state: 'UNAVAILABLE' },
    ],
  },
  dataQuality: { status: 'PARTIAL', providerCount: 5, includedProviderCount: 2, invalidHoldingRows: 0 },
  missingSources: ['PROVIDER:cash-account:READONLY_CASH_SOURCE_UNAVAILABLE', 'PROVIDER:crypto-spot-account:PRIVATE_PROVIDER_NOT_CALLED'],
  safety: { liveTrading: false, orderAuthority: 'none', realOrderCount: 0, realCancelCount: 0, realAmendCount: 0, privateTradingApiCount: 0 },
};

async function installRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken, refresh_token: 'portfolio-e2e-refresh', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer',
      user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'portfolio@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '포트폴리오 검증' }, identities: [], created_at: now },
    }));
  }, { storageKey: AUTH_KEY, userId: USER_ID, now: NOW });

  const requests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/api/') || url.pathname.includes('/rest/v1/')) requests.push(`${request.method()} ${url.pathname}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, {
      id: USER_ID, login_name: 'portfolio-e2e', display_name: '포트폴리오 검증', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW,
    });
    if (pathname.endsWith('/rest/v1/portfolio_holdings')) return fulfill(route, holdings);
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, {
      id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'portfolio@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '포트폴리오 검증' }, identities: [], created_at: NOW,
    });
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/portfolio/intelligence') return fulfill(route, { ok: true, portfolio: intelligence });
    if (path === '/api/quotes') return fulfill(route, { ok: true, quotes: [{ ticker: '005930', price: 75000, changePercent: 1.2 }] });
    return fulfill(route, { ok: true, items: [], rows: [], results: [], quotes: [], alerts: [] });
  });

  return { requests, consoleErrors, pageErrors };
}

function countBusinessRequests(requests: string[]) {
  return requests.filter((entry) => entry.includes('/api/portfolio/intelligence') || entry.includes('/api/quotes') || entry.includes('/rest/v1/portfolio_holdings'));
}

test('Portfolio V2 reduces initial browser data requests and manual refresh is single-owner', async ({ page }) => {
  const diagnostics = await installRuntime(page);
  await page.setViewportSize({ width: 390, height: 844 });

  let started = performance.now();
  await page.goto('/position');
  await expect(page.getByRole('heading', { name: '내 포트폴리오' })).toBeVisible();
  await expect(page.getByText('삼성전자').first()).toBeVisible();
  const legacyUsableMs = Math.round((performance.now() - started) * 10) / 10;
  const legacyRequests = countBusinessRequests(diagnostics.requests);
  const legacyInitialCount = legacyRequests.length;

  diagnostics.requests.length = 0;
  started = performance.now();
  await page.goto('/portfolio');
  await expect(page.getByRole('heading', { name: 'Portfolio Intelligence' })).toBeVisible();
  await expect(page.getByText('750,000원').first()).toBeVisible();
  const v2UsableMs = Math.round((performance.now() - started) * 10) / 10;
  const v2Initial = countBusinessRequests(diagnostics.requests);
  const v2InitialCount = v2Initial.length;
  const uniqueInitial = new Set(v2Initial);
  const duplicateInitialCount = v2Initial.length - uniqueInitial.size;

  diagnostics.requests.length = 0;
  await page.getByRole('button', { name: '포트폴리오 인텔리전스 새로고침' }).click();
  await expect.poll(() => countBusinessRequests(diagnostics.requests).filter((entry) => entry.includes('/api/portfolio/intelligence')).length).toBe(1);
  const manualRefreshCount = countBusinessRequests(diagnostics.requests).length;

  console.log(`PORTFOLIO_V2_METRICS=${JSON.stringify({ legacyInitialCount, legacyUsableMs, v2InitialCount, v2UsableMs, duplicateInitialCount, manualRefreshCount })}`);
  expect(legacyInitialCount).toBeGreaterThanOrEqual(2);
  expect(v2InitialCount).toBe(1);
  expect(duplicateInitialCount).toBe(0);
  expect(manualRefreshCount).toBe(1);
  expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
  expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
});

for (const width of [320, 360, 390, 412, 430]) {
  test(`Portfolio Intelligence has no horizontal overflow at ${width}px`, async ({ page }) => {
    const diagnostics = await installRuntime(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/portfolio');
    await expect(page.getByRole('heading', { name: 'Portfolio Intelligence' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
    await expect(page.getByText('총 자산')).toBeVisible();
    await expect(page.getByText('추가 투자 가능')).toBeVisible();
    await expect(page.getByText('자산배분')).toBeVisible();
    await expect(page.getByText('추가매수 시뮬레이터')).toBeVisible();
    expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
    expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
  });
}
