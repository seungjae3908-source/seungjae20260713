import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

const USER_ID = '88888888-8888-4888-8888-888888888888';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-09-05T00:00:00.000Z';

type SearchMode =
  | 'normal'
  | 'null'
  | 'timeout'
  | 'http401'
  | 'http403'
  | 'http429'
  | 'http500'
  | 'provider-unavailable'
  | 'stale-race'
  | 'unmount-race';

type RuntimeState = {
  sessionExpired: boolean;
  searchMode: SearchMode;
  searchRequests: number;
};

type BrowserEvidence = {
  console: Array<{ type: string; text: string }>;
  pageErrors: string[];
  requests: Array<{ method: string; path: string }>;
  responses: Array<{ method: string; path: string; status: number }>;
  requestFailures: Array<{ method: string; path: string; error: string | null }>;
};

const evidenceByPage = new WeakMap<Page, BrowserEvidence>();

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

function authUser() {
  return {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'full-product-browser@accounts.invalid',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { display_name: 'Full Product Browser' },
    identities: [],
    created_at: NOW,
  };
}

function encodeJwtPart(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function authSession() {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = `${encodeJwtPart({ alg: 'none', typ: 'JWT' })}.${encodeJwtPart({ sub: USER_ID, role: 'authenticated', exp: expiresAt })}.e2e`;
  return {
    access_token: accessToken,
    refresh_token: 'full-product-browser-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: authUser(),
  };
}

function searchResult(query = '삼성전자') {
  const us = /aapl|apple/i.test(query);
  return {
    id: us ? 'US:AAPL' : 'KR:005930',
    assetType: 'stock',
    market: us ? 'US' : 'KR',
    instrumentType: 'stock',
    exchange: us ? 'NASDAQ' : 'KRX',
    ticker: us ? 'AAPL' : '005930',
    symbol: us ? 'AAPL' : '005930',
    productCode: us ? 'AAPL' : '005930',
    koreanName: us ? '애플' : '삼성전자',
    englishName: us ? 'Apple' : 'Samsung Electronics',
    displayName: us ? 'Apple' : '삼성전자',
    baseSymbol: us ? 'AAPL' : '005930',
    quoteCurrency: us ? 'USD' : 'KRW',
    matchType: 'exact',
    active: true,
    provider: us ? 'finnhub' : 'krx',
    dataAsOf: NOW,
  };
}

function searchEnvelope(query: string, results = [searchResult(query)]) {
  return {
    ok: true,
    state: results.length ? 'FULL' : 'EMPTY',
    q: query,
    asset: 'all',
    market: null,
    results,
    count: results.length,
    dataAsOf: NOW,
    stale: false,
    partial: false,
    providers: [
      { provider: 'krx', status: 'ok', count: results.filter((item) => item.market === 'KR').length, dataAsOf: NOW },
      { provider: 'finnhub', status: 'ok', count: results.filter((item) => item.market === 'US').length, dataAsOf: NOW },
      { provider: 'upbit', status: 'ok', count: 0, dataAsOf: NOW },
      { provider: 'bitget', status: 'ok', count: 0, dataAsOf: NOW },
    ],
    hiddenMatches: [],
  };
}

function candleRows() {
  const base = Date.parse('2026-09-04T00:00:00.000Z');
  return Array.from({ length: 60 }, (_, index) => ({
    timestamp: base + index * 300_000,
    time: base + index * 300_000,
    open: 75_000 + index,
    high: 75_100 + index,
    low: 74_900 + index,
    close: 75_050 + index,
    volume: 10_000 + index,
  }));
}

function pathname(raw: string) {
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return raw;
  }
}

function installBrowserEvidence(page: Page) {
  const evidence: BrowserEvidence = {
    console: [],
    pageErrors: [],
    requests: [],
    responses: [],
    requestFailures: [],
  };
  evidenceByPage.set(page, evidence);
  page.on('console', (message) => evidence.console.push({ type: message.type(), text: message.text() }));
  page.on('pageerror', (error) => evidence.pageErrors.push(error.message));
  page.on('request', (request) => evidence.requests.push({ method: request.method(), path: pathname(request.url()) }));
  page.on('response', (response) => evidence.responses.push({
    method: response.request().method(),
    path: pathname(response.url()),
    status: response.status(),
  }));
  page.on('requestfailed', (request) => evidence.requestFailures.push({
    method: request.method(),
    path: pathname(request.url()),
    error: request.failure()?.errorText ?? null,
  }));
  return evidence;
}

async function installRuntime(page: Page): Promise<RuntimeState> {
  const state: RuntimeState = {
    sessionExpired: false,
    searchMode: 'normal',
    searchRequests: 0,
  };

  await page.route('**/__e2e-supabase/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/v1/token')) {
      const grantType = url.searchParams.get('grant_type');
      if (state.sessionExpired && grantType === 'refresh_token') {
        return json(route, { error: 'invalid_grant', error_description: 'expired refresh token' }, 401);
      }
      return json(route, authSession());
    }
    if (path.endsWith('/auth/v1/user')) {
      return state.sessionExpired
        ? json(route, { message: 'JWT expired' }, 401)
        : json(route, authUser());
    }
    if (path.endsWith('/auth/v1/logout')) {
      return route.fulfill({ status: 204, body: '' });
    }
    if (path.endsWith('/rest/v1/profiles')) {
      return json(route, {
        id: USER_ID,
        login_name: 'full-product-admin',
        display_name: 'Full Product Browser',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (path.endsWith('/rest/v1/portfolio_holdings')) return json(route, []);
    return json(route, []);
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/api/search/suggest') {
      const query = url.searchParams.get('q') ?? '';
      state.searchRequests += 1;
      if (state.searchMode === 'null') return json(route, null);
      if (state.searchMode === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, 5_200));
        return route.abort('timedout').catch(() => undefined);
      }
      if (state.searchMode === 'http401') return json(route, { error: 'UNAUTHORIZED', message: '로그인이 필요합니다.' }, 401);
      if (state.searchMode === 'http403') return json(route, { error: 'FORBIDDEN', message: '권한이 없습니다.' }, 403);
      if (state.searchMode === 'http429') return json(route, { error: 'RATE_LIMITED', message: '요청이 많습니다.' }, 429);
      if (state.searchMode === 'http500') return json(route, { error: 'UPSTREAM_ERROR', message: '검색 서버 오류' }, 500);
      if (state.searchMode === 'provider-unavailable') {
        return json(route, {
          ...searchEnvelope(query, []),
          state: 'DEGRADED',
          partial: true,
          providers: [
            { provider: 'krx', status: 'error', count: 0, dataAsOf: null, message: 'provider unavailable' },
            { provider: 'finnhub', status: 'ok', count: 0, dataAsOf: NOW },
            { provider: 'upbit', status: 'ok', count: 0, dataAsOf: NOW },
            { provider: 'bitget', status: 'ok', count: 0, dataAsOf: NOW },
          ],
        });
      }
      if (state.searchMode === 'stale-race' || state.searchMode === 'unmount-race') {
        const delay = state.searchRequests % 2 === 1 ? 900 : 40;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return json(route, searchEnvelope(query));
      }
      return json(route, searchEnvelope(query));
    }

    if (path === '/api/account-connections/snapshot') {
      return json(route, {
        ok: true,
        readOnly: true,
        mutationsAllowed: false,
        checkedAt: NOW,
        providers: {
          toss: { configured: true, connected: true, accountMasked: '12******34', holdingCount: 1, holdings: [] },
          upbit: { configured: true, connected: true, assetCount: 1, assets: [] },
          bitget: { configured: true, connected: true, accounts: [], positions: [] },
        },
      });
    }
    if (path === '/api/account-connections/status') {
      return json(route, { ok: true, readOnly: true, mutationsAllowed: false, providers: { toss: { configured: true }, upbit: { configured: true }, bitget: { configured: true } }, checkedAt: NOW });
    }
    if (/^\/api\/stocks\/[^/]+\/(?:candles|chart)$/.test(path)) {
      return json(route, { ok: true, market: 'KR', symbol: '005930', provider: 'e2e', fetchedAt: NOW, updatedAt: NOW, candles: candleRows() });
    }
    if (/^\/api\/stocks\/[^/]+\/overview$/.test(path)) {
      return json(route, { profile: { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', description: '', industry: '', sector: '', country: 'KR', mainBusiness: '', competitors: [] }, quote: { price: 75_000, changeAmount: 0, changePercent: 0, volume: 0, marketCap: 0, week52High: 0, week52Low: 0 }, rating: { rating: 'HOLD', confidence: 50, score: 50 }, buyReasons: [], riskFactors: [], summary: '' });
    }
    if (/^\/api\/stocks\/[^/]+\/(?:financials|news|disclosures|risk|signals|analysis)$/.test(path)) {
      return json(route, { ok: true, annual: [], quarterly: [], rows: [], news: [], positive: [], negative: [], filings: [], disclosures: [], items: [], events: [], signals: [], buyReasons: [], sellReasons: [] });
    }
    if (path === '/api/market/scan') return json(route, { ok: true, results: [], count: 0, elapsedMs: 1 });
    if (path === '/api/trade-automation/status') return json(route, { policy: { mode: 'approval', automaticEnabled: false, emergencyStopped: false, exchangeEnabled: { bitget: false, upbit: false, kiwoom: false }, enabledAssets: { bitget: [], upbit: [], kiwoom: [] }, enabledStrategies: [], totalCapitalKrw: 1_000_000, maxOrderKrw: 100_000, dailyLossLimitPercent: 5, maxAssetPercent: 30, maxOpenPositions: 5, maxDailyOrders: 10, maxConsecutiveLosses: 3, bitgetLeverage: 2 }, connections: [], emergencyStopped: false, credentialVault: { encryptionConfigured: false, keyValueExposed: false }, lastOrder: null });
    if (path === '/api/config') return json(route, { providers: {}, mode: 'sample' });
    if (path.startsWith('/api/research')) return json(route, { ok: true, items: [], rows: [], results: [], status: 'ready' });
    if (path.startsWith('/api/portfolio')) return json(route, { ok: true, holdings: [], items: [], rows: [], proposals: [], scenarios: [] });
    if (path.startsWith('/api/paper')) return json(route, { ok: true, items: [], rows: [], positions: [], orders: [], trades: [], journal: [] });
    if (path.startsWith('/api/market-information/')) return json(route, { ok: true, sections: {}, requestPolicy: { privateExchangeRequests: 0, accountRequests: 0, balanceRequests: 0, positionRequests: 0, orderRequests: 0, cancelRequests: 0 } });
    return json(route, { ok: true, items: [], rows: [], results: [], quotes: [], cards: [], alerts: [], positions: [], orders: [], holdings: [] });
  });

  return state;
}

async function waitForFiniteRoute(page: Page, route: string) {
  await expect(page).toHaveURL(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\?', '\\?')));
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator('[aria-busy="true"]:visible')).toHaveCount(0, { timeout: 8_000 });
  await expect(page.locator('body')).toBeVisible();
}

async function loginThroughUi(page: Page) {
  await page.goto('/login');
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible();
  await page.locator('input[autocomplete="username"]').fill('full-product-admin');
  await page.locator('input[autocomplete="current-password"]').fill('browser-e2e-password');
  await page.locator('button[type="submit"]').click();
  await expect(page.getByText('로그인되었습니다.')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible();
}

async function seedAuthenticatedSession(page: Page) {
  const session = authSession();
  await page.addInitScript(({ storageKey, value }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  }, { storageKey: AUTH_STORAGE_KEY, value: session });
}

async function expectSearchOutcome(page: Page, query: string, expected: RegExp) {
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('');
  await input.fill(query);
  await expect(page.getByTestId('unified-search-outcome')).toContainText(expected, { timeout: 6_500 });
}

test.afterEach(async ({ page }, testInfo) => {
  const evidence = evidenceByPage.get(page);
  if (!evidence) return;
  const compact = {
    console: evidence.console,
    pageErrors: evidence.pageErrors,
    requestFailures: evidence.requestFailures,
    requests: evidence.requests.slice(-200),
    responses: evidence.responses.slice(-200),
  };
  await testInfo.attach('full-product-browser-evidence.json', {
    body: Buffer.from(JSON.stringify(compact, null, 2)),
    contentType: 'application/json',
  });
  expect(evidence.pageErrors, evidence.pageErrors.join('\n')).toEqual([]);
});

test('full product browser keeps one authenticated session from login through research reload and expiry', async ({ page }, testInfo) => {
  const evidence = installBrowserEvidence(page);
  const state = await installRuntime(page);

  await loginThroughUi(page);

  await page.goto('/stocks');
  await waitForFiniteRoute(page, '/stocks');
  const search = page.getByRole('combobox', { name: '통합 자산 검색' });
  await search.fill('삼성전자');
  const result = page.getByRole('option', { name: /삼성전자/ });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?/);
  await waitForFiniteRoute(page, '/stock-info/analysis');

  await page.goto('/ai-chart?market=KR&symbol=005930');
  await expect(page.getByRole('heading', { name: /AI 차트/, level: 1 })).toBeVisible({ timeout: 8_000 });
  await waitForFiniteRoute(page, '/ai-chart');

  await page.goto('/account');
  await waitForFiniteRoute(page, '/account');
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await expect(page.getByTestId('brokerage-account-connections')).toContainText('READ-ONLY');

  await page.goto('/portfolio');
  await waitForFiniteRoute(page, '/portfolio');

  await page.goto('/paper-trading');
  await waitForFiniteRoute(page, '/paper-trading');

  await page.goto('/research-center');
  await waitForFiniteRoute(page, '/research-center');
  const researchWorkspace = page.getByRole('navigation', { name: '연구센터 작업 영역' });
  await expect(researchWorkspace).toBeVisible();
  await expect(page.locator('input[autocomplete="username"]')).toHaveCount(0);
  await page.reload();
  await waitForFiniteRoute(page, '/research-center');
  await expect(researchWorkspace).toBeVisible();
  await expect(page.locator('input[autocomplete="username"]')).toHaveCount(0);

  state.sessionExpired = true;
  await page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) throw new Error('AUTH_STORAGE_MISSING_BEFORE_EXPIRY');
    const parsed = JSON.parse(raw);
    parsed.expires_at = 1;
    parsed.expires_in = 0;
    window.localStorage.setItem(storageKey, JSON.stringify(parsed));
  }, AUTH_STORAGE_KEY);
  await page.reload();
  await expect(researchWorkspace).toHaveCount(0);
  await expect(page.locator('input[autocomplete="username"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('input[autocomplete="current-password"]')).toBeVisible();

  const forbiddenWrites = evidence.requests.filter(({ method, path }) =>
    method !== 'GET'
    && method !== 'HEAD'
    && !path.includes('/auth/v1/token')
    && !path.includes('/auth/v1/logout')
    && /(?:order|cancel|amend|transfer|withdraw)/i.test(path));
  expect(forbiddenWrites, JSON.stringify(forbiddenWrites)).toEqual([]);
  const externalOrigins = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => new URL(entry.name, location.href).origin)
    .filter((origin) => origin !== location.origin));
  expect([...new Set(externalOrigins)], 'full-product mock E2E must not call external/private providers').toEqual([]);
  const unexpectedConsoleErrors = evidence.console
    .filter((item) => item.type === 'error')
    .filter((item) => !/401 \(Unauthorized\)|Failed to load resource/i.test(item.text));
  expect(unexpectedConsoleErrors, JSON.stringify(unexpectedConsoleErrors)).toEqual([]);

  await testInfo.attach('full-product-lifecycle.json', {
    body: Buffer.from(JSON.stringify({
      path: ['login', 'search', 'stock-detail', 'ai-chart', 'account', 'portfolio', 'paper-trading', 'research-center', 'reload', 'session-expiry'],
      databaseMutationRequired: false,
      privateProviderRequests: 0,
      realOrders: 0,
    }, null, 2)),
    contentType: 'application/json',
  });
});

test('current deep product routes render their intended authenticated surfaces', async ({ page }) => {
  installBrowserEvidence(page);
  await seedAuthenticatedSession(page);
  await installRuntime(page);

  const routes: Array<{ path: string; assertSurface: () => Promise<void> }> = [
    {
      path: '/research-center',
      assertSurface: async () => expect(page.getByRole('navigation', { name: '연구센터 작업 영역' })).toBeVisible(),
    },
    {
      path: '/position',
      assertSurface: async () => expect(page.locator('input[autocomplete="username"]')).toHaveCount(0),
    },
    {
      path: '/strategy-promotion',
      assertSurface: async () => expect(page.getByTestId('strategy-promotion-page')).toBeVisible(),
    },
    {
      path: '/news-information',
      assertSurface: async () => expect(page.getByRole('heading', { name: '테마', level: 1 })).toBeVisible(),
    },
    {
      path: '/admin/ui-layouts',
      assertSurface: async () => expect(page.getByTestId('ui-builder-layout-control')).toBeVisible(),
    },
  ];

  for (const item of routes) {
    await page.goto(item.path);
    await waitForFiniteRoute(page, item.path);
    await expect(page.locator('input[autocomplete="username"]'), `${item.path}: session unexpectedly fell back to login`).toHaveCount(0);
    await item.assertSurface();
  }
});

test('full product search fault matrix terminates safely across null timeout auth rate-limit server provider abort stale unmount and race cases', async ({ page }, testInfo) => {
  installBrowserEvidence(page);
  await seedAuthenticatedSession(page);
  const state = await installRuntime(page);
  await page.goto('/stocks');
  await waitForFiniteRoute(page, '/stocks');

  const matrix: Array<{ mode: SearchMode; expected: RegExp }> = [
    { mode: 'null', expected: /DATA_UNAVAILABLE/ },
    { mode: 'timeout', expected: /DATA_UNAVAILABLE/ },
    { mode: 'http401', expected: /DATA_UNAVAILABLE/ },
    { mode: 'http403', expected: /DATA_UNAVAILABLE/ },
    { mode: 'http429', expected: /DATA_UNAVAILABLE/ },
    { mode: 'http500', expected: /DATA_UNAVAILABLE/ },
    { mode: 'provider-unavailable', expected: /PROVIDER_UNAVAILABLE/ },
  ];
  const results: Array<{ mode: SearchMode; terminal: string }> = [];
  for (const item of matrix) {
    state.searchMode = item.mode;
    state.searchRequests = 0;
    const query = `fault-${item.mode}-${Date.now()}`;
    await expectSearchOutcome(page, query, item.expected);
    results.push({ mode: item.mode, terminal: await page.getByTestId('unified-search-outcome').innerText() });
  }

  state.searchMode = 'stale-race';
  state.searchRequests = 0;
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('삼성전자');
  await page.waitForTimeout(260);
  await input.fill('AAPL');
  await expect(page.getByRole('option', { name: /Apple/ })).toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole('option', { name: /삼성전자/ })).toHaveCount(0);
  results.push({ mode: 'stale-race', terminal: 'latest-response-wins' });

  state.searchMode = 'unmount-race';
  state.searchRequests = 0;
  await input.fill('삼성전자');
  await page.waitForTimeout(260);
  await page.goto('/account');
  await waitForFiniteRoute(page, '/account');
  await page.waitForTimeout(1_100);
  results.push({ mode: 'unmount-race', terminal: 'navigation-completed-with-pending-search-aborted' });

  state.searchMode = 'stale-race';
  state.searchRequests = 0;
  await page.goto('/stocks');
  await waitForFiniteRoute(page, '/stocks');
  const abortInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await abortInput.fill('삼성전자');
  await page.waitForTimeout(260);
  await abortInput.fill('Apple');
  await expect(page.getByRole('option', { name: /Apple/ })).toBeVisible({ timeout: 3_000 });
  results.push({ mode: 'stale-race', terminal: 'abort-and-replace-completed' });

  await testInfo.attach('full-product-fault-matrix.json', {
    body: Buffer.from(JSON.stringify({
      covered: ['null', 'timeout', 'abort', 'stale-response', '401', '403', '429', '500', 'provider-unavailable', 'unmount', 'race-condition'],
      results,
    }, null, 2)),
    contentType: 'application/json',
  });
});
