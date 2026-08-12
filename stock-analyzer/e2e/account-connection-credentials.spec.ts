import { test, expect, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-09T00:00:00.000Z';
const USER_ID = '88888888-8888-4888-8888-888888888888';
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
      refresh_token: 'account-link-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'account-link@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '계좌연동 회원' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], forbiddenTradeMutations: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/(?:order|orders|cancel|transfer|withdraw|deposit)(?:\/|$)/i.test(path) && request.method() !== 'GET') {
      diagnostics.forbiddenTradeMutations.push(`${request.method()} ${path}`);
    }
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'account-link-member',
        display_name: '계좌연동 회원',
        role: 'user',
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
        email: 'account-link@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '계좌연동 회원' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  return {
    diagnostics,
    assertClean() {
      expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.forbiddenTradeMutations, diagnostics.forbiddenTradeMutations.join('\n')).toEqual([]);
    },
  };
}

test('approved member can save self-scoped Upbit credentials without exposing secret values', async ({ page }) => {
  const { assertClean } = await installMember(page);
  let savedBody: Record<string, unknown> | null = null;
  let snapshotReads = 0;

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/trade-automation/account-connections/snapshot') {
      snapshotReads += 1;
      return fulfill(route, {
        ok: true,
        readOnly: true,
        mutationsAllowed: false,
        credentialsReturned: false,
        checkedAt: NOW,
        providers: {
          toss: { configured: false, connected: false, credentialSource: 'none', connectionState: 'WAITING_FOR_TOSS_API_ACCESS', accounts: [], holdingCount: 0, holdings: [], error: 'TOSS_API_ACCESS_REQUIRED' },
          kiwoom: { configured: false, connected: false, credentialSource: 'none', error: 'KIWOOM_NOT_CONFIGURED' },
          upbit: { configured: snapshotReads > 1, connected: snapshotReads > 1, credentialSource: snapshotReads > 1 ? 'vault' : 'none', assetCount: 0, assets: [], error: snapshotReads > 1 ? null : 'UPBIT_NOT_CONFIGURED' },
          bitget: { configured: false, connected: false, credentialSource: 'none', accounts: [], positions: [], error: 'BITGET_NOT_CONFIGURED' },
        },
      });
    }
    if (url.pathname === '/api/trade-automation/connections/upbit' && route.request().method() === 'PUT') {
      savedBody = route.request().postDataJSON() as Record<string, unknown>;
      return fulfill(route, {
        exchange: 'upbit',
        accountMode: 'live',
        configured: true,
        credentialsReturned: false,
        lastVerifiedAt: NOW,
        lastErrorCode: null,
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/account');
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await page.getByRole('button', { name: 'Upbit 연결 설정' }).click();

  const accessKey = 'UPBIT_ACCESS_TEST_ONLY_123';
  const secretKey = 'UPBIT_SECRET_TEST_ONLY_456';
  await page.getByTestId('upbit-credential-primary').fill(accessKey);
  await page.getByTestId('upbit-credential-secret').fill(secretKey);
  await page.getByTestId('upbit-save-connection').click();

  await expect(page.getByRole('status')).toContainText('암호화 저장');
  await expect(page.getByTestId('connection-upbit')).toContainText('암호화 저장소 사용');
  await expect(page.getByTestId('connection-upbit')).toContainText('연결됨');

  expect(savedBody).toEqual({
    accountMode: 'live',
    credentials: { accessKey, secretKey },
    permissions: ['read'],
  });
  expect(await page.locator('body').innerText()).not.toContain(accessKey);
  expect(await page.locator('body').innerText()).not.toContain(secretKey);
  assertClean();
});

test('Toss, Bitget and Kiwoom setup forms remain inside mobile viewport', async ({ page }) => {
  const { assertClean } = await installMember(page);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/trade-automation/account-connections/snapshot') {
      return fulfill(route, {
        ok: true, readOnly: true, mutationsAllowed: false, credentialsReturned: false, checkedAt: NOW,
        providers: {
          toss: { configured: false, connected: false, credentialSource: 'none', connectionState: 'WAITING_FOR_TOSS_API_ACCESS', accounts: [], holdingCount: 0, holdings: [] },
          kiwoom: { configured: false, connected: false, credentialSource: 'none' },
          upbit: { configured: false, connected: false, credentialSource: 'none', assets: [] },
          bitget: { configured: false, connected: false, credentialSource: 'none', accounts: [], positions: [] },
        },
      });
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/account');
  for (const name of ['Toss Securities 연결 설정', 'Kiwoom 연결 설정', 'Bitget 연결 설정']) {
    await page.getByRole('button', { name }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(361);
    await page.getByRole('button', { name: '연결 설정 닫기' }).click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);
  assertClean();
});
