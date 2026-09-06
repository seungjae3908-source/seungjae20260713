import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const USER = '88888888-8888-4888-8888-888888888888';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-06T09:10:00.000Z';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installRuntime(page: Page) {
  await page.addInitScript(({ authKey, user, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'professional-command-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'professional-command@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '프로 UI 관리자' },
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
        login_name: 'professional-command-admin',
        display_name: '프로 UI 관리자',
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
        email: 'professional-command@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '프로 UI 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/market/summary') {
      return fulfill(route, {
        ok: true,
        available: true,
        partial: false,
        dataState: 'ready',
        provider: 'fixture',
        availableCount: 1,
        totalCount: 1,
        missingKeys: [],
        retryable: false,
        items: [{ key: 'kospi', label: '코스피', price: 3200, changePercent: 0.4, ok: true }],
      });
    }
    if (pathname === '/api/crypto/spot/tickers') return fulfill(route, { tickers: [] });
    return fulfill(route, {
      ok: true,
      items: [],
      rows: [],
      results: [],
      quotes: [],
      cards: [],
      alerts: [],
      notifications: [],
      markets: [],
      tickers: [],
      dataState: 'ready',
    });
  });
}

test('professional command surface is shell-owned, desktop-idle split, capability-aware and contains no order action', () => {
  const app = source('src/App.tsx');
  const loader = source('src/components/professional-command-bar.tsx');
  const content = source('src/components/professional-command-bar-content.tsx');

  expect(app).toContain("import { ProfessionalCommandBar } from '@/components/professional-command-bar';");
  expect(app).toContain('<ProfessionalCommandBar />');
  expect(app).not.toContain('professional-command-bar-content');
  expect(loader).toContain("window.matchMedia('(min-width: 1200px)')");
  expect(loader).toContain('requestIdleCallback');
  expect(loader).toContain("import('@/components/professional-command-bar-content')");
  expect(content).toContain("auth.can('canAccessRiskPreview')");
  expect(content).toContain("auth.can('canAccessPaperTrading')");
  expect(content).toContain("auth.can('canManageMembers')");
  expect(content).not.toContain('APP_ROUTES.autoTrading');
  expect(content).not.toContain('주문 실행');
  expect(content).not.toContain('매수');
  expect(content).not.toContain('매도');
});

test('desktop command bar opens with Ctrl+K and keyboard navigation reaches a read-only analysis screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntime(page);
  await page.goto('/home');

  const bar = page.getByTestId('professional-command-bar');
  await expect(bar).toBeVisible({ timeout: 5_000 });
  await expect(bar).toContainText('홈');
  await expect(bar).toContainText('온라인');

  await page.keyboard.press('Control+K');
  const palette = page.getByTestId('professional-command-palette');
  await expect(palette).toBeVisible();
  const input = page.getByLabel('빠른 실행 검색');
  await expect(input).toBeFocused();
  await input.fill('AI 차트');
  const chart = palette.getByRole('option', { name: /AI 차트/ });
  await expect(chart).toBeVisible();
  await input.press('Enter');
  await expect(page).toHaveURL(/\/ai-chart(?:$|[?#])/);
});

test('touch/tablet widths never request or render the professional desktop command surface', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await installRuntime(page);
  await page.goto('/home');

  await expect(page.getByTestId('professional-command-bar')).toHaveCount(0);
  await page.keyboard.press('Control+K');
  await expect(page.getByTestId('professional-command-palette')).toHaveCount(0);

  const overflow = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
