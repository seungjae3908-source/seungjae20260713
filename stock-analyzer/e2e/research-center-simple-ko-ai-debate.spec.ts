import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-09-02T01:25:30.000Z';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const RESEARCH_SHA = '1111111111111111111111111111111111111111';
const SCREENSHOT_DIR = path.resolve(process.cwd(), '../docs/screenshots/research-center-v2');

async function captureScreenshot(page: Page, name: string) {
  if (process.env.CAPTURE_RESEARCH_SCREENSHOTS !== 'true') return;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const scrollContainer = page.getByTestId('research-center-page');
  if (await scrollContainer.count()) {
    await scrollContainer.evaluate((element) => {
      element.querySelectorAll<HTMLElement>('*').forEach((child) => { child.scrollTop = 0; });
      let current: HTMLElement | null = element as HTMLElement;
      while (current) {
        current.scrollTop = 0;
        current = current.parentElement;
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(50);
  }
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, name), fullPage: true });
}

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function overview(aiDebate?: Record<string, unknown>) {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: Date.parse(NOW),
    state: { present: true, latestCycleAt: Date.parse('2026-09-02T01:11:35.000Z') },
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
      blockedDataTasks: 0,
      cycles: [{
        profile: 'forward', present: true, status: 'success', researchSha: RESEARCH_SHA,
        generatedAt: Date.parse('2026-09-02T01:11:35.000Z'), taskCount: 2, successCount: 2,
        blockedDataCount: 0, failedCount: 0,
        tasks: [
          { id: 'shadow-forward', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
          { id: 'paper-forward', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
        ],
      }],
    },
    paper: {
      runtime: {
        present: true, status: 'not_started', scheduleActive: false, allProvidersReady: true,
        publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: false,
        privateRequestCount: 0, financialMutationCount: 0, orderCount: 0,
        liveTrading: false, orderAuthority: false, safetyEvidenceComplete: true,
        lanes: [{ market: 'KR_STOCK', status: 'ready' }],
      },
      ledger: { present: true, cycleCount: 8, sampleCount: 0, positionCount: 0, settlementCount: 0 },
    },
    shadow: {
      groups: [
        { name: 'crypto-futures-15m', total: 244, settled: 240, pending: 4, collapsed: false, macroF1: null, balancedAccuracy: null },
        { name: 'crypto-futures-1h', total: 244, settled: 220, pending: 24, collapsed: false, macroF1: null, balancedAccuracy: null },
      ],
      records: { present: true, totalRecords: 488, settledRecords: 460, pendingRecords: 28 },
    },
    profitability: {
      proven: false,
      status: 'evidence_collection',
      note: 'Paper 정산과 미래 표본이 충분히 쌓이기 전에는 수익성을 증명된 것으로 표시하지 않습니다.',
    },
    champion: { currentValidatedChampion: null },
    strategyHealth: {
      status: 'MISSING_EVIDENCE',
      evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth',
      canonicalCoreStatus: null,
      inputs: {
        settlement: { status: 'MISSING_EVIDENCE', reason: 'NATURAL_SETTLEMENT_MISSING', source: 'paper.ledger', observedCount: 0 },
      },
      reasons: ['settlement:NATURAL_SETTLEMENT_MISSING'],
      executionAuthority: 'NONE',
    },
    ...(aiDebate ? { aiDebate } : {}),
  };
}

function emptyOverview() {
  const value = overview();
  value.state = { present: false, latestCycleAt: null as unknown as number };
  value.research.cycles = [];
  value.paper.runtime = {
    ...value.paper.runtime,
    present: false,
    status: 'not_started',
    scheduleActive: null as unknown as boolean,
    allProvidersReady: null as unknown as boolean,
  };
  value.paper.ledger = { present: false, cycleCount: null as unknown as number, sampleCount: null as unknown as number, positionCount: null as unknown as number, settlementCount: null as unknown as number };
  value.shadow = { groups: [], records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null } };
  delete (value as Record<string, unknown>).champion;
  return value;
}

function stage(stageName: string, status: string, extras: Record<string, unknown> = {}) {
  return {
    stage: stageName,
    status,
    startedAt: status === 'PASS' ? NOW : null,
    completedAt: status === 'PASS' ? NOW : null,
    observedAt: NOW,
    source: 'canonical-owner',
    provider: status === 'PASS' ? 'CANONICAL_PROVIDER' : null,
    sourceSha: status === 'PASS' ? RESEARCH_SHA : null,
    datasetId: status === 'PASS' ? `dataset-${stageName.toLowerCase()}` : null,
    dataRange: status === 'PASS' ? { start: '2025-01-01', end: '2026-08-31' } : null,
    sampleSize: status === 'PASS' ? 842 : null,
    sampleCount: status === 'PASS' ? 842 : null,
    tradeCount: status === 'PASS' ? 842 : null,
    metrics: status === 'PASS' ? { tradeCount: 842, hitRate: 0.54, profitFactor: 1.31, maxDrawdownPercent: -6.2 } : null,
    gate: `${stageName}_EVIDENCE_REQUIRED`,
    gateResult: status,
    failureReason: status === 'PASS' ? null : `${stageName}_${status}`,
    failureReasons: status === 'PASS' ? [] : [`${stageName}_${status}`],
    provenance: status === 'PASS' ? ['immutable canonical test fixture'] : [],
    costAssumptions: null,
    costPolicy: null,
    dataQuality: status === 'PASS' ? 'VERIFIED' : 'UNLINKED',
    fetchedAt: status === 'PASS' ? NOW : null,
    validatedAt: status === 'PASS' ? NOW : null,
    corporateActionAdjusted: status === 'PASS' ? true : null,
    survivorshipSafe: status === 'PASS' ? true : null,
    pointInTimeSafe: status === 'PASS' ? true : null,
    requiredEvidence: [],
    ...extras,
  };
}

function promotions() {
  const stages = [
    stage('RESEARCH_DESIGN', 'PASS'),
    stage('HISTORICAL_BACKTEST', 'PASS'),
    stage('OUT_OF_SAMPLE', 'BLOCKED'),
    stage('PURGED_WALK_FORWARD', 'NOT_STARTED'),
    stage('COST_STRESS', 'NOT_STARTED'),
    stage('REGIME', 'NOT_STARTED'),
    stage('FINAL_HOLDOUT', 'NOT_STARTED'),
    stage('PAPER', 'NOT_STARTED'),
    stage('SHADOW', 'NOT_STARTED'),
    stage('RECOMMENDATION_OUTCOMES', 'NOT_STARTED'),
  ];
  return {
    ok: true,
    generatedAt: NOW,
    sourceSha: RESEARCH_SHA,
    policyVersion: 'e2e-readonly',
    items: [{
      identity: {
        strategyFamily: 'TEST', strategyId: 'strategy-1', strategyVersion: 'v1', version: 'v1',
        parameterHash: 'parameter', market: 'CRYPTO_FUTURES', assetClass: 'CRYPTO_FUTURES', symbol: null,
        universe: 'TEST', timeframe: '15m', strategyHorizon: 'SCALP', horizon: 'SCALP', direction: 'LONG',
        researchCodeSha: RESEARCH_SHA, costPolicyVersion: 'cost-v1', riskPolicyVersion: 'risk-v1',
      },
      promotionState: 'BLOCKED_DATA',
      stages,
      drift: { status: 'INSUFFICIENT_SAMPLE', classification: null, reason: '표본 수집 중', observedSampleSize: null },
      killState: 'NONE', blockers: ['OUT_OF_SAMPLE_BLOCKED'], promotionEligible: false,
      executionAuthority: 'NONE', liveTradingAuthority: false, privateTradingApiCount: 0,
    }],
    counts: { BLOCKED_DATA: 1 },
    evidenceSources: [
      { id: 'CANONICAL_SCANNER_PROFILE', owner: 'scanner-strategy-profile.service.ts', status: 'AVAILABLE', use: 'strategy identity', executionAuthority: 'NONE' },
      { id: 'PREDICTION_LAB', owner: 'market-prediction-lab', status: 'UNLINKED', use: 'walk-forward evidence', executionAuthority: 'NONE' },
    ],
    promotionCandidates: 0,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
  };
}

async function installAdmin(page: Page, researchOverview: unknown, promotionBody: unknown = promotions(), promotionStatus = 200) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({
      access_token: accessToken,
      refresh_token: 'research-center-refresh',
      expires_in: 3600,
      expires_at: expiresAt,
      token_type: 'bearer',
      user: {
        id: userId, aud: 'authenticated', role: 'authenticated', email: 'research-admin@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: { display_name: '연구 관리자' }, identities: [], created_at: now,
      },
    }));
    (window as unknown as { __unhandledResearch?: string[] }).__unhandledResearch = [];
    window.addEventListener('unhandledrejection', (event) => {
      (window as unknown as { __unhandledResearch: string[] }).__unhandledResearch.push(String(event.reason));
    });
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], mutations: [] as string[], http5xx: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') diagnostics.mutations.push(`${request.method()} ${url.pathname}`);
  });
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 500) diagnostics.http5xx.push(`${response.status()} ${url.pathname}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID, login_name: 'research-admin', display_name: '연구 관리자', role: 'admin', status: 'approved',
        membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW,
      });
    }
    if (pathname.endsWith('/auth/v1/user')) {
      return fulfill(route, {
        id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'research-admin@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '연구 관리자' }, identities: [], created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/research/overview') return fulfill(route, researchOverview);
    if (path === '/api/strategy-promotion') return fulfill(route, promotionBody, promotionStatus);
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  return {
    async assertClean(options: { allow5xx?: boolean } = {}) {
      const unexpectedConsoleErrors = options.allow5xx
        ? diagnostics.consoleErrors.filter((message) => !message.includes('Failed to load resource: the server responded with a status of 503'))
        : diagnostics.consoleErrors;
      expect(unexpectedConsoleErrors, unexpectedConsoleErrors.join('\n')).toEqual([]);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.mutations, diagnostics.mutations.join('\n')).toEqual([]);
      if (!options.allow5xx) expect(diagnostics.http5xx, diagnostics.http5xx.join('\n')).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __unhandledResearch: string[] }).__unhandledResearch)).toEqual([]);
    },
  };
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
}

test('Research Center V2 exposes exactly four tabs and every required click-through on desktop', async ({ page }) => {
  const { assertClean } = await installAdmin(page, overview());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/research-center');

  await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('tab').allTextContents()).resolves.toEqual(['연구 현황', 'AI 분석실', '검증 리포트', '모의매매']);
  const tabs = page.getByRole('tab');
  await tabs.nth(0).focus();
  await tabs.nth(0).press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await tabs.nth(1).press('End');
  await expect(tabs.nth(3)).toBeFocused();
  await tabs.nth(3).press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(page.getByTestId('research-overview-tab')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('한눈에 보기');
  await expect(page.locator('body')).not.toContainText('AI 토론');
  await expect(page.locator('body')).not.toContainText('상세 증거');
  await captureScreenshot(page, 'after-desktop-research-status.png');

  for (const key of ['external-research', 'backtest', 'oos', 'shadow', 'settlement', 'profitability', 'champion']) {
    await page.getByTestId(`research-stage-${key}`).click();
    await expect(page.getByTestId(`research-detail-${key}`)).toBeVisible();
  }

  await page.getByTestId('research-stage-paper').click();
  await expect(page.getByTestId('research-paper-tab')).toBeVisible();
  await expect(page.getByText('실주문 비활성')).toBeVisible();
  await expect(page.getByTestId('paper-open-positions')).toContainText('열린 모의 포지션 없음');
  await expect(page.getByTestId('paper-recent-settlements')).toContainText('표본 없음');
  await expect(page.getByTestId('paper-full-cost')).toContainText('FULL_COST_READY · 자료 부족');
  await expect(page.getByTestId('research-paper-tab')).toContainText('PRIVATE_TRADING_API_ALLOWED=false');
  await expect(page.getByTestId('research-paper-tab')).toContainText('executionAuthority=NONE');
  await captureScreenshot(page, 'after-desktop-paper.png');

  await page.getByRole('tab', { name: 'AI 분석실' }).click();
  await expect(page.getByTestId('research-ai-lab-tab')).toContainText('AI 분석 근거 미수집');
  await page.getByRole('textbox', { name: '연구 근거 질문' }).fill('수익성과 PF는?');
  await page.getByRole('button', { name: '근거에서 찾기' }).click();
  await expect(page.locator('output')).toContainText('승률·PF·MDD를 임의 생성하지 않습니다');
  await captureScreenshot(page, 'after-desktop-ai-lab.png');

  await page.getByRole('tab', { name: '검증 리포트' }).click();
  await expect(page.getByTestId('research-evidence-tab')).toContainText(RESEARCH_SHA);
  await expect(page.getByTestId('research-evidence-tab')).toContainText('Current main SHA');
  await expect(page.getByTestId('research-evidence-tab')).toContainText('미수집');
  await captureScreenshot(page, 'after-desktop-validation-report.png');
  await expectNoHorizontalOverflow(page);
  await assertClean();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`Research Center V2 mobile ${viewport.width} has no clipping or bottom-nav overlap`, async ({ page }) => {
    const { assertClean } = await installAdmin(page, overview());
    await page.setViewportSize(viewport);
    await page.goto('/research-center');
    await expect(page.getByRole('tab')).toHaveCount(4);
    await page.getByTestId('research-stage-backtest').click();
    await expect(page.getByTestId('research-detail-backtest')).toBeVisible();
    await page.getByRole('tab', { name: '모의매매' }).click();
    await expect(page.getByTestId('research-paper-tab')).toBeVisible();
    await captureScreenshot(page, `after-mobile-${viewport.width}-paper.png`);
    await expectNoHorizontalOverflow(page);
    const geometry = await page.evaluate(() => {
      const main = document.querySelector('[data-testid="research-center-page"]')!.getBoundingClientRect();
      const nav = document.querySelector('nav[aria-label="하단 내비게이션"]')?.getBoundingClientRect();
      return { mainWidth: main.width, viewportWidth: window.innerWidth, navTop: nav?.top ?? window.innerHeight };
    });
    expect(geometry.mainWidth).toBeLessThanOrEqual(geometry.viewportWidth + 2);
    expect(geometry.navTop).toBeGreaterThan(0);
    await assertClean();
  });
}

test('CASE A all missing stays empty rather than fabricated zero', async ({ page }) => {
  const { assertClean } = await installAdmin(page, emptyOverview(), { error: 'PROMOTION_UNAVAILABLE' }, 503);
  await page.goto('/research-center');
  await expect(page.getByTestId('research-partial-state')).toBeVisible();
  await page.getByRole('tab', { name: '모의매매' }).click();
  await expect(page.getByTestId('research-paper-tab')).toContainText('미측정');
  await expect(page.getByTestId('paper-open-positions')).toContainText('자료 없음');
  await expect(page.locator('body')).not.toContainText('0원');
  await expect(page.locator('body')).not.toContainText('0.00');
  await assertClean({ allow5xx: true });
});

test('captures the legacy Research Center baseline for PR evidence', async ({ page }) => {
  test.skip(process.env.CAPTURE_RESEARCH_BASELINE !== 'true', 'baseline capture is opt-in');
  await installAdmin(page, overview());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(process.env.RESEARCH_BASELINE_URL ?? '/research-center');
  await expect(page.getByTestId('research-summary-tab')).toBeVisible();
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'before-desktop-research-center.png'), fullPage: true });
});

test('CASE B Shadow-only preserves observed counts and leaves other evidence missing', async ({ page }) => {
  const value = emptyOverview();
  value.state.present = true;
  value.shadow = overview().shadow;
  const { assertClean } = await installAdmin(page, value);
  await page.goto('/research-center');
  await page.getByTestId('research-stage-shadow').click();
  await expect(page.getByTestId('research-detail-shadow')).toContainText('488');
  await page.getByTestId('research-stage-settlement').click();
  await expect(page.getByTestId('research-detail-settlement')).toContainText('MISSING');
  await assertClean();
});

test('CASE C Paper inactive remains inactive with no performance claim', async ({ page }) => {
  const { assertClean } = await installAdmin(page, overview());
  await page.goto('/research-center');
  await page.getByRole('tab', { name: '모의매매' }).click();
  await expect(page.getByTestId('research-paper-tab')).toContainText('미활성');
  await expect(page.getByTestId('research-paper-tab')).toContainText('표본 없음');
  await expect(page.getByTestId('research-paper-tab')).toContainText('아직 검증되지 않음');
  await expect(page.getByTestId('research-paper-tab')).not.toContainText('수익성 없음');
  await assertClean();
});

test('CASE D active Paper with Settlement N=0 shows running and empty sample', async ({ page }) => {
  const value = overview();
  value.paper.runtime.status = 'running';
  value.paper.runtime.scheduleActive = true;
  const { assertClean } = await installAdmin(page, value);
  await page.goto('/research-center');
  await page.getByRole('tab', { name: '모의매매' }).click();
  const paper = page.getByTestId('research-paper-tab');
  await expect(paper).toContainText('실행 중');
  await expect(paper).toContainText('Settlement 없음 · 표본 없음');
  await expect(paper).toContainText('Profit Factor');
  await expect(paper).not.toContainText('0.00');
  await assertClean();
});

test('CASE E existing Settlement with missing cost stays partial and unavailable is not zero', async ({ page }) => {
  const value = overview();
  value.paper.runtime.status = 'running';
  value.paper.runtime.scheduleActive = true;
  value.paper.ledger = { present: true, cycleCount: 12, sampleCount: 7, positionCount: 2, settlementCount: 5 };
  const { assertClean } = await installAdmin(page, value);
  await page.goto('/research-center');
  await page.getByRole('tab', { name: '모의매매' }).click();
  await expect(page.getByTestId('paper-recent-settlements')).toContainText('Settlement 5건');
  await expect(page.getByTestId('paper-full-cost')).toContainText('Commission');
  await expect(page.getByTestId('paper-full-cost')).toContainText('자료 부족');
  await expect(page.getByTestId('paper-full-cost')).not.toContainText('0.0000%');
  await assertClean();
});

test('actual canonical AI evidence is rendered without granting AI trading authority', async ({ page }) => {
  const aiDebate = {
    dualAiReviewStatus: 'CONFLICT',
    ai1Review: { conclusion: 'SUPPORTS_FURTHER_RESEARCH', providerId: 'google-gemini', modelId: 'gemini-model', findings: [{ statement: 'Forward evidence supports more research.' }] },
    ai2Review: { conclusion: 'OPPOSES_FURTHER_RESEARCH', providerId: 'groq', modelId: 'groq-model', findings: [{ statement: 'Settlement evidence is insufficient.' }] },
    reviewConflictReason: '미래 관찰은 있으나 모의정산 증거가 부족합니다.',
  };
  const { assertClean } = await installAdmin(page, overview(aiDebate));
  await page.goto('/research-center');
  await page.getByRole('tab', { name: 'AI 분석실' }).click();
  const lab = page.getByTestId('research-ai-lab-tab');
  await expect(lab).toContainText('AI 의견이 충돌했습니다');
  await expect(lab).toContainText('google-gemini');
  await expect(lab).toContainText('groq');
  await expect(lab).toContainText('AI numeric authority 없음');
  await assertClean();
});
