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

test('Home source separates desktop and mobile and keeps primary labels Korean-first', () => {
  const home = source('src/pages/home.tsx');

  expect(home).toContain("type MobileHomeTab = 'market' | 'signal' | 'watchlist' | 'portfolio';");
  expect(home).toContain("{ value: 'market', label: '시장' }");
  expect(home).toContain("{ value: 'signal', label: '신호' }");
  expect(home).toContain("{ value: 'watchlist', label: '관심' }");
  expect(home).toContain("{ value: 'portfolio', label: '자산' }");
  expect(home).toContain('testId="home-mobile-tabs"');
  expect(home).toContain('title="홈"');
  expect(home).toContain('>검색기</button>');
  expect(home).toContain('점수 {selection.signalScore}');
  expect(home).toContain('<h2 className="text-sm font-black">포트폴리오</h2>');
  expect(home).toContain('<span>자산·손익·위험</span>');
  expect(home).not.toContain('Scanner 열기');
  expect(home).not.toContain('Score {selection.signalScore}');
  expect(home).not.toContain('<h2 className="text-sm font-black">Portfolio</h2>');
  expect(home).not.toContain('infoItems={[');
  expect(home).not.toContain('Home에서는 private 계좌');
});

for (const width of [360, 390, 412, 430]) {
  test(`Home mobile ${width}px shows one compact section without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await installHomeRuntime(page);
    await page.goto('/home');

    await expect(page.getByTestId('home-mobile-tabs')).toBeVisible();
    await expect(page.getByTestId('home-single-search')).toBeVisible();
    await expect(page.getByTestId('home-market-summary')).toBeVisible();
    await expect(page.getByTestId('home-signal-summary')).toHaveCount(0);
    await expect(page.getByTestId('home-watchlist-summary')).toHaveCount(0);
    await expect(page.getByTestId('home-portfolio-summary')).toHaveCount(0);

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      root: document.documentElement.scrollWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
    expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
  });
}

test('Home mobile tabs replace the visible section instead of stacking all cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installHomeRuntime(page);
  await page.goto('/home');

  await page.getByRole('tab', { name: '신호' }).click();
  await expect(page.getByTestId('home-signal-summary')).toBeVisible();
  await expect(page.getByTestId('home-market-summary')).toHaveCount(0);

  await page.getByRole('tab', { name: '관심' }).click();
  await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
  await expect(page.getByTestId('home-signal-summary')).toHaveCount(0);

  await page.getByRole('tab', { name: '자산' }).click();
  await expect(page.getByTestId('home-portfolio-summary')).toBeVisible();
  await expect(page.getByText('자산·손익·위험')).toBeVisible();
  await expect(page.getByTestId('home-watchlist-summary')).toHaveCount(0);
});

test('Home desktop keeps the full dashboard and does not show mobile tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installHomeRuntime(page);
  await page.goto('/home');

  await expect(page.getByTestId('home-mobile-tabs')).toHaveCount(0);
  await expect(page.getByTestId('home-market-summary')).toBeVisible();
  await expect(page.getByTestId('home-signal-summary')).toBeVisible();
  await expect(page.getByTestId('home-watchlist-summary')).toBeVisible();
  await expect(page.getByTestId('home-portfolio-summary')).toBeVisible();
  await expect(page.getByText('포트폴리오')).toBeVisible();
  await expect(page.getByText('검색기')).toBeVisible();
});