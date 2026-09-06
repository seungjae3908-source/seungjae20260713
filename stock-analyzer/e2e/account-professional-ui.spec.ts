import { expect, test, type Page, type Route } from '@playwright/test';

const USER = '99999999-9999-4999-8999-999999999999';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-06T09:20:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installRuntime(page: Page) {
  await page.addInitScript(({ authKey, user, now }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`,
      refresh_token: 'account-professional-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-professional@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '전문 UI 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { authKey: AUTH_KEY, user: USER, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER,
        login_name: 'account-professional-admin',
        display_name: '전문 UI 관리자',
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
        id: USER,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-professional@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '전문 UI 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/api/accounts/read-only/')) {
      const provider = pathname.split('/').at(-1);
      if (route.request().method() === 'GET') {
        return fulfill(route, {
          provider,
          readOnly: true,
          connected: false,
          status: 'NOT_CONFIGURED',
          accounts: [],
          balances: [],
          positions: [],
          openOrders: [],
          checkedAt: NOW,
          lastGoodAt: null,
          stale: false,
          errorCode: 'ACCOUNT_NOT_CONFIGURED',
          orderRequests: 0,
          cancelRequests: 0,
          amendRequests: 0,
          transferRequests: 0,
          withdrawalRequests: 0,
          credentialsReturned: false,
          liveTradingEnabled: false,
          autoTradingEnabled: false,
        });
      }
    }
    if (pathname === '/api/user-integrations') {
      return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [], alerts: [], notifications: [] });
  });
}

for (const width of [320, 390, 768, 1200]) {
  test(`account professional surface stays bounded at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
    await installRuntime(page);
    await page.goto('/account');

    await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '실계좌 조회 연결', exact: true })).toBeVisible();
    await expect(page.getByText('조회 전용 · 주문·취소·이체·출금 없음', { exact: true })).toBeVisible();
    await expect(page.getByText('READ-ONLY', { exact: false })).toHaveCount(0);

    const overflow = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);

    const cards = page.locator('[data-testid^="connection-"]');
    await expect(cards).toHaveCount(3);
    for (const card of await cards.all()) {
      const box = await card.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
    }
  });
}

test('account keeps detailed read-only evidence behind an explicit disclosure', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/account');

  const details = page.getByTestId('account-readonly-safety-details');
  await expect(details).toBeVisible();
  await expect(page.getByText('실주문/취소/이체/출금 요청 0건', { exact: false })).toBeHidden();
  await details.getByText('보안·권한 상세', { exact: true }).click();
  await expect(page.getByText('실주문/취소/이체/출금 요청 0건', { exact: false })).toBeVisible();
  await expect(page.getByText('Secret 원문 응답 0건', { exact: false })).toBeVisible();
});

test('account connection dialog remains inside a compact mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await installRuntime(page);
  await page.goto('/account');

  await page.getByRole('button', { name: 'Toss 연결 설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Toss 조회 연결 설정' });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(741);
  await expect(page.getByRole('button', { name: '조회 전용 키 저장', exact: true })).toBeVisible();
});
