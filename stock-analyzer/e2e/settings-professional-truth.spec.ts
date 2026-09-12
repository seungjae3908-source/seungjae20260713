import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-06T09:30:00.000Z';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

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
      refresh_token: 'settings-professional-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'settings-professional@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '설정 QA 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { authKey: AUTH_KEY, user: USER, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) return fulfill(route, {
      id: USER,
      login_name: 'settings-professional-admin',
      display_name: '설정 QA 관리자',
      role: 'admin',
      status: 'approved',
      membership_level: 'admin',
      is_active: true,
      permissions_updated_at: NOW,
      updated_at: NOW,
    });
    if (pathname.endsWith('/auth/v1/user')) return fulfill(route, {
      id: USER,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'settings-professional@accounts.invalid',
      app_metadata: { provider: 'email', providers: ['email'] },
      user_metadata: { display_name: '설정 QA 관리자' },
      identities: [],
      created_at: NOW,
    });
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => fulfill(route, {
    ok: true,
    items: [],
    rows: [],
    results: [],
    alerts: [],
    notifications: [],
  }));
}

test('settings source never fabricates Telegram disconnected state without account evidence', () => {
  const settings = source('src/pages/more.tsx');
  expect(settings).not.toContain("status: '미연결'");
  expect(settings).not.toContain('텔레그램 미연결');
  expect(settings).toContain('연결 상태는 사용자 계정의 실제 연동 정보를 기준으로 확인합니다.');
  expect(settings).toContain('텔레그램 연결 확인');
});

for (const width of [320, 390, 768, 1200]) {
  test(`settings hub cards stay bounded and centered at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width >= 1200 ? 900 : 844 });
    await installRuntime(page);
    await page.goto('/more');

    await expect(page.getByRole('heading', { name: '설정', exact: true })).toBeVisible();
    const grid = page.getByTestId('settings-compact-grid');
    await expect(grid).toBeVisible();
    const buttons = grid.getByRole('button');
    await expect(buttons).toHaveCount(9);

    for (const button of await buttons.all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width + 1);
      const alignment = await button.evaluate((node) => getComputedStyle(node).textAlign);
      expect(alignment).toBe('center');
    }

    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('Telegram settings defers connection truth to the account surface instead of asserting a state', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/more?section=telegram');

  await expect(page.getByText('연결 상태는 사용자 계정의 실제 연동 정보를 기준으로 확인합니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('텔레그램 미연결', { exact: false })).toHaveCount(0);
  const button = page.getByRole('button', { name: '텔레그램 연결 확인', exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page).toHaveURL(/\/account(?:$|[?#])/);
});
