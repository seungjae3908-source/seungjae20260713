import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-13T00:00:00.000Z';
const SHA = '3333333333333333333333333333333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AUTH_STORAGE_KEY = 'sb-127-auth-token';
const STAGES = ['RESEARCH_DESIGN', 'HISTORICAL_BACKTEST', 'OUT_OF_SAMPLE', 'PURGED_WALK_FORWARD', 'COST_STRESS', 'REGIME', 'FINAL_HOLDOUT', 'PAPER', 'SHADOW', 'RECOMMENDATION_OUTCOMES'];

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function strategy(market: string, direction: string, id: string) {
  return {
    identity: {
      strategyFamily: 'CANONICAL_SCANNER_PROFILE', strategyId: id, strategyVersion: 'signal-profile-v1', version: 'signal-profile-v1', parameterHash: 'a'.repeat(64),
      market, assetClass: market.includes('CRYPTO') ? market : 'STOCK', symbol: null, universe: `${market}_CANONICAL_UNIVERSE`,
      timeframe: '5m', strategyHorizon: 'SCALP', horizon: 'SCALP', direction, researchCodeSha: SHA,
      costPolicyVersion: 'BACKTEST_FEES_SLIPPAGE_FUNDING_V1', riskPolicyVersion: 'CANONICAL_RISK_ENGINE_V1',
    },
    promotionState: 'RESEARCH',
    stages: STAGES.map((stage, index) => ({
      stage, status: index === 0 ? 'PASS' : 'NOT_STARTED', startedAt: index === 0 ? NOW : null, completedAt: index === 0 ? NOW : null, observedAt: NOW,
      source: index === 0 ? 'scanner-strategy-profile.service.ts' : 'UNLINKED', provider: index === 0 ? 'INTERNAL_CANONICAL_REGISTRY' : null, sourceSha: index === 0 ? SHA : null,
      sampleSize: null, sampleCount: null, tradeCount: null, metrics: index === 0 ? { executionAuthority: 'NONE' } : null,
      gate: `${stage}_EVIDENCE_REQUIRED`, gateResult: index === 0 ? 'PASS' : 'EVIDENCE_REQUIRED', failureReason: null, failureReasons: [], provenance: index === 0 ? ['canonical scanner strategy profile registry'] : [],
      costAssumptions: stage === 'COST_STRESS' ? { requiredMultipliers: '1,1.25,1.5,2' } : null, costPolicy: null, dataQuality: index === 0 ? 'VERIFIED' : 'UNLINKED',
      fetchedAt: null, validatedAt: index === 0 ? NOW : null, corporateActionAdjusted: null, survivorshipSafe: null, pointInTimeSafe: null, requiredEvidence: [],
    })),
    drift: { classification: null, status: 'INSUFFICIENT_SAMPLE', reason: 'LINKED_BASELINE_AND_AT_LEAST_30_OBSERVED_OUTCOMES_REQUIRED', observedSampleSize: null },
    killState: 'NONE', blockers: STAGES.slice(1).map((stage) => `${stage}_NOT_STARTED`), promotionEligible: false,
    executionAuthority: 'NONE', liveTradingAuthority: false, privateTradingApiCount: 0,
  };
}

const promotionResponse = {
  ok: true, generatedAt: NOW, sourceSha: SHA, policyVersion: 'STRATEGY_PROMOTION_POLICY_V1',
  items: [
    strategy('KR_STOCK', 'BUY', 'KR_STOCK_SCALP_V1_BUY'),
    strategy('US_STOCK', 'SELL', 'US_STOCK_SCALP_V1_SELL'),
    strategy('CRYPTO_SPOT', 'BUY', 'CRYPTO_SPOT_SCALP_V1_BUY'),
    strategy('CRYPTO_FUTURES', 'LONG', 'CRYPTO_FUTURES_SCALP_V1_LONG'),
  ],
  counts: { RESEARCH: 4, BLOCKED_DATA: 0, RESEARCH_HOLD: 0, PAPER_CANDIDATE: 0, PAPER_VALIDATED: 0, SHADOW_CANDIDATE: 0, SHADOW_VALIDATED: 0, PROMOTION_CANDIDATE: 0, SUSPENDED: 0, KILLED: 0 },
  evidenceSources: [
    { id: 'CANONICAL_SCANNER_PROFILE', owner: 'scanner-strategy-profile.service.ts', status: 'AVAILABLE', use: 'immutable strategy identity', executionAuthority: 'NONE' },
    { id: 'PREDICTION_LAB', owner: 'market-prediction-lab', status: 'UNLINKED', use: 'purged walk-forward and holdout evidence', executionAuthority: 'NONE' },
  ],
  promotionCandidates: 0, executionAuthority: 'NONE', liveTradingAuthority: false, privateTradingApiCount: 0,
};

async function installApprovedRuntime(page: Page, response: typeof promotionResponse = promotionResponse, delayMs = 0) {
  await page.addInitScript(({ storageKey, userId, now }) => {
    const encode = (value: Record<string, unknown>) => window.btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const expiresAt = 4_102_444_800;
    const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: userId, role: 'authenticated', exp: expiresAt })}.e2e`;
    window.localStorage.setItem(storageKey, JSON.stringify({ access_token: accessToken, refresh_token: 'promotion-e2e', expires_in: 3600, expires_at: expiresAt, token_type: 'bearer', user: { id: userId, aud: 'authenticated', role: 'authenticated', email: 'promotion@example.invalid', app_metadata: {}, user_metadata: {}, identities: [], created_at: now } }));
  }, { storageKey: AUTH_STORAGE_KEY, userId: USER_ID, now: NOW });
  await page.route('**/__e2e-supabase/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rest/v1/profiles')) return fulfill(route, { id: USER_ID, login_name: 'promotion-e2e', display_name: 'Promotion QA', role: 'admin', status: 'approved', membership_level: 'admin', is_active: true, permissions_updated_at: NOW, updated_at: NOW });
    if (path.endsWith('/auth/v1/user')) return fulfill(route, { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'promotion@example.invalid', app_metadata: {}, user_metadata: {}, identities: [], created_at: NOW });
    return fulfill(route, { ok: true });
  });
  await page.route('**/api/**', async (route) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new URL(route.request().url()).pathname === '/api/strategy-promotion'
      ? fulfill(route, response)
      : fulfill(route, { ok: true, items: [] });
  });
}

test('promotion center exposes loading and empty states without inventing evidence', async ({ page }) => {
  const emptyResponse = { ...promotionResponse, items: [], counts: { ...promotionResponse.counts, RESEARCH: 0 } };
  await installApprovedRuntime(page, emptyResponse, 350);
  await page.goto('/strategy-promotion');
  await expect(page.getByText('Loading linked evidence…')).toBeVisible();
  await expect(page.getByTestId('strategy-promotion-empty')).toBeVisible();
  await expect(page.getByTestId('promotion-candidate-count')).toHaveText('0');
});

test('failed evidence is explicit and the timeline is keyboard accessible', async ({ page }) => {
  const failed = strategy('KR_STOCK', 'BUY', 'KR_STOCK_SCALP_V1_BUY');
  failed.promotionState = 'RESEARCH_HOLD';
  failed.stages[1] = { ...failed.stages[1], status: 'FAIL', gateResult: 'FAIL', failureReason: 'OOS_NET_EXPECTANCY_NOT_POSITIVE', failureReasons: ['OOS_NET_EXPECTANCY_NOT_POSITIVE'] };
  const response = { ...promotionResponse, items: [failed], counts: { ...promotionResponse.counts, RESEARCH: 0, RESEARCH_HOLD: 1 } };
  await installApprovedRuntime(page, response);
  await page.goto('/strategy-promotion');
  const disclosure = page.getByRole('button', { name: 'Evidence and timeline' });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('OOS_NET_EXPECTANCY_NOT_POSITIVE')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Promotion evidence timeline' })).toBeVisible();
});

for (const width of [320, 360, 390, 412, 430, 1440]) {
  test(`promotion center is fail-closed and overflow-free at ${width}px`, async ({ page }) => {
    await installApprovedRuntime(page);
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.goto('/strategy-promotion');
    await expect(page.getByRole('heading', { name: 'Strategy Promotion Center' })).toBeVisible();
    await expect(page.getByTestId('promotion-candidate-count')).toHaveText('0');
    await expect(page.getByText('Live authority').locator('..')).toContainText('NONE');
    await expect(page.getByText('Private API').locator('..')).toContainText('0');
    await expect(page.getByTestId('strategy-promotion-card')).toHaveCount(4);
    await page.getByRole('button', { name: 'Evidence and timeline' }).first().click();
    await expect(page.getByRole('list', { name: 'Promotion evidence timeline' })).toBeVisible();
    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    expect(dimensions.html).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.body).toBeLessThanOrEqual(dimensions.width);
  });
}
