import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '44444444-4444-4444-8444-444444444444';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';
const ANALYSIS_STORAGE_KEY = 'sa-analysis-selection-v1';
const NOW = '2026-08-25T05:30:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSession(page: Page, storedSelection?: Record<string, unknown>) {
  await page.addInitScript(({ storageKey, analysisKey, userId, now, stored }) => {
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
        email: 'context-integrity@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Context Integrity' },
        identities: [],
        created_at: now,
      },
    }));
    if (stored) window.localStorage.setItem(analysisKey, JSON.stringify(stored));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, analysisKey: ANALYSIS_STORAGE_KEY, userId: E2E_USER_ID, now: NOW, stored: storedSelection ?? null });
}

async function installMocks(page: Page, storedSelection?: Record<string, unknown>) {
  await installSession(page, storedSelection);
  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'context-integrity',
        display_name: 'Context Integrity',
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
        email: 'context-integrity@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: 'Context Integrity' },
        identities: [],
        created_at: NOW,
      });
    }
    return fulfill(route, { ok: true, items: [], results: [] });
  });
  await page.route('**/api/**', async (route) => fulfill(route, {
    ok: true,
    items: [],
    results: [],
    candles: [],
    normalization: { candles: [] },
  }));
}

const staleBtcSelection = {
  assetType: 'coin_futures',
  market: 'BITGET',
  symbol: 'BTCUSDT',
  ticker: 'BTCUSDT',
  displayName: 'BTCUSDT',
  timeframe: '4H',
  selectedAt: '2026-08-24T01:00:00.000Z',
};

async function expectDetailContext(page: Page, ticker: string, name: string) {
  const shell = page.getByTestId('canonical-rich-detail-chart');
  await expect(shell).toHaveAttribute('data-context-ticker', ticker);
  await expect(page.getByTestId('ai-chart-context-syncing')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'AI 차트' })).toBeVisible();
  await expect(page.locator('header')).toContainText(name);
  await expect(page.locator('body')).not.toContainText('BTCUSDT');
}

test('detail route beats stale BTC localStorage and never renders the stale symbol', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, staleBtcSelection);
  await page.goto('/stock-info/analysis?asset=stock&market=KR&ticker=066570&name=LG%EC%A0%84%EC%9E%90&tab=chart');
  await expectDetailContext(page, '066570', 'LG전자');

  const persisted = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), ANALYSIS_STORAGE_KEY);
  expect(persisted.market).toBe('KR');
  expect(persisted.ticker).toBe('066570');
  expect(persisted.symbol).toBe('066570');
  expect(persisted.timeframe).toBe('5m');
});

test('detail navigation and browser back/forward keep route and embedded AI chart on the same symbol', async ({ page }) => {
  await installMocks(page, staleBtcSelection);
  await page.goto('/stock-info/analysis?asset=stock&market=KR&ticker=066570&name=LG%EC%A0%84%EC%9E%90&tab=chart');
  await expectDetailContext(page, '066570', 'LG전자');

  await page.goto('/stock-info/analysis?asset=stock&market=KR&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&tab=chart');
  await expectDetailContext(page, '005930', '삼성전자');

  await page.goBack();
  await expectDetailContext(page, '066570', 'LG전자');
  await page.goForward();
  await expectDetailContext(page, '005930', '삼성전자');
});

test('explicit Scanner-to-AI-chart crypto route remains canonical', async ({ page }) => {
  await installMocks(page);
  await page.goto('/ai-chart?assetType=coin_futures&market=BITGET&symbol=BTCUSDT&ticker=BTCUSDT&name=BTCUSDT&timeframe=4H');
  await expect(page.getByRole('heading', { name: 'AI 차트' })).toBeVisible();
  await expect(page.locator('header')).toContainText('BTCUSDT');
  await expect(page.locator('header')).toContainText('4H');

  const persisted = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? 'null'), ANALYSIS_STORAGE_KEY);
  expect(persisted.market).toBe('BITGET');
  expect(persisted.ticker).toBe('BTCUSDT');
  expect(persisted.timeframe).toBe('4H');
});
