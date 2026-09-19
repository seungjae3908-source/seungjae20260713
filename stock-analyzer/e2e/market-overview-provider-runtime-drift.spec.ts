import { test, expect, type Page, type Route } from '@playwright/test';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installSession(page: Page) {
  await page.addInitScript(({ storageKey, userId }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: userId,
      role: 'authenticated',
      exp: expiresAt,
    })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'runtime-drift-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'runtime-drift-market@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Runtime Drift Market' },
        identities: [],
        created_at: new Date().toISOString(),
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID });
}

async function installProviderOutageMocks(page: Page) {
  await installSession(page);

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'runtime-drift-market',
        display_name: 'Runtime Drift Market',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: now,
        updated_at: now,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'runtime-drift-market@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Runtime Drift Market' },
        identities: [],
        created_at: now,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const now = new Date().toISOString();

    if (url.pathname === '/api/market/summary') {
      return fulfill(route, {
        ok: true,
        items: [
          { key: 'kospi', label: 'KOSPI', ok: true, price: 2800, changePercent: 0.5 },
          { key: 'kosdaq', label: 'KOSDAQ', ok: true, price: 900, changePercent: -0.2 },
        ],
        dataState: 'ready',
        updatedAt: now,
      });
    }

    if (url.pathname === '/api/market/sector-popular') {
      return fulfill(route, {
        ok: false,
        market: 'KR',
        provider: 'public-market-providers',
        sortBasis: '거래대금 기준',
        sectors: [],
        updatedAt: now,
        available: false,
        partial: false,
        dataState: 'provider_error',
        retryable: true,
        error: 'SECTOR_POPULAR_PROVIDER_UNAVAILABLE',
        errorCode: 'SECTOR_POPULAR_PROVIDER_EVIDENCE_UNAVAILABLE',
        message: 'provider unavailable fixture',
      });
    }

    if (url.pathname === '/api/market/briefing') {
      return fulfill(route, {
        asOf: now,
        mood: 'neutral',
        headline: '시장 근거 확인 중',
        lines: [],
        strongSectors: [],
        weakSectors: [],
        positiveNews: [],
        negativeNews: [],
        disclosureRisks: [],
        gainers: [],
        losers: [],
        picks: [],
      });
    }

    if (url.pathname === '/api/notifications/price-alerts') {
      return fulfill(route, { alerts: [] });
    }

    if (url.pathname === '/api/watchlist/sync') {
      return fulfill(route, { ok: true, items: [] });
    }

    return fulfill(route, { ok: true });
  });
}

test('market overview provider outage fails closed without HTTP 5xx or console drift', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  await page.setViewportSize({ width: 390, height: 844 });
  await installProviderOutageMocks(page);

  const sectorResponse = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === '/api/market/sector-popular';
    } catch {
      return false;
    }
  });

  await page.goto('/market-overview');
  await expect(page.getByTestId('market-overview-page')).toBeVisible();

  const response = await sectorResponse;
  expect(response.status()).toBe(200);

  await page.getByRole('button', { name: '섹터', exact: true }).click();
  const section = page.getByTestId('market-overview-sectors');
  await expect(section.getByText('섹터 확인 실패')).toBeVisible();
  await expect(section.getByText('섹터 데이터 없음')).toHaveCount(0);

  expect(errors).toEqual([]);
});
