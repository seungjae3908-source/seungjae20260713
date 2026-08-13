import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-13T03:00:00.000Z';
const USER_ID = '99999999-9999-4999-8999-999999999999';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installMember(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'toss-readonly-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'toss-readonly@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '토스 조회 회원' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'toss-readonly-member',
        display_name: '토스 조회 회원',
        role: 'member',
        status: 'approved',
        membership_level: 'regular',
        is_active: true,
        permissions_updated_at: NOW,
        updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'toss-readonly@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '토스 조회 회원' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });
}

async function installTossApi(page: Page) {
  let configured = false;
  let savedBody: unknown = null;
  let snapshotIntent = '';
  const mutatingProviderPaths: string[] = [];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/\/api\/v1\/(?:orders|cancel|modify|transfer|withdraw)/i.test(url.pathname)) {
      mutatingProviderPaths.push(`${request.method()} ${url.pathname}`);
    }
    if (url.pathname === '/api/account-connections/toss-readonly/status') {
      return fulfill(route, { ok: true, configured, updatedAt: configured ? NOW : null });
    }
    if (url.pathname === '/api/account-connections/toss-readonly/connection' && request.method() === 'POST') {
      configured = true;
      savedBody = request.postDataJSON();
      return fulfill(route, { ok: true, provider: 'toss', readOnly: true, configured: true, credentialsReturned: false, providerRequests: 0, orderRequests: 0, cancelRequests: 0 }, 201);
    }
    if (url.pathname === '/api/account-connections/toss-readonly/snapshot') {
      snapshotIntent = request.headers()['x-toss-readonly-intent'] ?? '';
      return fulfill(route, {
        ok: true,
        provider: 'toss',
        readOnly: true,
        connected: true,
        accounts: [{
          accountRef: '0123456789abcdef',
          accountMasked: '1******8',
          accountType: 'GENERAL',
          buyingPower: { KRW: 1500000, USD: 850.25 },
          summary: { marketValueKrw: 720000, marketValueUsd: 0, unrealizedPnlKrw: 20000, unrealizedPnlUsd: 0, profitRatePercent: 2.8571 },
          warnings: [],
          holdings: [{ symbol: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', quantity: 10, averagePrice: 70000, currentPrice: 72000, marketValue: 720000, unrealizedPnl: 20000, profitRatePercent: 2.8571 }],
        }],
        checkedAt: NOW,
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  return {
    get savedBody() { return savedBody; },
    get snapshotIntent() { return snapshotIntent; },
    mutatingProviderPaths,
  };
}

for (const width of [390, 1280]) {
  test(`Toss read-only account remains explicit and non-trading at ${width}px`, async ({ page }) => {
    await installMember(page);
    const api = await installTossApi(page);
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
    await page.goto('/account');
    const panel = page.getByTestId('toss-readonly-account');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('READ-ONLY');
    await expect(panel).toContainText('실주문 0');

    const clientId = 'TOSS_CLIENT_TEST_ONLY_123';
    const clientSecret = 'TOSS_SECRET_TEST_ONLY_456';
    await panel.getByPlaceholder('Client ID').fill(clientId);
    await panel.getByPlaceholder('Client Secret').fill(clientSecret);
    await panel.getByRole('button', { name: '연결 정보 저장' }).click();
    await expect(panel.getByRole('status')).toContainText('암호화 저장');
    await panel.getByRole('button', { name: '계좌 조회' }).click();

    await expect(page.getByTestId('toss-readonly-account-card')).toContainText('계좌 1******8');
    await expect(page.getByTestId('toss-readonly-account-card')).toContainText('삼성전자');
    expect(api.savedBody).toEqual({ clientId, clientSecret });
    expect(api.snapshotIntent).toBe('account-snapshot');
    expect(api.mutatingProviderPaths).toEqual([]);
    const visible = await page.locator('body').innerText();
    expect(visible).not.toContain(clientId);
    expect(visible).not.toContain(clientSecret);
    expect(visible).not.toContain('12345678');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
