import { expect, test, type Page, type Route } from '@playwright/test';

const USER = '99999999-9999-4999-8999-999999999999';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = Date.parse('2026-09-06T09:00:00Z');

const overview = {
  schemaVersion: 'research-dashboard-overview-v1',
  generatedAt: NOW,
  state: { present: true, latestCycleAt: NOW },
  safety: {
    readOnlyDashboard: true,
    liveTrading: false,
    privateApi: false,
    orderAuthority: false,
    authorityEvidenceComplete: true,
    forbiddenAuthorityObserved: false,
  },
  research: { status: 'collecting', failedTasks: 0, blockedDataTasks: 1, cycles: [] },
  paper: {
    runtime: {
      present: true,
      status: 'collecting',
      safetyEvidenceComplete: true,
      lanes: [],
      privateRequestCount: 0,
      financialMutationCount: 0,
      orderCount: 0,
      liveTrading: false,
      orderAuthority: false,
    },
    ledger: { present: true, cycleCount: 2, sampleCount: 7, positionCount: 1, settlementCount: 7 },
  },
  shadow: {
    groups: [],
    records: { present: true, totalRecords: 12, settledRecords: 8, pendingRecords: 4 },
  },
  profitability: { proven: false, status: 'NOT_PROVEN', note: '필수 정산 증거 부족' },
};

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function installRuntime(page: Page) {
  await page.addInitScript(({ authKey, user }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'research-hierarchy-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'research-hierarchy@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '연구 관리자' },
        identities: [],
        created_at: '2026-09-06T00:00:00.000Z',
      },
    }));
  }, { authKey: AUTH_KEY, user: USER });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER,
        login_name: 'research-hierarchy-admin',
        display_name: '연구 관리자',
        role: 'admin',
        status: 'approved',
        membership_level: 'admin',
        is_active: true,
        permissions_updated_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'research-hierarchy@accounts.invalid',
        app_metadata: {},
        user_metadata: {},
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/admin/research/overview') return fulfill(route, overview);
    if (pathname === '/api/strategy-promotion') {
      return fulfill(route, {
        items: [],
        counts: {},
        evidenceSources: [],
        promotionCandidates: 0,
        sourceSha: '1234567890abcdef1234567890abcdef12345678',
        executionAuthority: 'NONE',
      });
    }
    if (pathname === '/api/admin/research/copilot') {
      return fulfill(route, { error: 'NOT_USED_BY_HIERARCHY_TEST' }, 503);
    }
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
}

for (const [width, height] of [[320, 740], [390, 844], [768, 900], [1199, 900], [1200, 900], [1440, 900]] as const) {
  test(`research general view stays concise and inside ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installRuntime(page);
    await page.goto('/research-center');

    await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
    const expertButton = page.getByRole('button', { name: '전문가 보기', exact: true });
    const generalButton = page.getByRole('button', { name: '일반 보기', exact: true });
    await expect(expertButton).toHaveAttribute('aria-pressed', 'true');
    await expect(generalButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI Research Copilot', exact: true })).toBeVisible();

    await generalButton.click();
    await expect(generalButton).toHaveAttribute('aria-pressed', 'true');

    const general = page.getByTestId('research-general-view');
    await expect(general).toContainText('근거 수집 중');
    await expect(general).toContainText('7건');
    await expect(general).toContainText('12건');
    await expect(general).toContainText('검증 중');
    await expect(general).toContainText('실거래 비활성');
    await expect(general).not.toContainText('Source SHA');
    await expect(general).not.toContainText('Evidence state');
    await expect(general).not.toContainText('Canonical records');
    await expect(general).not.toContainText('LIVE_TRADING=false');

    const overflow = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('expert view preserves the canonical research evidence surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntime(page);
  await page.goto('/research-center');

  await expect(page.getByRole('button', { name: '전문가 보기', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('research-center-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '검증 리포트', exact: true })).toBeVisible();

  await page.getByRole('tab', { name: '검증 리포트', exact: true }).click();
  await expect(page.getByText('Research source SHA', { exact: true })).toBeVisible();
  await expect(page.getByText('Dataset identity', { exact: true })).toBeVisible();
  await expect(page.getByText('Profitability proof', { exact: true })).toBeVisible();
});

test('copilot entry keeps the established button contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/research-center');

  const copilot = page.getByRole('button', { name: 'AI Research Copilot', exact: true });
  await expect(copilot).toBeVisible();
  await copilot.click();
  await expect(page.getByTestId('research-general-view')).toHaveCount(0);
});
