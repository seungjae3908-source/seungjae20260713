import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '44444444-4444-4444-8444-444444444444';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const NOW = '2026-08-26T07:30:00.000Z';

const ROUTES = [
  { path: '/market-overview', title: '지수·시황' },
  { path: '/market-rankings', title: '시장 순위' },
  { path: '/market-rankings?asset=coin&coinMarket=spot', title: '시장 순위', label: '시장 순위 · 코인' },
  { path: '/watchlist', title: '관심종목' },
  { path: '/alerts', title: '가격 알림' },
  { path: '/stock-info?asset=stock&market=KR', title: '종목 정보' },
  { path: '/research-center', title: '연구센터', contentDiv: true },
  { path: '/portfolio?tab=holdings', title: '포트폴리오' },
  { path: '/account', title: '계정' },
] as const;

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSessionAndMocks(page: Page) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'e2e-refresh-token',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'remaining-scroll-shell@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '스크롤 QA 관리자' },
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
        login_name: 'remaining-scroll-shell',
        display_name: '스크롤 QA 관리자',
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
        email: 'remaining-scroll-shell@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '스크롤 QA 관리자' },
        identities: [],
        created_at: NOW,
      });
    }
    if (pathname.includes('/rest/v1/portfolio_holdings')) return fulfill(route, []);
    if (pathname.includes('/rest/v1/')) return fulfill(route, []);
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (pathname === '/api/notifications/history') return fulfill(route, { notifications: [] });
    if (pathname === '/api/crypto/status') return fulfill(route, { upbit: { ok: true }, bitget: { ok: true } });
    if (pathname === '/api/crypto/spot/markets') return fulfill(route, { markets: [] });
    if (pathname === '/api/crypto/spot/tickers') return fulfill(route, { tickers: [], updatedAt: NOW });
    if (pathname === '/api/crypto/futures/tickers') return fulfill(route, { tickers: [], updatedAt: NOW });
    if (pathname.includes('/portfolio/intelligence')) {
      return fulfill(route, { ok: false, status: 'UNAVAILABLE', portfolio: null }, 503);
    }
    if (pathname.includes('/research-center') || pathname.includes('/strategy-promotion')) {
      return fulfill(route, { ok: false, items: [], promotionCandidates: 0 }, 503);
    }
    if (pathname.includes('/briefing')) return fulfill(route, { headline: '스크롤 QA', lines: [] });
    if (pathname.includes('/sector')) return fulfill(route, { sectors: [] });
    if (pathname.includes('/special-feed')) {
      const asset = url.searchParams.get('asset') === 'coin' ? 'coin' : 'stock';
      const market = asset === 'coin' ? (url.searchParams.get('market') === 'futures' ? 'futures' : 'spot') : 'KR';
      return fulfill(route, { ok: true, asset, market, items: [], count: 0, latestDays: 7, updatedAt: NOW });
    }
    return fulfill(route, {
      ok: true,
      items: [],
      results: [],
      rows: [],
      quotes: [],
      alerts: [],
      notifications: [],
      sectors: [],
      positive: [],
      negative: [],
    });
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const value = await page.evaluate(() => Math.max(
    document.documentElement.scrollWidth,
    document.body.scrollWidth,
  ) - window.innerWidth);
  expect(value).toBeLessThanOrEqual(1);
}

async function scrollOwnerFor(page: Page, title: string, contentDiv = false) {
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(nav).toBeVisible({ timeout: 10_000 });
  await expect(nav).toHaveAttribute('data-route-title', title);
  const shell = nav.locator('..');
  if (contentDiv) return { nav, shell, scroll: shell.locator(':scope > div').first() };
  return { nav, shell, scroll: shell.locator(':scope > main').first() };
}

async function wheelTargetInsideScrollOwner(scroll: ReturnType<Page['locator']>) {
  return scroll.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const x = rect.left + Math.min(Math.max(rect.width / 2, 1), Math.max(1, rect.width - 1));
    const y = rect.top + Math.min(Math.max(rect.height / 2, 1), Math.max(1, rect.height - 1));
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      hitInside: Boolean(hit && node.contains(hit)),
      clientHeight: (node as HTMLElement).clientHeight,
      scrollHeight: (node as HTMLElement).scrollHeight,
    };
  });
}

test('remaining scroll-shell CSS is route-title bounded and does not target AI Chart', () => {
  const css = source('public/production-ui-geometry.css');
  for (const { title } of ROUTES) {
    expect(css).toContain(`data-route-title=\"${title}\"`);
  }
  expect(css).not.toContain('data-route-title=\"AI 차트\"');
  expect(css).toContain('overflow: hidden !important');
  expect(css).toContain('overscroll-behavior: contain');
});

for (const route of ROUTES) {
  test(`${'label' in route ? route.label : route.title} owns content scrolling without moving BottomNav`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await installSessionAndMocks(page);
    await page.goto(route.path);

    const { nav, shell, scroll } = await scrollOwnerFor(page, route.title, 'contentDiv' in route && route.contentDiv === true);
    await expect(scroll).toBeVisible();

    expect(await shell.evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');
    expect(await scroll.evaluate((node) => getComputedStyle(node).overflowY)).toBe('auto');

    await scroll.evaluate((node) => {
      const filler = document.createElement('div');
      filler.dataset.scrollShellFiller = 'true';
      filler.style.height = '1800px';
      filler.style.width = '1px';
      filler.style.pointerEvents = 'none';
      node.appendChild(filler);
      (node as HTMLElement).scrollTop = 0;
    });

    const target = await wheelTargetInsideScrollOwner(scroll);
    expect(target.clientHeight).toBeGreaterThan(40);
    expect(target.scrollHeight).toBeGreaterThan(target.clientHeight + 100);
    expect(target.hitInside).toBe(true);

    const navBefore = await nav.boundingBox();
    expect(navBefore).not.toBeNull();
    const viewportHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.abs(navBefore!.y + navBefore!.height - viewportHeight)).toBeLessThanOrEqual(1);

    await page.mouse.move(target.x, target.y);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => scroll.evaluate((node) => (node as HTMLElement).scrollTop)).toBeGreaterThan(0);

    const navAfter = await nav.boundingBox();
    expect(navAfter).not.toBeNull();
    expect(Math.abs(navAfter!.y - navBefore!.y)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectNoHorizontalOverflow(page);
  });
}
