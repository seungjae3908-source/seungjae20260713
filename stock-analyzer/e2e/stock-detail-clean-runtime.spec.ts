import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-08-15T06:40:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

const candles = Array.from({ length: 40 }, (_, index) => ({
  time: new Date(Date.UTC(2026, 7, 14, 0, index * 15)).toISOString(),
  open: 74_000 + index * 5,
  high: 74_150 + index * 5,
  low: 73_900 + index * 5,
  close: 74_050 + index * 5,
  volume: 100_000 + index * 1_000,
  isClosed: index < 39,
}));

async function installApprovedSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'stock-detail-clean-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'stock-detail@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Stock Detail Admin' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/rest/v1/profiles')
      ? { id: E2E_USER_ID, login_name: 'stock-detail-admin', display_name: 'Stock Detail Admin', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW }
      : path.endsWith('/auth/v1/user')
        ? { id: E2E_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'stock-detail@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Stock Detail Admin' }, identities: [], created_at: NOW }
        : path.endsWith('/rest/v1/portfolio_holdings')
          ? []
          : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function mockDetail(page: Page, requests: string[]) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname);
    if (url.pathname === '/api/stocks/005930/quote') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          name: '삼성전자',
          price: 74_500,
          changePercent: 1.2,
          currency: 'KRW',
          exchange: 'KOSPI',
        }),
      });
      return;
    }
    if (url.pathname === '/api/stocks/005930/profile') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          name: '삼성전자',
          sector: '반도체',
          exchange: 'KOSPI',
          marketCap: 450_000_000_000_000,
        }),
      });
      return;
    }
    if (url.pathname === '/api/stocks/005930/news') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          news: [{
            title: '삼성전자 공개 시장 뉴스',
            summary: '종목 상세 뉴스 탭의 지연 로딩 검증용 공개 데이터입니다.',
            source: 'fixture',
            publishedAt: NOW,
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/api/stocks/005930/chart') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ticker: '005930',
          timeframe: url.searchParams.get('timeframe') ?? '1D',
          provider: 'fixture',
          fetchedAt: NOW,
          candles,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 960 },
] as const) {
  test(`clean stock detail loads summary first and optional tabs on demand at ${viewport.width}px`, async ({ page }) => {
    const requests: string[] = [];
    await page.setViewportSize(viewport);
    await installApprovedSession(page);
    await mockDetail(page, requests);
    await page.goto('/stock-info/analysis?back=%2Fstocks&asset=stock&market=KR&ticker=005930');

    await expect(page.getByRole('heading', { name: '삼성전자', exact: true })).toBeVisible();
    const tabs = page.getByTestId('stock-detail-tabs');
    await expect(tabs.getByRole('tab')).toHaveCount(4);
    await expect(page.getByText('74,500원', { exact: true })).toBeVisible();
    await expect(page.getByText('반도체', { exact: true })).toBeVisible();
    expect(requests).toContain('/api/stocks/005930/quote');
    expect(requests).toContain('/api/stocks/005930/profile');
    expect(requests).not.toContain('/api/stocks/005930/news');
    expect(requests).not.toContain('/api/stocks/005930/chart');

    await tabs.getByRole('tab', { name: 'AI 차트 분석기', exact: true }).click();
    await expect(page.getByRole('heading', { name: /AI 차트 생중계/ })).toBeVisible();
    await expect.poll(() => requests.filter((path) => path === '/api/stocks/005930/chart').length).toBeGreaterThan(0);

    await tabs.getByRole('tab', { name: '뉴스', exact: true }).click();
    await expect(page.getByText('삼성전자 공개 시장 뉴스', { exact: true })).toBeVisible();
    await expect.poll(() => requests.filter((path) => path === '/api/stocks/005930/news').length).toBe(1);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  });
}
