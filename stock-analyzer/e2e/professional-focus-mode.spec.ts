import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const USER = 'f0c05000-0000-4000-8000-000000000001';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = '2026-09-07T02:15:00.000Z';

function source(relativePath: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

const portfolio = {
  status: 'PARTIAL',
  asOf: NOW,
  totalAssets: { status: 'PARTIAL', normalizedKRW: null, knownNormalizedKRW: 1_250_000 },
  investmentPrincipal: { status: 'READY', normalizedKRW: 1_000_000, knownNormalizedKRW: 1_000_000 },
  valuationPnl: { status: 'READY', normalizedKRW: 250_000, returnPercent: 25 },
  cash: { status: 'UNAVAILABLE', totalKRW: null },
  minimumCashBuffer: { status: 'UNAVAILABLE', normalizedKRW: null },
  investableCash: { status: 'UNAVAILABLE', normalizedKRW: null },
  assets: { krStocks: 1_250_000, usStocks: null, cryptoSpot: null, cryptoFuturesEquity: null, cash: null },
  allocation: { status: 'PARTIAL', knownTotalKRW: 1_250_000, buckets: { KR_STOCK: 100, US_STOCK: null, CRYPTO: null } },
  holdings: [],
  topHoldings: [],
  top5Concentration: { status: 'READY', percent: 0 },
  correlation: { status: 'UNAVAILABLE', sampleSize: 0, correlation: null, pair: [] },
  riskClassification: { status: 'PARTIAL', level: null, reason: '일부 계좌 근거가 없어 위험 분류가 제한됩니다.' },
  allocationPolicy: { profile: 'BALANCED', status: 'PARTIAL', comparison: [] },
  fx: { status: 'UNAVAILABLE', quotes: [] },
  dataQuality: { status: 'PARTIAL', providerCount: 3, includedProviderCount: 1, invalidHoldingRows: 0 },
  missingSources: ['READONLY_CASH_SOURCE_UNAVAILABLE'],
};

async function installRuntime(page: Page) {
  await page.addInitScript(({ authKey, user, now }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value))
      .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`,
      refresh_token: 'professional-focus-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'focus-mode@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Focus QA' },
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
        login_name: 'focus-mode-admin',
        display_name: 'Focus QA',
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
        email: 'focus-mode@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Focus QA' },
        identities: [],
        created_at: NOW,
      });
    }
    if (pathname.includes('/rest/v1/')) return fulfill(route, []);
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/portfolio/intelligence') return fulfill(route, { ok: true, portfolio });
    if (pathname === '/api/portfolio/intelligence/monthly-contribution') {
      return fulfill(route, {
        ok: true,
        status: 'READY',
        assumption: 'NO_VALIDATED_RETURN_ASSUMPTION',
        allocationBasis: 'CURRENT_KNOWN_ALLOCATION',
        allocationKnownTotalKRW: 1_250_000,
        profileForPolicyComparison: 'BALANCED',
        profileUsedForAllocation: false,
        unavailableOutputs: [],
        plan: { monthlyAmountKRW: 300_000, months: 12, cumulativeInvestmentKRW: 3_600_000, allocations: [] },
      });
    }
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

test('focus mode is bounded to professional read/analysis routes and does not add trading authority', () => {
  const content = source('src/components/professional-command-bar-content.tsx');
  const css = source('src/professional-focus-mode.css');

  expect(content).toContain('APP_ROUTES.aiChart');
  expect(content).toContain('APP_ROUTES.scanner');
  expect(content).toContain('APP_ROUTES.portfolio');
  expect(content).toContain('APP_ROUTES.researchCenter');
  expect(content).toContain('data-testid="professional-focus-enter"');
  expect(content).toContain('data-testid="professional-focus-exit"');
  expect(content).toContain("window.matchMedia('(min-width: 1200px)')");
  expect(content).not.toContain('APP_ROUTES.autoTrading');
  expect(content).not.toContain('주문 실행');
  expect(css).toContain('max-width: none !important');
  expect(css).toContain('nav[aria-label="주요 메뉴"]');
  expect(css).toContain('font-size: 0.75rem !important');
});

test('desktop portfolio enters and exits focus mode without changing route or overflowing the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntime(page);
  await page.goto('/portfolio');

  const bar = page.getByTestId('professional-command-bar');
  const nav = page.getByRole('navigation', { name: '주요 메뉴' });
  await expect(bar).toBeVisible({ timeout: 5_000 });
  await expect(nav).toBeVisible();
  await expect(page.getByTestId('professional-focus-enter')).toBeVisible();

  await page.getByTestId('professional-focus-enter').click();
  await expect(page.getByTestId('professional-focus-exit')).toBeVisible();
  await expect(page.getByTestId('professional-command-bar')).toHaveCount(0);
  await expect(nav).toBeHidden();
  await expect(page).toHaveURL(/\/portfolio(?:$|[?#])/);

  const focusState = await page.evaluate(() => ({
    html: document.documentElement.dataset.professionalFocus,
    shell: document.querySelector<HTMLElement>('[data-professional-focus-shell="true"]')?.dataset.professionalFocusShell ?? null,
    maxWidth: document.querySelector<HTMLElement>('[data-professional-focus-shell="true"]')
      ? getComputedStyle(document.querySelector<HTMLElement>('[data-professional-focus-shell="true"]')!).maxWidth
      : null,
    overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
  }));
  expect(focusState.html).toBe('true');
  expect(focusState.shell).toBe('true');
  expect(focusState.maxWidth).toBe('none');
  expect(focusState.overflow).toBeLessThanOrEqual(2);

  await page.keyboard.press('f');
  await expect(page.getByTestId('professional-focus-exit')).toHaveCount(0);
  await expect(page.getByTestId('professional-command-bar')).toBeVisible();
  await expect(nav).toBeVisible();

  await page.keyboard.press('f');
  await expect(page.getByTestId('professional-focus-exit')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('professional-focus-exit')).toHaveCount(0);
  await expect(nav).toBeVisible();
});

test('focus mode is not exposed on unsupported home route', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntime(page);
  await page.goto('/home');

  await expect(page.getByTestId('professional-command-bar')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('professional-focus-enter')).toHaveCount(0);
  await page.keyboard.press('f');
  await expect(page.getByTestId('professional-focus-exit')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();
});

test('touch and tablet widths never activate professional focus mode', async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 820 });
  await installRuntime(page);
  await page.goto('/portfolio');

  await expect(page.getByTestId('professional-command-bar')).toHaveCount(0);
  await page.keyboard.press('f');
  await expect(page.getByTestId('professional-focus-exit')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible();

  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
