import { expect, test, type Page, type Route } from '@playwright/test';

const USER = '77777777-7777-4777-8777-777777777777';
const AUTH_KEY = 'sb-127-auth-token';
const NOW = Date.parse('2026-09-24T09:00:00Z');
const RESEARCH_SHA = '1111111111111111111111111111111111111111';

function candidatePerformance() {
  return {
    present: true,
    status: 'PRESENT',
    schemaVersion: 'frozen-candidate-performance-reader-v1',
    FIRST_ZERO: 'CANONICAL_TRIGGER_READBACK_NOT_EXPOSED',
    reason: 'Trigger readback과 일부 비용 근거가 아직 연결되지 않았습니다.',
    candidateId: 'paper-candidate-v1:test',
    strategyId: 'strategy-v1',
    freezeTimestamp: '2026-09-24T08:00:00.000Z',
    identity14Verified: true,
    fullCostEvidence: {
      fullCostReady: false,
      components: {
        commission: { state: 'MEASURED', valuePercent: 0.02, provenance: 'public:commission' },
        tax: { state: 'MEASURED', valuePercent: 0, provenance: 'public:tax' },
        spread: { state: 'MEASURED', valuePercent: 0.01, provenance: 'public:spread' },
        slippage: { state: 'MODELED', valuePercent: 0.03, provenance: 'model:slippage' },
        funding: { state: 'UNKNOWN', valuePercent: null, provenance: null },
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
    Entry_N: 4,
    Position_N: 2,
    PositionObservation_N: 4,
    Settlement_N: 1,
    TRAIN_N: 12,
    VALIDATION_N: 0,
    OOS_N: 0,
    WIN_N: 1,
    LOSS_N: 0,
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
    Gross_PnL: 18.25,
    Net_PnL: 15.5,
    FULL_COST_READY: false,
    NET_ALPHA_PROVEN: false,
    PROFITABILITY_PROVEN: false,
    TRAIN_DIAGNOSTIC_ONLY: true,
    VALIDATION_COMPLETE: false,
    OOS_COMPLETE: false,
    executionAuthority: 'NONE',
  };
}

function overview(withCandidate = true) {
  return {
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
    research: {
      status: 'collecting',
      failedTasks: 0,
      blockedDataTasks: 1,
      cycles: [],
      liquidityIndependence: {
        present: true,
        status: 'PRESENT',
        effectiveIndependentN: 128,
        frozenSplitCounts: { TRAIN: 12, VALIDATION: 0, OOS: 0 },
      },
    },
    paper: {
      runtime: {
        present: true,
        status: 'running',
        scheduleActive: true,
        allProvidersReady: false,
        publicForwardEvidenceAccumulating: true,
        paperTradeOutcomeAccumulating: true,
        privateRequestCount: 0,
        financialMutationCount: 0,
        orderCount: 0,
        liveTrading: false,
        orderAuthority: false,
        safetyEvidenceComplete: true,
        lanes: [],
      },
      ledger: { present: true, cycleCount: 12, sampleCount: 4, positionCount: 2, settlementCount: 1 },
      ...(withCandidate ? { candidatePerformance: candidatePerformance() } : {}),
    },
    shadow: {
      groups: [],
      records: { present: true, totalRecords: 20, settledRecords: 10, pendingRecords: 10 },
    },
    profitability: {
      proven: false,
      status: 'NOT_PROVEN',
      note: 'Full Cost와 OOS 근거가 부족합니다.',
    },
    champion: { currentValidatedChampion: null },
    strategyHealth: {
      status: 'MISSING_EVIDENCE',
      evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth',
      canonicalCoreStatus: null,
      inputs: {},
      reasons: [],
      executionAuthority: 'NONE',
    },
  };
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

async function install(page: Page, body: unknown) {
  await page.addInitScript(({ authKey, user }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: expiresAt })}.e2e`;
    localStorage.setItem(authKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'closed-loop-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: user,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'closed-loop@accounts.invalid',
        app_metadata: {},
        user_metadata: {},
      },
    }));
  }, { authKey: AUTH_KEY, user: USER });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER,
        login_name: 'closed-loop-admin',
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
      return fulfill(route, { id: USER, aud: 'authenticated', role: 'authenticated', email: 'closed-loop@accounts.invalid' });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/admin/research/overview') return fulfill(route, body);
    if (pathname === '/api/strategy-promotion') {
      return fulfill(route, {
        items: [],
        counts: {},
        evidenceSources: [],
        promotionCandidates: 0,
        sourceSha: RESEARCH_SHA,
        executionAuthority: 'NONE',
      });
    }
    if (pathname === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
}

async function openPaper(page: Page) {
  await page.goto('/research-center');
  await page.getByRole('button', { name: '상세', exact: true }).click();
  await expect(page.getByTestId('research-center-page')).toBeVisible();
  await page.getByRole('tab', { name: '모의매매', exact: true }).click();
  await expect(page.getByTestId('research-paper-tab')).toBeVisible();
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`Paper closed loop shows only observed evidence at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await install(page, overview(true));
    await openPaper(page);

    const observer = page.getByTestId('paper-closed-loop-observer');
    await expect(observer).toBeVisible();
    await expect(observer).toContainText('Candidate → Entry → Position → Trigger → Settlement → 8 Cost → Net PnL → 매매일지');
    await expect(observer).toContainText('READ ONLY · executionAuthority=NONE');

    await expect(page.getByTestId('paper-closed-loop-candidate')).toContainText('identity 확인');
    await expect(page.getByTestId('paper-closed-loop-entry')).toContainText('4건');
    await expect(page.getByTestId('paper-closed-loop-position')).toContainText('2건');
    await expect(page.getByTestId('paper-closed-loop-trigger')).toContainText('readback 미제공');
    await expect(page.getByTestId('paper-closed-loop-trigger')).toContainText('완료로 추정하지 않습니다');
    await expect(page.getByTestId('paper-closed-loop-settlement')).toContainText('1건');
    await expect(page.getByTestId('paper-closed-loop-cost')).toContainText('3/8 실측');
    await expect(page.getByTestId('paper-closed-loop-cost')).toContainText('MODELED 1개');
    await expect(page.getByTestId('paper-closed-loop-net-pnl')).toContainText('15.5');
    await expect(page.getByTestId('paper-closed-loop-net-pnl')).toContainText('수익성 증거로 승격하지 않습니다');
    await expect(page.getByTestId('paper-closed-loop-journal')).toContainText('Research overview 미연결');

    await expect(page.getByTestId('paper-closed-loop-first-zero')).toContainText('Trigger');
    await expect(page.getByTestId('paper-closed-loop-first-zero')).toContainText('CANONICAL_TRIGGER_READBACK_NOT_EXPOSED');

    await expect(page.getByTestId('paper-closed-loop-paper-link')).toHaveAttribute('href', '/paper-trading');
    await expect(page.getByTestId('paper-closed-loop-journal-link')).toHaveAttribute('href', '/portfolio?tab=journal');

    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('missing candidate evidence stays unknown instead of borrowing aggregate Paper counts', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await install(page, overview(false));
  await openPaper(page);

  await expect(page.getByTestId('paper-closed-loop-candidate')).toContainText('MISSING');
  await expect(page.getByTestId('paper-closed-loop-entry')).toContainText('미관측');
  await expect(page.getByTestId('paper-closed-loop-position')).toContainText('미관측');
  await expect(page.getByTestId('paper-closed-loop-settlement')).toContainText('미관측');
  await expect(page.getByTestId('paper-closed-loop-net-pnl')).toContainText('미관측');
  await expect(page.getByTestId('paper-closed-loop-first-zero')).toContainText('Candidate');
  await expect(page.getByTestId('paper-closed-loop-observer')).not.toContainText('0.0000');
});
