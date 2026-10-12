import { expect, test, type Page, type Route } from '@playwright/test';
import {
  checkedPITSelection, collectPITMinuteCoveragePeriod, isValidPITCoverageResponse,
  type PITSelection,
} from '../src/lib/research-pit-minute-coverage-period';

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

    await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
    const expertButton = page.getByRole('button', { name: '연구', exact: true });
    const generalButton = page.getByRole('button', { name: '요약', exact: true });
    await expect(generalButton).toHaveAttribute('aria-pressed', 'true');
    await expect(expertButton).toBeVisible();
    await expect(page.getByRole('button', { name: 'AI', exact: true })).toBeVisible();

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
    for (const [id, label] of [
      ['research', '연구 상태'],
      ['data', '데이터 수집'],
      ['paper', '모의매매 표본'],
      ['profitability', '수익성 검증'],
    ] as const) {
      await expect(page.getByTestId(`research-summary-${id}`).getByText(label, { exact: true })).toBeVisible();
    }
    const scrollBefore = await general.locator('main').evaluate(element => element.scrollTop);
    await paperCard.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await general.locator('main').evaluate(element => element.scrollTop)).toBe(scrollBefore);
    await expect(page.getByTestId('research-general-selected-detail')).not.toContainText('다음에 뭘 보면 되나요?');
    const fullCost = page.getByTestId('research-full-cost-summary');
    await expect(fullCost).toBeVisible();
    await expect(fullCost).toContainText('비용 검증 · 미충족');
    await expect(fullCost).toContainText('4/8');
    await expect(fullCost).toContainText('후보 정산 3건 연결');
    await expect(fullCost).toContainText('CANONICAL_SUPPLEMENTAL_COST_EVIDENCE_MISSING');
    await expect(page.getByTestId('research-full-cost-commission')).toContainText('관측됨');
    await expect(page.getByTestId('research-full-cost-commission')).toContainText('public:commission');
    await expect(page.getByTestId('research-full-cost-slippage')).toContainText('모델값 · 실측 아님');
    await expect(page.getByTestId('research-full-cost-latency')).toContainText('미확인');
    await expect(page.getByTestId('research-full-cost-liquidityImpact')).toContainText('데이터 차단');
    await expect(page.getByTestId('research-full-cost-partialFillImpact')).toContainText('최신성 · 미제공');
    await expect(page.getByTestId('research-full-cost-partialFillImpact')).toContainText('품질 · 미제공');
    await expect(page.getByTestId('research-workspace-tabs').getByRole('button')).toHaveCount(6);

    const overflow = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth,
    ) - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
    const geometry = await page.getByRole('dialog').boundingBox();
    expect(geometry!.width).toBeLessThan(width);
    expect(geometry!.height).toBeLessThan(height);
    expect(await page.getByRole('dialog').evaluate(element => getComputedStyle(element).backgroundColor)).not.toMatch(/rgba\([^)]*,\s*0\.?\d*\)$/);
    await page.keyboard.press('Tab');
    expect(await page.getByRole('dialog').evaluate(element => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(paperCard).toBeFocused();
  });
}

test('expert view preserves the canonical research evidence surface', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRuntime(page);
  await page.goto('/research-center');

  const expert = page.getByRole('button', { name: '연구', exact: true });
  await expert.click();
  await expect(expert).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('research-center-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: '연구 현황', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '검증', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '검증', exact: true }).click();
  await page.getByText('연결 식별자', { exact: true }).click();
  await expect(page.getByText('소스 버전', { exact: true })).toBeVisible();
  await expect(page.getByText('데이터 식별자', { exact: true })).toBeVisible();
  await expect(page.getByText('수익성 입증', { exact: true })).toBeVisible();
});

test('copilot entry keeps the established button contract', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  await page.goto('/research-center');

  const copilot = page.getByRole('button', { name: 'AI', exact: true });
  await expect(copilot).toBeVisible();
  await copilot.click();
  await expect(page.getByTestId('research-general-view')).toHaveCount(0);
});

test('admin historical 1m coverage reads and aggregates the full selected period with authenticated bounded pages', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installRuntime(page);
  const reads: Array<{ method: string; token: string; market: string | null; start: string | null; end: string | null; cursor: string | null; hasPath: boolean }> = [];
  await page.route('**/api/research/video/evidence/workspace/pit-minute-coverage?*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    reads.push({
      method: request.method(),
      token: request.headers().authorization ?? '',
      market: url.searchParams.get('market'),
      start: url.searchParams.get('startDate'),
      end: url.searchParams.get('endDate'),
      cursor: url.searchParams.get('cursorDate'),
      hasPath: [...url.searchParams.keys()].some(key => /path|root|file|token|secret|provider/i.test(key)),
    });
    const second = url.searchParams.get('cursorDate') != null;
    const firstDate = second ? '2016-02-01' : '2016-01-01';
    await fulfill(route, {
      schemaVersion: 'research-pit-minute-coverage-readonly-v1',
      available: true,
      status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
      reason: 'MISSING_HISTORICAL_MINUTE_DATE_RECEIPT',
      executionAuthority: 'NONE',
      profitabilityProven: false,
      report: {
        status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
        reason: 'MISSING_HISTORICAL_MINUTE_DATE_RECEIPT',
        inspectedStartDate: firstDate,
        inspectedEndDate: second ? '2016-02-09' : '2016-01-31',
        nextCursorDate: second ? null : '2016-02-01',
        expectedHistoricalTradingDays: 5,
        missingSourceDays: 4,
        partialSourceDays: 1,
        locallyCompleteMinuteSourceDays: 0,
        retrospectiveMinuteRows: 120,
        sourceMinuteRows: 120,
        dailyReadiness: [
          { date: firstDate, status: 'BLOCKED_DATA', originalMinuteRows: null },
          { date: second ? '2016-02-04' : '2016-01-04',
            status: 'INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY',
            originalMinuteRows: 120 },
        ],
        originalScannerAsOfEvidenceVerified: false,
        fullMarketOpportunityDenominatorVerified: false,
        profitabilityProven: false,
        executionAuthority: 'NONE',
      },
    });
  });
  await page.goto('/research-center');
  // Enter the current general → research → validation navigation, not the retired 상세 entry.
  await page.getByRole('button', { name: '연구', exact: true }).click();
  await page.getByRole('button', { name: '검증', exact: true }).click();
  const panel = page.getByTestId('research-pit-minute-coverage');
  await expect(panel).toBeVisible();
  await panel.getByLabel('과거 데이터 시장').selectOption('US_STOCK');
  await panel.getByLabel('과거 데이터 시작일').fill('2016-01-01');
  await panel.getByLabel('과거 데이터 종료일').fill('2016-02-09');
  await panel.getByRole('button', { name: '선택 기간 전체 조회' }).click();
  await expect(panel).toContainText('전체 조회 구간: 2016-01-01 ~ 2016-02-09');
  await expect(panel).toContainText('누락된 날짜');
  await expect(panel).toContainText('사후 수집 분봉');
  await expect(panel).toContainText('최초 신호 탐지·OOS·실체결·수익성 미검증');
  await expect(panel).toContainText('확인된 구간: 2/2');
  expect(reads).toHaveLength(2);
  expect(reads.map(r => [r.method, r.market, r.start, r.end, r.cursor, r.hasPath])).toEqual([
    ['GET', 'US_STOCK', '2016-01-01', '2016-02-09', null, false],
    ['GET', 'US_STOCK', '2016-01-01', '2016-02-09', '2016-02-01', false],
  ]);
  expect(reads.every(r => r.token.startsWith('Bearer '))).toBe(true);
});

test('historical 1m coverage UI fails closed after 403 or an unsafe response, without showing source totals', async ({ page }) => {
  await installRuntime(page);
  let mockKind: 'denied' | 'unsafe' = 'denied';
  await page.route('**/api/research/video/evidence/workspace/pit-minute-coverage?*', async route => {
    if (mockKind === 'denied') {
      return fulfill(route, { error: 'CAPABILITY_REQUIRED' }, 403);
    }
    return fulfill(route, {
      schemaVersion: 'research-pit-minute-coverage-readonly-v1',
      available: true, status: 'SOURCE_ATTESTED',
      executionAuthority: 'LIVE',
      profitabilityProven: true,
      report: { executionAuthority: 'LIVE', profitabilityProven: true },
    });
  });
  await page.goto('/research-center');
  // Enter the current general → research → validation navigation, not the retired 상세 entry.
  await page.getByRole('button', { name: '연구', exact: true }).click();
  await page.getByRole('button', { name: '검증', exact: true }).click();
  const panel = page.getByTestId('research-pit-minute-coverage');
  await panel.getByRole('button', { name: '선택 기간 전체 조회' }).click();
  await expect(panel.getByRole('alert')).toContainText('관리자 권한이 필요한 자료입니다.');
  await expect(panel.getByText('보관된 1분봉')).toHaveCount(0);
  mockKind = 'unsafe';
  await panel.getByLabel('과거 데이터 시장').selectOption('US_STOCK');
  await panel.getByRole('button', { name: '선택 기간 전체 조회' }).click();
  await expect(panel.getByRole('alert')).toContainText('검증되지 않은 응답은 표시하지 않습니다.');
  await expect(panel.getByText('보관된 1분봉')).toHaveCount(0);
});


test('same-window admin recheck revokes previously displayed source totals after a new 403', async ({ page }) => {
  await installRuntime(page);
  let calls = 0;
  await page.route('**/api/research/video/evidence/workspace/pit-minute-coverage?*', async route => {
    calls += 1;
    if (calls > 1) return fulfill(route, { error: 'CAPABILITY_REQUIRED' }, 403);
    return fulfill(route, {
      schemaVersion: 'research-pit-minute-coverage-readonly-v1',
      available: true,
      status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
      reason: 'SOURCE_PARTIAL',
      executionAuthority: 'NONE', profitabilityProven: false,
      report: {
        status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
        reason: 'SOURCE_PARTIAL',
        inspectedStartDate: '2026-09-18', inspectedEndDate: '2026-09-19',
        nextCursorDate: null, expectedHistoricalTradingDays: 2,
        missingSourceDays: 1, partialSourceDays: 1,
        locallyCompleteMinuteSourceDays: 0,
        retrospectiveMinuteRows: 0, sourceMinuteRows: 240,
        dailyReadiness: [{ date: '2026-09-18',
          status: 'INCOMPLETE_SOURCE_ATTESTED_DAY_MINUTE_INVENTORY',
          originalMinuteRows: 240 }],
        originalScannerAsOfEvidenceVerified: false,
        fullMarketOpportunityDenominatorVerified: false,
        profitabilityProven: false, executionAuthority: 'NONE',
      },
    });
  });
  await page.goto('/research-center');
  // Enter the current general → research → validation navigation, not the retired 상세 entry.
  await page.getByRole('button', { name: '연구', exact: true }).click();
  await page.getByRole('button', { name: '검증', exact: true }).click();
  const panel = page.getByTestId('research-pit-minute-coverage');
  await panel.getByLabel('과거 데이터 시작일').fill('2026-09-18');
  await panel.getByLabel('과거 데이터 종료일').fill('2026-09-19');
  await panel.getByRole('button', { name: '선택 기간 전체 조회' }).click();
  await expect(panel).toContainText('240');
  await expect(panel.getByText('보관된 1분봉')).toBeVisible();
  await panel.getByRole('button', { name: '선택 기간 전체 조회' }).click();
  await expect(panel.getByRole('alert')).toContainText('관리자 권한이 필요한 자료입니다.');
  await expect(panel.getByText('보관된 1분봉')).toHaveCount(0);
  await expect(panel.getByText('240', { exact: true })).toHaveCount(0);
  expect(calls).toBe(2);
});


test('full ten-year PIT inventory uses bounded GET planning and never implies market-wide trade PASS', async () => {
  const selection = {
    market: 'CRYPTO_SPOT' as const, startDate: '2016-01-01',
    endDate: '2025-12-31', cursorDate: null,
  };
  const plan = checkedPITSelection(selection);
  expect(plan.pages).toBeGreaterThan(110);
  let calls = 0, active = 0, peak = 0;
  let lastProgress = [0, 0];
  const reader = async (request: PITSelection) => {
    calls += 1; active += 1; peak = Math.max(peak, active);
    await Promise.resolve();
    const from = request.cursorDate ?? request.startDate;
    const fromMs = Date.parse(from + 'T00:00:00Z');
    const toMs = Math.min(Date.parse(request.endDate + 'T00:00:00Z'),
      fromMs + 30 * 86_400_000);
    const to = new Date(toMs).toISOString().slice(0, 10);
    const next = toMs < Date.parse(request.endDate + 'T00:00:00Z')
      ? new Date(toMs + 86_400_000).toISOString().slice(0, 10) : null;
    active -= 1;
    return {
      schemaVersion: 'research-pit-minute-coverage-readonly-v1',
      available: true, status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
      reason: 'TEST_ONLY_INCOMPLETE_SOURCE',
      profitabilityProven: false, executionAuthority: 'NONE',
      report: {
        status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
        reason: 'TEST_ONLY_INCOMPLETE_SOURCE',
        inspectedStartDate: from, inspectedEndDate: to, nextCursorDate: next,
        expectedHistoricalTradingDays: 1, locallyCompleteMinuteSourceDays: 0,
        missingSourceDays: 1, partialSourceDays: 0,
        sourceMinuteRows: 0, retrospectiveMinuteRows: 0, dailyReadiness: [],
        originalScannerAsOfEvidenceVerified: false,
        fullMarketOpportunityDenominatorVerified: false,
        profitabilityProven: false, executionAuthority: 'NONE',
      },
    };
  };
  const result = await collectPITMinuteCoveragePeriod(
    selection, reader, undefined, (done, total) => { lastProgress = [done, total]; },
  );
  expect(calls).toBe(plan.pages);
  expect(peak).toBeLessThanOrEqual(3);
  expect(lastProgress).toEqual([plan.pages, plan.pages]);
  expect(result.report?.checkedPageCount).toBe(plan.pages);
  expect(result.report?.inspectedStartDate).toBe(selection.startDate);
  expect(result.report?.inspectedEndDate).toBe(selection.endDate);
  expect(result.report?.missingSourceDays).toBe(plan.pages);
  expect(result.report?.originalScannerAsOfEvidenceVerified).toBe(false);
  expect(result.report?.fullMarketOpportunityDenominatorVerified).toBe(false);
  expect(result.profitabilityProven).toBe(false);
  expect(result.executionAuthority).toBe('NONE');
});

test('PIT period parser rejects incorrect counters, untrusted statuses and wrong next cursor', async () => {
  const selection = {
    market: 'US_STOCK' as const, startDate: '2026-09-18',
    endDate: '2026-09-19', cursorDate: null,
  };
  const base = {
    schemaVersion: 'research-pit-minute-coverage-readonly-v1',
    available: true, status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
    reason: 'SOURCE_PARTIAL', profitabilityProven: false, executionAuthority: 'NONE',
    report: {
      status: 'INCOMPLETE_OR_BLOCKED_COMPACT_PIT_MINUTE_DATE_CHUNK',
      reason: 'SOURCE_PARTIAL', inspectedStartDate: '2026-09-18',
      inspectedEndDate: '2026-09-19', nextCursorDate: null,
      expectedHistoricalTradingDays: 2, locallyCompleteMinuteSourceDays: 0,
      missingSourceDays: 2, partialSourceDays: 0, sourceMinuteRows: 0,
      retrospectiveMinuteRows: 0, dailyReadiness: [],
      originalScannerAsOfEvidenceVerified: false,
      fullMarketOpportunityDenominatorVerified: false,
      profitabilityProven: false, executionAuthority: 'NONE',
    },
  };
  expect(isValidPITCoverageResponse(base)).toBe(true);
  expect(isValidPITCoverageResponse({
    ...base, report: { ...base.report, sourceMinuteRows: -1 },
  })).toBe(false);
  expect(isValidPITCoverageResponse({
    ...base, report: { ...base.report, dailyReadiness: [
      { date: '2026-09-18', status: 'BLOCKED_DATA', originalMinuteRows: Number.NaN },
    ] },
  })).toBe(false);
  expect(isValidPITCoverageResponse({
    ...base, report: { ...base.report, executionAuthority: 'LIVE' },
  })).toBe(false);
  await expect(collectPITMinuteCoveragePeriod(
    selection, async () => ({ ...base, report: {
      ...base.report, nextCursorDate: '2026-09-19',
    } }),
  )).rejects.toThrow('다음 페이지');
});
