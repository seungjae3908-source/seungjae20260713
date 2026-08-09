import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-09T00:00:00.000Z';
const USER_ID = '66666666-6666-4666-8666-666666666666';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installRegularRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'regular-settings-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'regular-settings@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정회원 설정 검증' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = {
    tradeAutomationRequests: [] as string[],
    consoleErrors: [] as string[],
    pageErrors: [] as string[],
    unexpectedHttpErrors: [] as string[],
  };

  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      const path = new URL(response.url()).pathname;
      diagnostics.unexpectedHttpErrors.push(`${response.request().method()} ${path} ${response.status()}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'regular-settings',
        display_name: '정회원 설정 검증',
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
        email: 'regular-settings@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '정회원 설정 검증' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.startsWith('/api/trade-automation')) {
      diagnostics.tradeAutomationRequests.push(`${route.request().method()} ${path}`);
      return fulfill(route, { error: 'CAPABILITY_REQUIRED' }, 403);
    }
    if (path === '/api/backup/latest') {
      return fulfill(route, { ok: true, exists: false, itemCount: 0, updatedAt: null });
    }
    if (path === '/api/config') {
      return fulfill(route, {
        providers: { finnhub: false, alphavantage: false, dart: false, secEdgar: false },
        mode: 'sample',
      });
    }
    return fulfill(route, { ok: true });
  });

  return diagnostics;
}

test('regular settings never mounts or calls admin-only trade automation controls', async ({ page }) => {
  const diagnostics = await installRegularRuntime(page);

  await page.goto('/more');
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
  await expect(page.getByTestId('trade-automation-settings')).toHaveCount(0);
  await page.waitForLoadState('networkidle');

  expect(diagnostics.tradeAutomationRequests).toEqual([]);
  expect(diagnostics.consoleErrors).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.unexpectedHttpErrors).toEqual([]);
});
