import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-26T04:00:00.000Z';
const E2E_USER_ID = '22222222-2222-4222-8222-222222222230';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

const stocksSource = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/stocks.tsx'), 'utf8');

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function recommendationRow(index: number) {
  const ticker = String(5930 + index).padStart(6, '0');
  return {
    ticker,
    name: `종목 레이아웃 검증 ${index + 1}`,
    market: 'KR',
    currency: 'KRW',
    category: index % 2 === 0 ? 'undervalued' : 'breakout',
    categoryLabel: index % 2 === 0 ? '저평가' : '초기 추세돌파',
    price: 75_000 + index,
    changePercent: 0.4,
    reasons: ['공개 fixture 기반 레이아웃 검증'],
    score: 60,
  };
}

async function installApprovedRuntime(page: Page, recommendationCount: number) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-stocks-layout-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'stocks-layout@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '종목 레이아웃 검증 관리자' },
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
        login_name: 'stocks-layout-admin',
        display_name: '종목 레이아웃 검증 관리자',
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
        email: 'stocks-layout@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '종목 레이아웃 검증 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/market/recommendations') {
      return fulfill(route, {
        ok: true,
        analysisMode: 'rules',
        analysisDescription: '종목 레이아웃 검증 fixture',
        market: 'KR',
        rows: Array.from({ length: recommendationCount }, (_, index) => recommendationRow(index)),
      });
    }
    return fulfill(route, {
      ok: true,
      items: [],
      rows: [],
      results: [],
      themes: [],
      cards: [],
      alerts: [],
      markets: [],
      tickers: [],
      dataState: 'ready',
    });
  });
}

async function navGeometry(page: Page) {
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav).toBeVisible();
  const box = await nav.boundingBox();
  expect(box).not.toBeNull();
  return { box: box!, innerHeight: await page.evaluate(() => window.innerHeight) };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.root).toBeLessThanOrEqual(overflow.viewport);
}

test('Stocks source uses a viewport-filling shell and keeps BottomNav outside the scrolling region', () => {
  expect(stocksSource).toContain('data-testid="stocks-shell"');
  expect(stocksSource).toContain('flex h-full min-h-0 flex-col overflow-hidden bg-background');
  expect(stocksSource).toContain('data-testid="stocks-scroll-content"');
  expect(stocksSource).toContain('min-h-0 flex-1 overflow-y-auto overscroll-contain');
  expect(stocksSource).toContain('<main className="space-y-4 px-4 pb-6 pt-4">');
  expect(stocksSource).not.toContain('<main className="space-y-4 px-4 pb-28 pt-4">');
  expect(stocksSource).toContain('<BottomNav />');
});

test('390x844 short Stocks content keeps BottomNav on the viewport floor', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedRuntime(page, 0);
  await page.goto('/market-browser');

  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
  const content = page.getByTestId('stocks-scroll-content');
  await expect(content).toBeVisible();
  const contentBox = await content.boundingBox();
  const nav = await navGeometry(page);
  expect(contentBox).not.toBeNull();
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(nav.box.y + 1);
  expect(Math.abs(nav.box.y + nav.box.height - nav.innerHeight)).toBeLessThanOrEqual(1);
  expect(await content.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
  await expectNoHorizontalOverflow(page);
});

test('390x844 long Stocks content scrolls independently without moving BottomNav', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApprovedRuntime(page, 30);
  await page.goto('/market-browser');

  const content = page.getByTestId('stocks-scroll-content');
  await expect(content).toBeVisible();
  expect(await content.evaluate((node) => node.scrollHeight > node.clientHeight + 1)).toBe(true);
  const before = await navGeometry(page);
  await content.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await expect.poll(() => content.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  const after = await navGeometry(page);
  expect(Math.abs(before.box.y + before.box.height - before.innerHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.box.y + after.box.height - after.innerHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.box.y - before.box.y)).toBeLessThanOrEqual(1);
  const contentBox = await content.boundingBox();
  expect(contentBox).not.toBeNull();
  expect(contentBox!.y + contentBox!.height).toBeLessThanOrEqual(after.box.y + 1);
  await expectNoHorizontalOverflow(page);
});

test('desktop Stocks keeps the same shell contract without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await installApprovedRuntime(page, 0);
  await page.goto('/market-browser');

  await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
  const content = page.getByTestId('stocks-scroll-content');
  await expect(content).toBeVisible();
  const nav = await navGeometry(page);
  expect(Math.abs(nav.box.y + nav.box.height - nav.innerHeight)).toBeLessThanOrEqual(1);
  await expectNoHorizontalOverflow(page);
});
