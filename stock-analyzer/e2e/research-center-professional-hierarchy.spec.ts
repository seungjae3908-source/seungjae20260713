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
    candidatePerformance: {
      present: true,
      status: 'PRESENT',
      schemaVersion: 'frozen-candidate-performance-reader-v1',
      FIRST_ZERO: 'CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_MISSING',
      reason: '일부 비용이 아직 실제 관측 근거로 연결되지 않았습니다.',
      candidateId: 'candidate-full-cost-1',
      strategyId: 'strategy-full-cost-1',
      freezeTimestamp: '2026-09-24T08:00:00.000Z',
      identity14Verified: true,
      fullCostEvidence: {
        fullCostReady: false,
        components: {
          commission: { state: 'MEASURED', valuePercent: 0.02, provenance: 'public:commission' },
          tax: { state: 'MEASURED', valuePercent: 0, provenance: 'public:tax' },
          spread: { state: 'MEASURED', valuePercent: 0.01, provenance: 'public:spread' },
          slippage: { state: 'MODELED', valuePercent: 0.03, provenance: 'model:slippage' },
          funding: { state: 'MEASURED', valuePercent: 0.01, provenance: 'public:funding' },
          latency: { state: 'UNKNOWN', valuePercent: null, provenance: null },
          liquidityImpact: { state: 'BLOCKED_DATA', valuePercent: null, provenance: 'public:orderbook' },
          partialFillImpact: { state: 'UNKNOWN', valuePercent: null, provenance: null },
        },
      },
      effectiveIndependentMarketN: 128,
      candidateMatchedN: 12,
      LONG_SIGNAL_N: 7,
      SHORT_SIGNAL_N: 5,
      NO_TRADE_N: 0,
      Entry_N: 5,
      Position_N: 2,
      PositionObservation_N: 4,
      Settlement_N: 3,
      TRAIN_N: 12,
      VALIDATION_N: 0,
      OOS_N: 0,
      WIN_N: 2,
      LOSS_N: 1,
      BREAKEVEN_N: 0,
      WIN_RATE: null,
      AVG_WIN: null,
      AVG_LOSS: null,
      PAYOFF_RATIO: null,
      GROSS_EXPECTANCY: null,
      PF: null,
      MDD: null,
      MFE: null,
      MAE: null,
      TIME_TO_EXIT: null,
      Gross_PnL: null,
      Net_PnL: null,
      FULL_COST_READY: false,
      NET_ALPHA_PROVEN: false,
      PROFITABILITY_PROVEN: false,
      TRAIN_DIAGNOSTIC_ONLY: true,
      VALIDATION_COMPLETE: false,
      OOS_COMPLETE: false,
      executionAuthority: 'NONE',
    },
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

    await expect(page.getByRole('heading', { name: '현재 어디까지 왔나요?', exact: true })).toBeVisible();
    const expertButton = page.getByRole('button', { name: '상세', exact: true });
    const generalButton = page.getByRole('button', { name: '요약', exact: true });
    await expect(generalButton).toHaveAttribute('aria-pressed', 'true');
    await expect(expertButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI 도우미', exact: true })).toBeVisible();

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
    const paperCard = page.getByTestId('research-summary-paper');
    await expect(paperCard).toContainText('모의매매 표본');
    await paperCard.click();
    await expect(page.getByTestId('research-general-selected-detail')).toContainText('다음에 뭘 보면 되나요?');
    const fullCost = page.getByTestId('research-full-cost-summary');
    await expect(fullCost).toBeVisible();
    await expect(fullCost).toContainText('FULL_COST_READY · 미충족');
    await expect(fullCost).toContainText('4/8');
    await expect(fullCost).toContainText('후보 Settlement 3건 연결');
    await expect(fullCost).toContainText('CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_MISSING');
    await expect(page.getByTestId('research-full-cost-commission')).toContainText('관측됨');
    await expect(page.getByTestId('research-full-cost-commission')).toContainText('public:commission');
    await expect(page.getByTestId('research-full-cost-slippage')).toContainText('모델값 · 경제증거 아님');
    await expect(page.getByTestId('research-full-cost-latency')).toContainText('미확인');
    await expect(page.getByTestId('research-full-cost-liquidityImpact')).toContainText('데이터 차단');
    await expect(page.getByTestId('research-full-cost-partialFillImpact')).toContainText('Freshness · API 미제공');
    await expect(page.getByTestId('research-full-cost-partialFillImpact')).toContainText('Quality · API 미제공');
    await expect(page.getByTestId('research-workspace-selection')).toContainText('현재 · 요약');

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

  const expert = page.getByRole('button', { name: '상세', exact: true });
  await expert.click();
  await expect(expert).toHaveAttribute('aria-pressed', 'true');
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

  const copilot = page.getByRole('button', { name: 'AI 도우미', exact: true });
  await expect(copilot).toBeVisible();
  await copilot.click();
  await expect(page.getByTestId('research-general-view')).toHaveCount(0);
});
