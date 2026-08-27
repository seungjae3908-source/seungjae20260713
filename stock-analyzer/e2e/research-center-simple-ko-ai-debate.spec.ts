import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-22T01:25:30.000Z';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const RESEARCH_SHA = '28ecd6caf448d53a6bcdc02ce32c23a4745327c7';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

function overview(aiDebate?: Record<string, unknown>) {
  return {
    schemaVersion: 'research-dashboard-overview-v1',
    generatedAt: Date.parse(NOW),
    state: { present: true, latestCycleAt: Date.parse('2026-08-22T01:11:35.000Z') },
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
      cycles: [
        {
          profile: 'forward', present: true, status: 'success', researchSha: RESEARCH_SHA,
          generatedAt: Date.parse('2026-08-22T01:11:35.000Z'), taskCount: 2, successCount: 2,
          blockedDataCount: 0, failedCount: 0,
          tasks: [
            { id: 'shadow-forward', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
            { id: 'paper-forward', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
          ],
        },
        {
          profile: 'fast-historical', present: true, status: 'success', researchSha: RESEARCH_SHA,
          generatedAt: Date.parse('2026-08-21T02:45:38.000Z'), taskCount: 3, successCount: 0,
          blockedDataCount: 0, failedCount: 0,
          tasks: [
            { id: 'crypto-futures-derivatives', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
            { id: 'crypto-spot', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
            { id: 'stocks', status: 'success', durationMs: 50, startedAt: null, endedAt: null, timedOut: false },
          ],
        },
      ],
    },
    paper: {
      runtime: {
        present: true, status: 'replayed', scheduleActive: false, allProvidersReady: true,
        publicForwardEvidenceAccumulating: true, paperTradeOutcomeAccumulating: false,
        privateRequestCount: 0, financialMutationCount: 0, orderCount: 0,
        liveTrading: false, orderAuthority: false, safetyEvidenceComplete: true,
        lanes: [{ market: 'KR_STOCK', status: 'ready' }, { market: 'US_STOCK', status: 'ready' }],
      },
      ledger: { present: true, cycleCount: 8, positionCount: 0, settlementCount: 0 },
    },
    shadow: {
      groups: [
        { name: 'crypto-futures-15m', total: 244, settled: 240, pending: 4, collapsed: null, macroF1: null, balancedAccuracy: null },
        { name: 'crypto-futures-1h', total: 244, settled: 220, pending: 24, collapsed: null, macroF1: null, balancedAccuracy: null },
      ],
      records: { present: true, totalRecords: 488, settledRecords: 460, pendingRecords: 28 },
    },
    profitability: {
      proven: false,
      status: 'collecting',
      note: 'Paper 정산과 미래 표본이 충분히 쌓이기 전에는 수익성을 증명된 것으로 표시하지 않습니다.',
    },
    strategyHealth: {
      status: 'MISSING_EVIDENCE',
      evaluator: 'strategy-health-observatory.service/evaluateStrategyHealth',
      canonicalCoreStatus: null,
      inputs: {
        backtest: { status: 'HEALTHY', reason: 'CANONICAL_BACKTEST_PRESENT', source: 'research.cycles', observedCount: 1 },
        settlement: { status: 'MISSING_EVIDENCE', reason: 'NATURAL_SETTLEMENT_MISSING', source: 'paper.ledger', observedCount: 0 },
        profitability: { status: 'MISSING_EVIDENCE', reason: 'PROFITABILITY_NOT_PROVEN', source: 'profitability', observedCount: null },
        champion: { status: 'MISSING_EVIDENCE', reason: 'CURRENT_VALIDATED_CHAMPION_NONE', source: 'champion', observedCount: null },
      },
      reasons: ['settlement:NATURAL_SETTLEMENT_MISSING', 'profitability:PROFITABILITY_NOT_PROVEN'],
      executionAuthority: 'NONE',
    },
    ...(aiDebate ? { aiDebate } : {}),
  };
}

function promotions() {
  return {
    ok: true,
    generatedAt: NOW,
    sourceSha: RESEARCH_SHA,
    policyVersion: 'e2e-readonly',
    items: Array.from({ length: 24 }, (_, index) => ({
      identity: { strategyId: `strategy-${index}` },
      drift: { status: 'INSUFFICIENT_SAMPLE', classification: null, reason: '표본 수집 중', observedSampleSize: null },
      promotionEligible: false,
    })),
    counts: {},
    evidenceSources: [],
    promotionCandidates: 0,
    executionAuthority: 'NONE',
    liveTradingAuthority: false,
    privateTradingApiCount: 0,
  };
}

async function installAdmin(page: Page, researchOverview: unknown) {
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
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });

  const diagnostics = { consoleErrors: [] as string[], pageErrors: [] as string[], mutations: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => diagnostics.pageErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') diagnostics.mutations.push(`${request.method()} ${url.pathname}`);
  });

  await page.route('**/__e2e-supabase/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/rest/v1/profiles')) {
      return fulfill(route, {
        id: USER_ID,
        login_name: 'research-admin',
        display_name: '연구 관리자',
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
        id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'research-admin@accounts.invalid',
        app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { display_name: '연구 관리자' }, identities: [], created_at: NOW,
      });
    }
    return fulfill(route, { ok: true });
  });

  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/research/overview') return fulfill(route, researchOverview);
    if (path === '/api/strategy-promotion') return fulfill(route, promotions());
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });

  return {
    assertClean() {
      expect(diagnostics.consoleErrors, diagnostics.consoleErrors.join('\n')).toEqual([]);
      expect(diagnostics.pageErrors, diagnostics.pageErrors.join('\n')).toEqual([]);
      expect(diagnostics.mutations, diagnostics.mutations.join('\n')).toEqual([]);
    },
  };
}

test('mobile Research Center starts with plain Korean summary and keeps raw evidence behind detail tab', async ({ page }) => {
  const { assertClean } = await installAdmin(page, overview());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/research-center');

  await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
  await expect(page.getByTestId('research-summary-tab')).toBeVisible();
  await expect(page.getByTestId('research-current-conclusion')).toContainText('수익성 판단 보류');
  await expect(page.getByText('8회 확인 · 정산 0건', { exact: true })).toBeVisible();
  await expect(page.getByText('488건 중 460건 검증완료', { exact: true })).toBeVisible();
  await expect(page.getByText('MISSING_EVIDENCE', { exact: true })).toBeVisible();
  await expect(page.getByText(/settlement:NATURAL_SETTLEMENT_MISSING/)).toBeVisible();
  await expect(page.getByText('아직 대기', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(RESEARCH_SHA);

  await page.getByRole('tab', { name: 'AI 토론' }).click();
  const debate = page.getByTestId('research-ai-debate-tab');
  await expect(debate).toBeVisible();
  await expect(debate).toContainText('실제 AI 토론 결과 미수집');
  await expect(debate).toContainText('AI 의견이 아닙니다.');
  await expect(debate).toContainText('자동 모의매매 정산이 0건');
  await expect(debate).not.toContainText('Gemini는 찬성');
  await expect(debate).not.toContainText('Groq는 반대');

  await page.getByRole('tab', { name: '상세 증거' }).click();
  const details = page.getByTestId('research-details-tab');
  await expect(details).toBeVisible();
  await expect(details).toContainText('검증 코드 버전');
  await expect(details).toContainText(RESEARCH_SHA);
  await expect(details.getByTestId('research-cycle-count-mismatch')).toContainText('작업별 성공은 3건인데 상위 집계는 0/3');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
  assertClean();
});

test('actual canonical AI debate evidence is rendered without granting AI trading authority', async ({ page }) => {
  const aiDebate = {
    dualAiReviewStatus: 'CONFLICT',
    ai1Review: {
      conclusion: 'SUPPORTS_FURTHER_RESEARCH',
      providerId: 'google-gemini',
      modelId: 'gemini-3.1-flash-lite',
      findings: [{ statement: 'Forward와 빠른 과거검증은 추가 연구를 계속할 근거가 됩니다.' }],
    },
    ai2Review: {
      conclusion: 'OPPOSES_FURTHER_RESEARCH',
      providerId: 'groq',
      modelId: 'openai/gpt-oss-20b',
      findings: [{ statement: 'Paper 정산 0건과 Long History 미수집 때문에 승격 판단은 이릅니다.' }],
    },
    reviewConflictReason: '미래 관찰은 정상이나 실제 모의정산 증거가 없습니다.',
  };
  const { assertClean } = await installAdmin(page, overview(aiDebate));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/research-center');
  await page.getByRole('tab', { name: 'AI 토론' }).click();

  const debate = page.getByTestId('research-ai-debate-tab');
  await expect(debate).toContainText('AI 의견이 충돌했습니다. 추가 검증이 필요합니다.');
  await expect(debate).toContainText('추가 연구 찬성');
  await expect(debate).toContainText('추가 연구 반대');
  await expect(debate).toContainText('google-gemini');
  await expect(debate).toContainText('groq');
  await expect(debate).toContainText('미래 관찰은 정상이나 실제 모의정산 증거가 없습니다.');
  await expect(debate).toContainText('AI는 PF·EV·MDD·승률을 만들어내거나 Champion·자동매매를 승인할 수 없습니다.');

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2)).toBe(true);
  assertClean();
});
