import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-22T06:30:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222223';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installHomeRuntime(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-home-compact-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'home-compact@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '홈 압축 검증 관리자' },
        identities: [],
        created_at: now,
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID, now: NOW });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'home-compact-admin',
        display_name: '홈 압축 검증 관리자',
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
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'home-compact@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '홈 압축 검증 관리자' },
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
        availableCount: 2,
        totalCount: 2,
        missingKeys: [],
        retryable: false,
        error: null,
        errorCode: null,
        message: null,
        items: [
          { key: 'kospi', label: '코스피', price: 3200.12, changePercent: 0.42, ok: true },
          { key: 'nasdaq', label: '나스닥', price: 22010.7, changePercent: -0.18, ok: true },
        ],
      });
    }
    if (pathname === '/api/crypto/spot/tickers') {
      return fulfill(route, { tickers: [{ symbol: 'KRW-BTC', price: 100_000_000, changePercent: 0.7 }] });
    }
    return fulfill(route, {
      ok: true,
      items: [],
      rows: [],
      results: [],
      quotes: [],
      cards: [],
      alerts: [],
      markets: [],
      tickers: [],
      dataState: 'ready',
    });
  });
}

test('Home source follows the approved mockup: stacked summary cards on mobile, dashboard grid on desktop', () => {
  const home = source('src/pages/home.tsx');

  expect(home).toContain('title="홈"');
  expect(home).toContain('testId="home-asset-summary"');
  expect(home).toContain('data-testid="home-market-summary"');
  expect(home).toContain('testId="home-watchlist-summary"');
  expect(home).toContain('testId="home-signal-summary"');
  expect(home).toContain('data-testid="home-briefing-summary"');
  expect(home).toContain('data-testid="home-desktop-workspace"');
  expect(home).toContain('data-testid="home-mobile-stack"');
  expect(home).toContain('title="총 평가자산"');
  expect(home).toContain('title="오늘의 AI 신호"');
  expect(home).toContain('action="검색기"');
  expect(home).toContain('action="자산 보기"');
  expect(home).not.toContain('home-mobile-tabs');
  expect(home).not.toContain('/api/accounts');
  expect(home).not.toContain('Scanner 열기');
  expect(home).not.toContain('infoItems={[');
  expect(home).not.toContain('Home에서는 private 계좌');
});

for (const width of [360, 390, 412, 430]) {
  test(`Home mobile ${width}px stacks the mockup cards in order without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installHomeRuntime(page);
    await page.goto('/home');

    await expect(page.getByTestId('home-mobile-stack')).toBeVisible();
    await expect(page.getByTestId('home-single-search')).toBeVisible();
    await expect(page.getByTestId('home-desktop-workspace')).toHaveCount(0);
    await expect(page.getByTestId('home-asset-summary')).toBeVisible();
    await expect(page.getByTestId('home-market-summary')).toBeVisible();
    await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
    await expect(page.getByTestId('home-signal-summary')).toBeVisible();
    await expect(page.getByTestId('home-briefing-summary')).toBeVisible();

    const order = await page.evaluate(() => Array.from(
      document.querySelectorAll('[data-testid="home-mobile-stack"] > section'),
    ).map((node) => node.getAttribute('data-testid')));
    expect(order.slice(0, 5)).toEqual([
      'home-asset-summary',
      'home-market-summary',
      'home-watchlist-summary',
      'home-signal-summary',
      'home-briefing-summary',
    ]);

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('Home mobile shows index tiles and the watchlist card content from the market summary', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installHomeRuntime(page);
  await page.goto('/home');

  const market = page.getByTestId('home-market-summary');
  await expect(market.getByText('코스피', { exact: true })).toBeVisible();
  await expect(market.getByText('나스닥', { exact: true })).toBeVisible();
  await expect(market.getByText('비트코인', { exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '검색기', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '전체', exact: true })).toBeVisible();
});

test('Home desktop uses the mockup dashboard grid without the mobile search box', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installHomeRuntime(page);
  await page.goto('/home');

  await expect(page.getByTestId('home-mobile-stack')).toHaveCount(0);
  await expect(page.getByTestId('home-single-search')).toHaveCount(0);
  await expect(page.getByTestId('home-desktop-workspace')).toBeVisible();
  await expect(page.getByTestId('home-asset-summary')).toBeVisible();
  await expect(page.getByTestId('home-market-summary')).toBeVisible();
  await expect(page.getByTestId('home-signal-summary')).toBeVisible();
  await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
  await expect(page.getByTestId('home-briefing-summary')).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '자산 보기', exact: true })).toBeVisible();
  await expect(page.getByRole('main').getByRole('button', { name: '검색기', exact: true })).toBeVisible();
});
