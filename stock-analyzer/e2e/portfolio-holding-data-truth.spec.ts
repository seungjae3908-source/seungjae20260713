import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validatePortfolioHoldingRows } from '../src/lib/portfolio-holding-truth';
import { portfolioQuote, portfolioTotals } from '../src/lib/portfolio-valuation';

const VALID_ROW = {
  id: 'holding-1',
  ticker: '005930',
  market: 'KR',
  currency: 'KRW',
  quantity: 10,
  average_price: 78000,
} as const;
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const E2E_NOW = '2026-08-30T10:30:00.000Z';

test('portfolio valuation requires identified fresh source quotes and keeps native currencies separate', () => {
  const now = Date.parse(E2E_NOW);
  const quote = { ticker: VALID_ROW.ticker, market: VALID_ROW.market, currency: VALID_ROW.currency, price: 78000, changePercent: 0, source: 'fixture-only', updatedAt: E2E_NOW };
  expect(portfolioQuote(quote, VALID_ROW, now)).toMatchObject({ currentPrice: 78000, quoteStatus: 'FRESH' });
  for (const invalid of [undefined, { ...quote, price: true }, { ...quote, price: -1 }, { ...quote, ticker: 'AAPL' }, { ...quote, currency: 'USD' }, { ...quote, source: null }, { ...quote, updatedAt: null }, { ...quote, updatedAt: '2099-01-01T00:00:00Z' }]) {
    expect(portfolioQuote(invalid, VALID_ROW, now).currentPrice).toBeNull();
  }
  expect(portfolioQuote(quote, VALID_ROW, now + 300_001)).toMatchObject({ currentPrice: null, quoteStatus: 'STALE' });
  expect(portfolioQuote({ ...quote, freshness: { status: 'ARCHIVED' } }, VALID_ROW, now)).toMatchObject({ currentPrice: null, quoteStatus: 'ARCHIVED' });
  const us = { ...VALID_ROW, ticker: 'AAPL', market: 'US' as const, currency: 'USD' as const, quantity: 2, average_price: 100, currentPrice: 110 };
  const totals = portfolioTotals([{ ...VALID_ROW, currentPrice: null }, us]);
  expect(totals).toEqual([
    { currency: 'KRW', count: 1, cost: 780000, value: null, profit: null, rate: null },
    { currency: 'USD', count: 1, cost: 200, value: 220, profit: 20, rate: 10 },
  ]);
  expect(portfolioTotals([{ ...VALID_ROW, currentPrice: 78000 }])[0]).toMatchObject({ value: 780000, profit: 0, rate: 0 });
  expect(portfolioTotals([])).toEqual([]);
});

for (const [width, height] of [[1440, 900], [1024, 768], [320, 740], [360, 800], [390, 844], [412, 915], [430, 932]]) {
  test(`actual stock holdings show currency-separated facts and missing or stale quotes never become breakeven ${width}`, async ({ page }) => {
    const holdings = [
      { ...VALID_ROW, name: '삼성전자 검증', user_id: E2E_USER_ID, created_at: E2E_NOW },
      { ...VALID_ROW, id: 'holding-us', ticker: 'AAPL', name: 'Apple 검증', market: 'US', currency: 'USD', quantity: 2, average_price: 100, user_id: E2E_USER_ID, created_at: E2E_NOW },
    ];
    await installApprovedSessionWithInvalidHolding(page, holdings);
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    const mutations: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', (request) => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/')) mutations.push(request.method()); });
    let scenario = 'fresh';
    await page.route('**/api/**', (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/api/quotes') return fulfill(route, { dataStatus: scenario === 'missing' ? 'unavailable' : 'complete', quotes: scenario === 'missing' ? [] : [
        { ticker: '005930', market: 'KR', currency: 'KRW', price: 78000, changePercent: 0, source: 'fixture-only', updatedAt: scenario === 'stale' ? E2E_NOW : new Date().toISOString() },
        { ticker: 'AAPL', market: 'US', currency: 'USD', price: 110, changePercent: 0, source: 'fixture-only', updatedAt: new Date().toISOString() },
      ] });
      if (pathname === '/api/backup/latest') return fulfill(route, { ok: true, exists: false });
      return fulfill(route, { ok: true, items: [], rows: [], results: [] });
    });
    await page.goto('/portfolio?tab=holdings');
    const kr = page.getByTestId('portfolio-summary-KRW');
    const us = page.getByTestId('portfolio-summary-USD');
    await expect(kr).toContainText('780,000원');
    await expect(kr).toContainText('0.00%');
    await expect(us).toContainText('$220');
    await expect(us).toContainText('+10.00%');
    await expect(page.getByTestId('portfolio-holdings-summary')).not.toContainText('780,220');
    scenario = 'missing';
    await page.getByTestId('portfolio-holdings-summary').getByRole('button', { name: '새로고침' }).click();
    await expect(kr).toContainText('데이터 부족');
    await expect(us).toContainText('데이터 부족');
    await expect(kr).not.toContainText('0.00%');
    await expect(page.locator('body')).toContainText('시세 PROVIDER_UNAVAILABLE');
    scenario = 'stale';
    await page.getByTestId('portfolio-holdings-summary').getByRole('button', { name: '새로고침' }).click();
    await expect(kr).toContainText('데이터 부족');
    await expect(us).toContainText('$220');
    await expect(page.locator('body')).toContainText('시세 STALE');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect(errors).toEqual([]);
    expect(mutations).toEqual([]);
  });
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installApprovedSessionWithInvalidHolding(page: Page, holdings?: Array<Record<string, unknown>>) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'portfolio-truth-e2e-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Truth Admin' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: E2E_NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'portfolio-truth-admin',
        display_name: 'Portfolio Truth Admin',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: E2E_NOW,
        updated_at: E2E_NOW,
      });
    }
    if (url.pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Portfolio Truth Admin' },
        identities: [],
        created_at: E2E_NOW,
      });
    }
    if (url.pathname.endsWith('/rest/v1/portfolio_holdings')) {
      return fulfill(route, holdings ?? [{
        id: 'broken-holding',
        user_id: E2E_USER_ID,
        ticker: '005930',
        name: '삼성전자',
        market: 'KR',
        currency: 'KRW',
        average_price: 78000,
        created_at: E2E_NOW,
      }]);
    }
    return fulfill(route, { ok: true });
  });
}

async function installGlobalReadOnlyShellFixtures(page: Page) {
  await page.route('**/api/watchlist**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/watchlist') {
      return fulfill(route, { ok: true, items: [] });
    }
    return route.continue();
  });

  await page.route('**/api/backup/latest**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/api/backup/latest') {
      return fulfill(route, { ok: true, exists: false });
    }
    return route.continue();
  });
}

test('portfolio holding truth accepts explicit finite positive numeric facts', () => {
  expect(validatePortfolioHoldingRows([VALID_ROW])).toEqual({ ok: true });
  expect(validatePortfolioHoldingRows([{
    ...VALID_ROW,
    id: 'holding-us',
    ticker: 'AAPL',
    market: 'US',
    currency: 'USD',
    quantity: '2.5',
    average_price: '240.10',
  }])).toEqual({ ok: true });
});

test('portfolio holding truth never converts missing or invalid quantity to zero', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 'not-a-number' }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity: 0 }])).toEqual({
    ok: false,
    code: 'INVALID_QUANTITY',
    rowIndex: 0,
  });
});

test('portfolio holding truth rejects missing or impossible average price', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: null }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, average_price: -1 }])).toEqual({
    ok: false,
    code: 'INVALID_AVERAGE_PRICE',
    rowIndex: 0,
  });
});

test('duplicate holding row identity and coerced numeric values fail closed while distinct purchase lots remain valid', () => {
  expect(validatePortfolioHoldingRows([VALID_ROW, VALID_ROW])).toEqual({ ok: false, code: 'DUPLICATE_IDENTITY', rowIndex: 1 });
  expect(validatePortfolioHoldingRows([VALID_ROW, { ...VALID_ROW, id: 'separate-lot' }])).toEqual({ ok: true });
  for (const quantity of [true, [], '0x10', '1e1000', '']) expect(validatePortfolioHoldingRows([{ ...VALID_ROW, quantity }]).ok).toBe(false);
});

test('portfolio chart cache binds the authenticated member and never generates purchase dates or refreshes quote time', async ({ page }) => {
  await installApprovedSessionWithInvalidHolding(page, []);
  await page.route('**/api/**', (route) => fulfill(route, new URL(route.request().url()).pathname === '/api/backup/latest'
    ? { ok: true, exists: false } : { ok: true, items: [], rows: [], results: [] }));
  await page.goto('/account');
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  const result = await page.evaluate(async () => {
    const modulePath = performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => new URL(url).pathname === '/src/lib/portfolio-overlay.ts').at(-1);
    if (!modulePath) throw new Error('Actual AuthProvider overlay module was not loaded');
    const overlay = await import(modulePath) as typeof import('../src/lib/portfolio-overlay');
    const row = { ticker: '005930', name: 'fixture', market: 'KR' as const, currency: 'KRW' as const, average_price: 100, quantity: 2, currentPrice: 110, created_at: '2020-01-01T00:00:00Z' };
    overlay.syncPortfolioChartOverlays([row]);
    const unknownQuote = overlay.getPortfolioChartOverlay('005930');
    overlay.rememberPurchaseDate('005930', '2026-02-30');
    const invalidDate = overlay.getRememberedPurchaseDate('005930');
    overlay.rememberPurchaseDate('005930', '2026-08-01');
    overlay.syncPortfolioChartOverlays([{ ...row, updatedAt: new Date().toISOString() }]);
    const current = overlay.getPortfolioChartOverlay('005930');
    overlay.setPortfolioOverlayMember('different-fixture-user');
    const otherMember = overlay.getPortfolioChartOverlay('005930');
    const otherDate = overlay.getRememberedPurchaseDate('005930');
    overlay.setPortfolioOverlayMember('22222222-2222-4222-8222-222222222222');
    overlay.syncPortfolioChartOverlays([{ ...row, updatedAt: '2020-01-01T00:00:00Z' }]);
    const oldQuote = overlay.getPortfolioChartOverlay('005930');
    const cache = JSON.parse(localStorage.getItem('sa-portfolio-chart-overlays-v1')!);
    return { unknownQuote, invalidDate, current, otherMember, otherDate, oldQuote, owner: cache.memberId, modulePath };
  });
  expect(result.unknownQuote).toMatchObject({ purchaseDate: '', currentPrice: null, rate: null, quoteUpdatedAt: null });
  expect(result.invalidDate).toBe('');
  expect(result.current).toMatchObject({ purchaseDate: '2026-08-01', currentPrice: 110, rate: 10 });
  expect(result.otherMember).toBeNull();
  expect(result.otherDate).toBe('');
  expect(result.oldQuote).toMatchObject({ currentPrice: null, rate: null, quoteUpdatedAt: '2020-01-01T00:00:00Z' });
  expect(result.owner).toBe(E2E_USER_ID);
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').map((entry) => entry.name)
      .filter((url) => new URL(url).pathname === '/src/lib/supabase.ts').at(-1);
    if (!path) throw new Error('Actual auth transport was not loaded');
    const { getSupabase } = await import(path) as typeof import('../src/lib/supabase');
    await getSupabase().auth.signOut({ scope: 'local' });
  });
  await expect.poll(() => page.evaluate(async (path) => {
    const { loadPortfolioChartOverlays } = await import(path) as typeof import('../src/lib/portfolio-overlay');
    return loadPortfolioChartOverlays().length;
  }, result.modulePath)).toBe(0);
});

test('portfolio holding truth rejects guessed market or currency identity', () => {
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: undefined }])).toEqual({
    ok: false,
    code: 'INVALID_MARKET',
    rowIndex: 0,
  });
  expect(validatePortfolioHoldingRows([{ ...VALID_ROW, market: 'US', currency: 'KRW' }])).toEqual({
    ok: false,
    code: 'INVALID_CURRENCY',
    rowIndex: 0,
  });
});

test('Supabase boundary validates only canonical full-row portfolio reads', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("requestMethod(input, init) !== 'GET'");
  expect(source).toContain("pathname.endsWith('/rest/v1/portfolio_holdings')");
  expect(source).toContain("parsed?.searchParams.get('select') === '*'");
  expect(source).toContain('validatePortfolioHoldingRows(payload)');
  expect(source).toContain('PORTFOLIO_HOLDING_DATA_INVALID');
  expect(source).toContain('status: 422');
});

test('partial portfolio selects remain outside the full-row truth guard', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/supabase.ts'), 'utf8');
  expect(source).toContain("pathname.endsWith('/rest/v1/portfolio_holdings')");
  expect(source).toContain("return parsed?.searchParams.get('select') === '*';");
  expect(source).not.toContain("return pathname.endsWith('/rest/v1/portfolio_holdings');");
});

test('portfolio holdings UI never presents load failure as zero-valued portfolio facts', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/pages/portfolio.tsx'), 'utf8');
  expect(source).toContain('data-testid="portfolio-holdings-summary"');
  expect(source).toContain('!loading &&');
  expect(source).toContain('initialized &&');
  expect(source).toContain('!error &&');
  expect(source).toContain('disabled={loading || Boolean(error)}');
});

test('malformed holding fails closed on the real portfolio holdings route without zero summary or private calls', async ({ page }) => {
  await installApprovedSessionWithInvalidHolding(page);
  await installGlobalReadOnlyShellFixtures(page);

  const consoleErrors: string[] = [];
  const quoteRequests: string[] = [];
  const forbiddenRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/quotes') quoteRequests.push(request.url());
    if (/\/(orders?|cancel|withdraw|transfer)(?:\/|$)/i.test(url.pathname)
      || /\/api\/crypto\/(?:spot\/accounts|futures\/(?:account|positions))(?:\/|$)/i.test(url.pathname)) {
      forbiddenRequests.push(`${request.method()} ${url.pathname}`);
    }
  });

  await page.goto('/portfolio?tab=holdings');

  await expect(page.getByText(/포트폴리오 원본 데이터의 시장·통화·수량·평단/)).toBeVisible();
  await expect(page.getByTestId('portfolio-holdings-summary')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '보유 종목 추가' })).toBeDisabled();
  expect(quoteRequests).toEqual([]);
  expect(forbiddenRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
