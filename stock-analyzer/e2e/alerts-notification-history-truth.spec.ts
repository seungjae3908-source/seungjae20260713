import { expect, test, type Page } from '@playwright/test';

const NOW = '2026-09-09T05:30:00.000Z';
const E2E_USER_ID = '33333333-3333-4333-8333-333333333333';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

async function installApprovedSession(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'alerts-truth-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'alerts-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Alerts QA Admin' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/rest/v1/profiles')
      ? { id: E2E_USER_ID, login_name: 'alerts-qa-admin', display_name: 'Alerts QA Admin', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW }
      : path.endsWith('/auth/v1/user')
        ? { id: E2E_USER_ID, aud: 'authenticated', role: 'authenticated', email: 'alerts-truth@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: 'Alerts QA Admin' }, identities: [], created_at: NOW }
        : path.endsWith('/rest/v1/portfolio_holdings')
          ? []
          : { ok: true };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function mockAlerts(page: Page, historyBody: unknown, marketBody?: unknown) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/notifications/history') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyBody) });
      return;
    }
    if (url.pathname === '/api/market/alerts' && marketBody !== undefined) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(marketBody) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('canonical empty notification history stays empty instead of becoming an error', async ({ page }) => {
  await installApprovedSession(page);
  await mockAlerts(page, { notifications: [], count: 0 });
  await page.goto('/alerts');

  await expect(page.getByTestId('alerts-page')).toBeVisible();
  await expect(page.getByText('저장된 알림이 없습니다.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('error-state')).toHaveCount(0);
});

test('malformed notification history HTTP 200 fails closed instead of looking canonically empty', async ({ page }) => {
  await installApprovedSession(page);
  await mockAlerts(page, {});
  await page.goto('/alerts');

  await expect(page.getByTestId('alerts-page')).toBeVisible();
  await expect(page.getByTestId('error-state')).toBeVisible();
  await expect(page.getByText('데이터를 불러오지 못했습니다', { exact: true })).toBeVisible();
  await expect(page.getByText('저장된 알림이 없습니다.', { exact: true })).toHaveCount(0);
});

test('future notification timestamp HTTP 200 fails closed instead of being displayed as recent', async ({ page }) => {
  await installApprovedSession(page);
  await mockAlerts(page, {
    notifications: [{
      id: '11111111-1111-4111-8111-111111111111',
      notification_type: 'price_alert',
      title: '지정가 도달',
      body: '미래 시각은 최신 알림으로 표시되면 안 됩니다.',
      url: null,
      channel: 'web',
      read_at: null,
      created_at: '2099-01-01T00:00:00.000Z',
    }],
    count: 1,
  });
  await page.goto('/alerts');

  await expect(page.getByTestId('error-state')).toBeVisible();
  await expect(page.getByText('지정가 도달', { exact: true })).toHaveCount(0);
  await expect(page.getByText('방금', { exact: true })).toHaveCount(0);
});

test('malformed market alert HTTP 200 fails closed instead of looking canonically empty', async ({ page }) => {
  await installApprovedSession(page);
  await mockAlerts(page, { notifications: [], count: 0 }, { positive: [], negative: [] });
  await page.goto('/alerts');
  await page.getByRole('button', { name: /시장 신호/ }).click();

  await expect(page.getByTestId('error-state')).toBeVisible();
  await expect(page.getByText('표시할 신호가 없습니다.', { exact: true })).toHaveCount(0);
});

test('future market alert timestamp HTTP 200 fails closed instead of being displayed as recent', async ({ page }) => {
  await installApprovedSession(page);
  const row = {
    id: 'KR:005930:movement',
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    kind: 'positive',
    category: '시세 변동',
    title: '삼성전자 상승 1.20%',
    importance: 'high',
    time: '2099-01-01T00:00:00.000Z',
    url: null,
  };
  await mockAlerts(page, { notifications: [], count: 0 }, {
    market: 'ALL',
    positive: [row],
    negative: [],
    alerts: [row],
    updatedAt: new Date().toISOString(),
  });
  await page.goto('/alerts');
  await page.getByRole('button', { name: /시장 신호/ }).click();

  await expect(page.getByTestId('error-state')).toBeVisible();
  await expect(page.getByText('삼성전자 상승 1.20%', { exact: true })).toHaveCount(0);
  await expect(page.getByText('방금', { exact: true })).toHaveCount(0);
});
