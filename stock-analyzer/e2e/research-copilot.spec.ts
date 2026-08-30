import { expect, test, type Page, type Route } from '@playwright/test';
import { buildCopilotSnapshot, COPILOT_AUTHORITY, validateCopilotDsl } from '../../api-server/src/services/research-copilot.service';

const NOW = Date.parse('2026-08-30T09:00:00Z');
const USER = '77777777-7777-4777-8777-777777777777';
const fixture = {
  schemaVersion: 'research-dashboard-overview-v1', generatedAt: NOW, state: { present: true, latestCycleAt: NOW },
  safety: { readOnlyDashboard: true, liveTrading: false, privateApi: false, orderAuthority: false, authorityEvidenceComplete: true, forbiddenAuthorityObserved: false },
  research: { status: 'collecting', failedTasks: 0, blockedDataTasks: 0, cycles: [] },
  paper: { runtime: { present: false, status: 'not_started', safetyEvidenceComplete: false, lanes: [], privateRequestCount: null, financialMutationCount: null, orderCount: null, liveTrading: null, orderAuthority: null }, ledger: { present: false, cycleCount: null, positionCount: null, settlementCount: null } },
  shadow: { groups: [], records: { present: false, totalRecords: null, settledRecords: null, pendingRecords: null } },
  profitability: { proven: false, status: 'NOT_PROVEN', note: '필수 정산 증거 부족' },
};
function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}
async function setup(page: Page, options: { available?: boolean; regular?: boolean; failure?: boolean; malformed?: boolean; changedAfterReview?: boolean; numericReview?: boolean } = {}) {
  const snapshot = buildCopilotSnapshot(fixture, NOW);
  snapshot.ai.available = options.available === true;
  snapshot.ai.reason = options.available ? 'TEST_ONLY' : 'FREE_TIER_NOT_CONFIRMED';
  snapshot.ai.provider = options.available ? 'groq' : null;
  const calls: string[] = [];
  const errors: string[] = [];
  const pageErrors: string[] = [];
  const unexpectedHttp: string[] = [];
  let reviewRequests = 0;
  await page.addInitScript(({ user }) => {
    const encode = (value: Record<string, unknown>) => btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: user, role: 'authenticated', exp: 4102444800 })}.e2e`,
      refresh_token: 'fixture-only', expires_at: 4102444800, expires_in: 3600, token_type: 'bearer',
      user: { id: user, aud: 'authenticated', role: 'authenticated', email: 'fixture@accounts.invalid', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-08-30T09:00:00Z' },
    }));
    window.addEventListener('unhandledrejection', event => { console.error('UNHANDLED_REJECTION', String(event.reason)); });
  }, { user: USER });
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && !(options.failure && response.url().endsWith('/copilot'))) unexpectedHttp.push(`${response.status()} ${response.url()}`); });
  await page.route('**/__e2e-supabase/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/profiles')) return fulfill(route, { id: USER, login_name: 'fixture', display_name: '테스트 관리자', role: options.regular ? 'user' : 'admin', membership_level: options.regular ? 'regular' : 'admin', status: 'approved', is_active: true });
    if (path.endsWith('/user')) return fulfill(route, { id: USER, aud: 'authenticated', role: 'authenticated', email: 'fixture@accounts.invalid', app_metadata: {}, user_metadata: {} });
    return fulfill(route, { ok: true });
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${path}`);
    if (path === '/api/admin/research/overview') return fulfill(route, fixture);
    if (path === '/api/strategy-promotion') return fulfill(route, { items: [], counts: {}, evidenceSources: [], promotionCandidates: 0, executionAuthority: 'NONE' });
    if (path === '/api/admin/research/copilot') {
      const current = options.changedAfterReview && reviewRequests > 0
        ? buildCopilotSnapshot({ ...fixture, state: { present: true, latestCycleAt: NOW - 1_000 } }, NOW)
        : snapshot;
      return fulfill(route, options.failure ? { error: 'RESEARCH_SOURCE_UNAVAILABLE' } : options.malformed ? { ...current, stages: [null] } : current, options.failure ? 503 : 200);
    }
    if (path.endsWith('/copilot/validate-dsl')) return fulfill(route, validateCopilotDsl(request.postDataJSON()));
    if (path.endsWith('/copilot/review')) {
      reviewRequests += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      return fulfill(route, {
        status: 'needs_context', task: request.postDataJSON().task, market: null, symbol: null, timestamp: NOW,
        data_sources: snapshot.data_sources, freshness: 'FRESH', evidenceDigest: snapshot.evidenceDigest,
        signal: null, confidence: options.numericReview ? 0.9 : null, evidence: [], risks: [], entry_zone: null, invalidation: null, stop_loss: null, targets: [], risk_reward: null,
        missing_data: snapshot.missing_data, next_action: snapshot.next_action, approval_required: false, cacheHit: false, authority: COPILOT_AUTHORITY,
        review: { provider: 'groq', model: 'openai/gpt-oss-20b', summary: '새로운 미래 증거에서 구조적 가설을 검토하세요.', findings: ['학습과 검증 구간 분리를 확인하세요.'], hypotheses: [], risks: [] },
      });
    }
    if (path === '/api/user-integrations') return fulfill(route, { brokerConnections: [], telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null }, preferences: {} });
    return fulfill(route, { ok: true, items: [], rows: [], results: [] });
  });
  return {
    calls, reviewRequests: () => reviewRequests,
    clean() { expect(pageErrors).toEqual([]); expect(unexpectedHttp).toEqual([]); expect(errors.filter(error => !(options.failure && error.includes('503')))).toEqual([]); },
  };
}
for (const width of [390, 1440]) {
  test(`copilot ${width}px preserves missing evidence, no automatic AI, safe DSL and handoff links`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const diagnostics = await setup(page);
    await page.goto('/research-center');
    await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'AI Research Copilot', exact: true }).click();
    await expect(page.getByTestId('research-copilot')).toBeVisible();
    await expect(page.getByText('AI는 가설과 연구 절차를 설명합니다.', { exact: false })).toBeVisible();
    await expect(page.getByText('AI 사용 불가: FREE_TIER_NOT_CONFIRMED')).toBeVisible();
    await expect(page.getByRole('button', { name: '후보 가설 제안' })).toBeDisabled();
    expect(diagnostics.calls.filter(call => call.startsWith('POST'))).toEqual([]);
    await expect(page.getByRole('region', { name: '연구 단계' }).getByRole('article')).toHaveCount(10);
    await page.screenshot({ path: testInfo.outputPath(`research-copilot-${width}.png`) });
    await page.getByLabel('연구 DSL JSON').fill('{"code":"process.exit()"}');
    await page.getByRole('button', { name: 'DSL 검증', exact: true }).click();
    await expect(page.getByText('DSL 차단:', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: '기존 백테스터 열기 (조건을 별도로 입력)' })).toHaveAttribute('href', '/backtests');
    await expect(page.getByRole('link', { name: 'canonical 승격 증거 조회' })).toHaveAttribute('href', '/strategy-promotion');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    diagnostics.clean();
  });
}
test('manual AI review disables duplicate submission and remains advisory', async ({ page }) => {
  const diagnostics = await setup(page, { available: true });
  await page.goto('/research-center');
  await page.getByRole('button', { name: 'AI Research Copilot', exact: true }).click();
  const action = page.getByRole('button', { name: '후보 가설 제안' });
  await action.click();
  await expect(action).toBeDisabled();
  await expect(page.getByRole('region', { name: 'AI 연구 제안' })).toContainText('검증 전 연구 제안');
  expect(diagnostics.reviewRequests()).toBe(1);
  await expect(page.getByText('신뢰 확률·성과 수치: 미생성.', { exact: false })).toBeVisible();
  diagnostics.clean();
});
test('changed source after AI completion cannot display the previous explanation', async ({ page }) => {
  const diagnostics = await setup(page, { available: true, changedAfterReview: true });
  await page.goto('/research-center');
  await page.getByRole('button', { name: 'AI Research Copilot', exact: true }).click();
  await page.getByRole('button', { name: '후보 가설 제안' }).click();
  await expect(page.getByText('원본 기준 시각:', { exact: false })).toContainText(new Date(NOW - 1_000).toISOString());
  await expect(page.getByRole('region', { name: 'AI 연구 제안' })).toHaveCount(0);
  expect(diagnostics.reviewRequests()).toBe(1);
  diagnostics.clean();
});
test('numeric AI authority in a nominally successful response is blocked by the UI contract', async ({ page }) => {
  const diagnostics = await setup(page, { available: true, numericReview: true });
  await page.goto('/research-center');
  await page.getByRole('button', { name: 'AI Research Copilot', exact: true }).click();
  await page.getByRole('button', { name: '후보 가설 제안' }).click();
  await expect(page.getByRole('alert')).toContainText('연구 응답 계약을 확인할 수 없습니다.');
  await expect(page.getByRole('region', { name: 'AI 연구 제안' })).toHaveCount(0);
  diagnostics.clean();
});
for (const state of ['failure', 'malformed'] as const) {
  test(`copilot ${state} response shows recoverable error instead of empty success`, async ({ page }) => {
    const diagnostics = await setup(page, { [state]: true });
    await page.goto('/research-center');
    await page.getByRole('button', { name: 'AI Research Copilot', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: '다시 조회' })).toBeVisible();
    expect(diagnostics.reviewRequests()).toBe(0);
    diagnostics.clean();
  });
}
test('regular member cannot reach the research workspace', async ({ page }) => {
  const diagnostics = await setup(page, { regular: true });
  await page.goto('/research-center');
  await expect(page.getByRole('button', { name: 'AI Research Copilot', exact: true })).toHaveCount(0);
  expect(diagnostics.calls.filter(call => call.includes('/research/copilot'))).toEqual([]);
  diagnostics.clean();
});
