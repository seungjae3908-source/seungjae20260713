import { expect, test, type Page, type Route } from '@playwright/test';

const E2E_USER_ID = '22222222-2222-4222-8222-222222222222';
const E2E_AUTH_STORAGE_KEY = 'sb-127-auth-token';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installSession(page: Page) {
  await page.addInitScript(({ storageKey, userId }) => {
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
        email: 'market-overview-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시황 QA' },
        identities: [],
        created_at: new Date().toISOString(),
      },
    }));
  }, { storageKey: E2E_AUTH_STORAGE_KEY, userId: E2E_USER_ID });
}

function briefing(now: string) {
  return {
    asOf: now,
    mood: 'neutral',
    headline: '시장 근거 확인 중',
    lines: [],
    strongSectors: [], weakSectors: [], positiveNews: [], negativeNews: [],
    disclosureRisks: [], gainers: [], losers: [], picks: [],
  };
}

function summary() {
  return {
    items: [
      { key: 'kospi', label: 'KOSPI', ok: true, price: 2800, changePercent: 0.5 },
      { key: 'kosdaq', label: 'KOSDAQ', ok: true, price: 900, changePercent: -0.2 },
    ],
    provider: 'E2E',
  };
}

function sectorPayload(now: string, withEvidence: boolean) {
  return {
    market: 'KR',
    sortBasis: '거래대금 기준',
    sectors: [
      {
        key: 'semiconductor',
        label: '반도체',
        rows: withEvidence ? [{
          rank: 1,
          ticker: '005930',
          name: '삼성전자',
          market: 'KR',
          currency: 'KRW',
          price: 72000,
          changePercent: 1.25,
          tradingValue: 1_000_000,
          volume: 12_000,
        }] : [],
      },
      { key: 'auto', label: '자동차', rows: [] },
    ],
    updatedAt: now,
  };
}

async function installMocks(page: Page, withSectorEvidence: boolean) {
  await installSession(page);

  await page.route('**/__e2e-supabase/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (path.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        login_name: 'market-overview-truth',
        display_name: '시황 QA',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: now,
        updated_at: now,
      });
    }
    if (path.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: E2E_USER_ID,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'market-overview-truth@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '시황 QA' },
        identities: [],
        created_at: now,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const now = new Date().toISOString();
    if (path === '/api/market/summary') return fulfill(route, summary());
    if (path === '/api/market/sector-popular') return fulfill(route, sectorPayload(now, withSectorEvidence));
    if (path === '/api/market/briefing') return fulfill(route, briefing(now));
    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/watchlist/sync') return fulfill(route, { ok: true, items: [] });
    return fulfill(route, { ok: true });
  });
}

test('malformed HTTP 200 with no sector ranking evidence fails closed', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, false);
  await page.goto('/market-overview');
  await expect(page.getByTestId('market-overview-page')).toBeVisible();
  await page.getByRole('button', { name: '섹터', exact: true }).click();
  const section = page.getByTestId('market-overview-sectors');
  await expect(section.getByText('섹터 확인 실패')).toBeVisible({ timeout: 15_000 });
  await expect(section.getByText('섹터 데이터 없음')).toHaveCount(0);
});

test('canonical sector payload keeps partial empty groups while rendering live evidence', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installMocks(page, true);
  await page.goto('/market-overview');
  await expect(page.getByTestId('market-overview-page')).toBeVisible();
  await page.getByRole('button', { name: '섹터', exact: true }).click();
  const section = page.getByTestId('market-overview-sectors');
  await expect(section.getByRole('button', { name: '삼성전자' })).toBeVisible();
  await expect(section.getByText('섹터 확인 실패')).toHaveCount(0);
});
