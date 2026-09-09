import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '33333333-3333-4333-8333-333333333333';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

type QuoteMode = 'valid' | 'malformed' | 'http500';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSession(page: Page) {
  await page.addInitScript(({ storageKey, userId }) => {
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
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 QA' },
        identities: [],
        created_at: new Date().toISOString(),
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID });
}

function profile(now: string) {
  return {
    id: E2E_USER_ID,
    login_name: 'portfolio-truth',
    display_name: '포트폴리오 QA',
    role: 'admin',
    status: 'approved',
    membership_level: 'admin',
    is_active: true,
    permissions_updated_at: now,
    updated_at: now,
  };
}

function holding() {
  return {
    id: 'holding-1',
    user_id: E2E_USER_ID,
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    quantity: 1,
    average_price: 70000,
    purchase_date: '2026-09-01',
    created_at: '2026-09-01T00:00:00.000Z',
  };
}

function unifiedSearchPayload(q: string, now: string) {
  return {
    ok: true,
    state: 'FULL',
    q,
    asset: 'stock',
    market: 'KR',
    results: [{
      id: 'KR:005930',
      assetType: 'stock',
      market: 'KR',
      instrumentType: 'stock',
      exchange: 'KRX',
      ticker: '005930',
      productCode: '005930',
      koreanName: '삼성전자',
      englishName: 'Samsung Electronics',
      displayName: '삼성전자',
      baseSymbol: '005930',
      quoteCurrency: 'KRW',
      matchType: 'exact',
      active: true,
      provider: 'E2E',
      dataAsOf: now,
    }],
    count: 1,
    dataAsOf: now,
    stale: false,
    partial: false,
    providers: [{ provider: 'E2E', status: 'ok', count: 1, dataAsOf: now }],
    hiddenMatches: [],
  };
}

async function installMocks(page: Page, options: { quoteMode: QuoteMode; holdings?: unknown[]; seenApiPaths?: string[] }) {
  await installSession(page);
  const holdings = options.holdings ?? [holding()];

  await page.route('**/__e2e-supabase/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const now = new Date().toISOString();
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, profile(now));
    if (path.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'portfolio-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '포트폴리오 QA' },
        identities: [],
        created_at: now,
      });
    }
    if (path.endsWith('/rest/v1/portfolio_holdings')) {
      if (route.request().method() === 'GET') return fulfill(route, holdings);
      if (route.request().method() === 'POST') return fulfill(route, [], 201);
      return fulfill(route, [], 204);
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    options.seenApiPaths?.push(path);
    if (path === '/api/quotes') {
      if (options.quoteMode === 'http500') return fulfill(route, { error: 'provider unavailable' }, 500);
      if (options.quoteMode === 'malformed') return fulfill(route, { ok: true });
      return fulfill(route, { quotes: [{ ticker: '005930', price: 72000, changePercent: 1.25 }] });
    }
    if (path === '/api/search/suggest') {
      return fulfill(route, unifiedSearchPayload(url.searchParams.get('q') ?? '', new Date().toISOString()));
    }
    return fulfill(route, { ok: true });
  });
}

async function openPosition(page: Page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/position');
  await expect(page.getByText('내 포트폴리오')).toBeVisible({ timeout: 15_000 });
}

test('malformed quote HTTP 200 cannot become safe-looking zero profit', async ({ page }) => {
  await installMocks(page, { quoteMode: 'malformed' });
  await openPosition(page);
  await expect(page.getByText('일부 보유 종목의 현재가 근거를 확인하지 못했습니다. 평가손익은 표시하지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('portfolio-holdings-summary')).toHaveCount(0);
  await expect(page.getByText('+0원 · 0.00%')).toHaveCount(0);
});

test('quote provider 500 fails closed instead of substituting average price', async ({ page }) => {
  await installMocks(page, { quoteMode: 'http500' });
  await openPosition(page);
  await expect(page.getByText('일부 보유 종목의 현재가 근거를 확인하지 못했습니다. 평가손익은 표시하지 않습니다.')).toBeVisible();
  await expect(page.getByTestId('portfolio-holdings-summary')).toHaveCount(0);
});

test('canonical quote evidence renders the actual current valuation', async ({ page }) => {
  await installMocks(page, { quoteMode: 'valid' });
  await openPosition(page);
  const summary = page.getByTestId('portfolio-holdings-summary');
  await expect(summary).toBeVisible();
  await expect(summary.getByText('72,000')).toBeVisible();
  await expect(page.getByText('일부 보유 종목의 현재가 근거를 확인하지 못했습니다. 평가손익은 표시하지 않습니다.')).toHaveCount(0);
});

test('portfolio name resolution uses only the canonical unified search route', async ({ page }) => {
  const seenApiPaths: string[] = [];
  await installMocks(page, { quoteMode: 'valid', holdings: [], seenApiPaths });
  await openPosition(page);
  await page.getByRole('button', { name: '보유 종목 추가' }).click();
  await page.getByPlaceholder('예: 삼성전자').fill('삼성전자');
  await page.getByPlaceholder('수량').fill('1');
  await page.getByPlaceholder('매수가').fill('70000');
  await page.getByRole('button', { name: '보유 종목 저장' }).click();
  await expect.poll(() => seenApiPaths.filter((path) => path.includes('/api/search')).join(',')).toBe('/api/search/suggest');
  expect(seenApiPaths).not.toContain('/api/search');
  expect(seenApiPaths).not.toContain('/api/stocks/search');
  expect(seenApiPaths).not.toContain('/api/stock/search');
  expect(seenApiPaths).not.toContain('/api/stocks');
});
