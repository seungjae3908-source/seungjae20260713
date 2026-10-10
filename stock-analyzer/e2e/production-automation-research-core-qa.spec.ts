import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const enabled = process.env.PRODUCTION_AUTOMATION_RESEARCH_QA === 'true';
const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const targetSha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const deployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_AUTOMATION_RESEARCH_ARTIFACT_DIR
    ?? 'production-automation-research-artifacts',
);

test.skip(!enabled, 'Runs only in the dedicated protected Automation/Research/Telegram pre-activation QA lane.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') {
    throw new Error('PRODUCTION_AUTOMATION_RESEARCH_OFFICIAL_ORIGIN_REQUIRED');
  }
  if (!qaLogin || !qaPassword) throw new Error('PRODUCTION_AUTOMATION_RESEARCH_LOGIN_REQUIRED');
  if (!/^[0-9a-f]{40}$/.test(targetSha)) throw new Error('PRODUCTION_AUTOMATION_RESEARCH_SHA_REQUIRED');
  if (!Number.isSafeInteger(deployRunId) || deployRunId <= 0) {
    throw new Error('PRODUCTION_AUTOMATION_RESEARCH_DEPLOY_RUN_REQUIRED');
  }
}

type ApiResult<T> = { ok: boolean; status: number; body: T };

async function api<T>(page: Page, pathname: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('PRODUCTION_AUTOMATION_RESEARCH_AUTH_TOKEN_MISSING');
  return page.evaluate(async ({ pathname, method, body, token }) => {
    const response = await fetch(pathname, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined
        ? { Accept: 'application/json', Authorization: `Bearer ${token}` }
        : { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    return { ok: response.ok, status: response.status, body: payload };
  }, { pathname, method, body, token }) as Promise<ApiResult<T>>;
}

function backtestRequest() {
  return {
    market: 'crypto-futures',
    symbol: 'BTCUSDT',
    timeframe: '15m',
    startTime: Date.UTC(2026, 8, 1),
    endTime: Date.UTC(2026, 8, 8),
    initialCapital: 1_000_000,
    strategy: 'breakout',
    side: 'both',
    parameters: { lookback: 20, volumePeriod: 20, volumeMultiplier: 1.2 },
    riskPercent: 0.5,
    leverage: 2,
    entryFeeRate: 0.0006,
    exitFeeRate: 0.0006,
    slippageRate: 0.0005,
    fundingRatePerInterval: 0,
    fundingIntervalHours: 8,
    stopLossMode: 'percent',
    stopLossValue: 1,
    takeProfitMode: 'risk_multiple',
    takeProfitValue: 2,
    trailingStop: { enabled: false },
    maximumConcurrentPositions: 1,
    maximumTradesPerDay: 10,
    intrabarPriority: 'stop_first',
    validationSplit: { trainingPercent: 60, validationPercent: 20, testPercent: 20 },
  };
}

test('Production Auto, Paper, Research Center, Backtester and Telegram Journal close independently with zero financial authority', async ({ page }) => {
  test.setTimeout(150_000);
  let forbiddenBrowserMutation = 0;
  let backtestComputationRequests = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(baseUrl).origin
      && request.method() === 'POST'
      && url.pathname === '/api/backtests/run') {
      backtestComputationRequests += 1;
      return route.continue();
    }
    if (url.origin === new URL(baseUrl).origin
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      forbiddenBrowserMutation += 1;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
  const health = await api<any>(page, '/api/health');
  expect(health.ok).toBe(true);
  expect(String(health.body?.deploySha ?? '').toLowerCase()).toBe(targetSha);
  expect(String(health.body?.deployMarkerSha ?? '').toLowerCase()).toBe(targetSha);
  expect(health.body?.identityMatch).toBe(true);

  await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/자동매매|모의매매|자동 거래/i).first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('trading-mode-paper').click();
  await expect(page.getByTestId('paper-trading-dashboard')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('trading-mode-auto').click();
  await page.getByTestId('trading-section-settings').click();
  const telegramPanel = page.getByTestId('user-broker-telegram-panel');
  await expect(telegramPanel).toBeVisible({ timeout: 30_000 });
  await expect(telegramPanel).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
  await page.getByTestId('trading-section-journal').click();
  await expect(page.getByTestId('trading-workspace-journal')).toBeVisible({ timeout: 30_000 });
  const automation = await api<any>(page, '/api/trade-automation/status');
  expect(automation.ok).toBe(true);
  expect(automation.body?.ok).toBe(true);
  for (const market of ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures']) {
    expect(typeof automation.body?.policy?.marketEnabled?.[market]).toBe('boolean');
    expect(automation.body?.liveAutomaticReadinessByMarket?.[market]?.orderSubmissionPerformedByStatusRequest)
      .toBe(false);
  }
  for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
    expect(automation.body?.liveExecutionServerEnabled?.[provider]).toBe(false);
  }

  const paper = await api<any>(page, '/api/trade-automation/paper-runtime-readiness');
  expect(paper.ok).toBe(true);
  expect(paper.body?.readOnlyProbe).toBe(true);
  expect(typeof paper.body?.readyForPaperEvaluation).toBe('boolean');
  expect(typeof paper.body?.paperWalletReady).toBe('boolean');
  expect(Array.isArray(paper.body?.blockers)).toBe(true);
  expect(paper.body.blockers.every((value: unknown) => typeof value === 'string'
    && /^[A-Z][A-Z0-9_]{1,90}$/.test(value))).toBe(true);
  expect(paper.body?.financialMutationCount).toBe(0);
  expect(paper.body?.privateProviderRequests).toBe(0);
  expect(paper.body?.orderSubmitted).toBe(false);
  expect(paper.body?.exchangeRequestSent).toBe(false);
  expect(paper.body?.realOrderAuthorityGranted).toBe(false);

  const journal = await api<any>(page, '/api/paper-journal/snapshot');
  expect(journal.ok, JSON.stringify(journal.body)).toBe(true);
  expect(journal.body?.ok).toBe(true);
  expect(Array.isArray(journal.body?.records)).toBe(true);
  expect(journal.body?.orderSubmitted).toBe(false);
  expect(journal.body?.exchangeRequestSent).toBe(false);

  const integrations = await api<any>(page, '/api/user-integrations');
  expect(integrations.ok, JSON.stringify(integrations.body)).toBe(true);
  expect(integrations.body?.telegramStorageAvailable).toBe(true);
  expect(integrations.body?.alertPolicyStorageAvailable).toBe(true);
  expect(typeof integrations.body?.telegram?.connected).toBe('boolean');
  expect(typeof integrations.body?.preferences?.ORDER_FILLED).toBe('boolean');
  expect(typeof integrations.body?.telegramRuntime?.deliveryReady).toBe('boolean');
  expect(typeof integrations.body?.telegramRuntime?.backgroundWorkersEnabled).toBe('boolean');
  expect(typeof integrations.body?.telegramRuntime?.personalWorkerEnabled).toBe('boolean');
  expect(typeof integrations.body?.telegramRuntime?.personalWorkerStarted).toBe('boolean');
  expect(typeof integrations.body?.telegramRuntime?.workerActivationApproved).toBe('boolean');
  expect(integrations.body?.telegramRuntime?.orderAuthority).toBe('NONE');
  expect(integrations.body?.telegramRuntime?.privateTradingApiAllowed).toBe(false);
  expect(integrations.body?.telegramRuntime?.realOrderAllowed).toBe(false);
  expect(integrations.body?.privateApiRequests).toBe(0);
  expect(integrations.body?.ordersSubmitted).toBe(0);
  expect(integrations.body?.ordersCancelled).toBe(0);

  await page.goto('/research-center', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('research-center-workspace')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('research-general-view')).toBeVisible({ timeout: 30_000 });
  const research = await api<any>(page, '/api/admin/research/overview');
  expect(research.ok, JSON.stringify(research.body)).toBe(true);
  expect(research.body?.schemaVersion).toBe('research-dashboard-overview-v1');

  await page.goto('/backtests', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: '백테스트', exact: true })).toBeVisible({ timeout: 30_000 });
  const backtest = await api<any>(page, '/api/backtests/run', 'POST', backtestRequest());
  expect(backtest.ok, JSON.stringify(backtest.body)).toBe(true);
  expect(backtest.body?.ok).toBe(true);
  expect(backtest.body?.mode).toBe('backtest-only');
  expect(backtest.body?.orderSubmitted).toBe(false);
  expect(backtest.body?.result?.mode).toBe('backtest-only');
  expect(backtest.body?.result?.orderSubmitted).toBe(false);
  expect(backtestComputationRequests).toBe(1);
  expect(forbiddenBrowserMutation).toBe(0);

  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-automation-research-core-qa.json'),
    `${JSON.stringify({
      schemaVersion: 'production-automation-research-core-qa-v1',
      targetSha,
      productionDeployRunId: deployRunId,
      generatedAt: new Date().toISOString(),
      officialProductionOrigin: true,
      authenticatedProductionSession: true,
      phase: 'PREACTIVATION',
      features: {
        automaticTrading: 'PASS',
        automaticPaperTrading: 'PASS',
        researchCenter: 'PASS',
        backtester: 'PASS',
        telegramTradeJournal: 'PASS',
      },
      backtestMode: 'backtest-only',
      paperRuntimeContractVerified: true,
      paperRuntimeReadyAtDeploy: paper.body.readyForPaperEvaluation === true,
      paperRuntimeBlockers: paper.body.blockers,
      telegramTradeJournalReady: true,
      journalReadbackReady: true,
      telegramJournalPreferenceConfigured: typeof integrations.body.preferences.ORDER_FILLED === 'boolean',
      telegramRuntimeContractVerified: true,
      telegramConnectedAtDeploy: integrations.body.telegram.connected === true,
      telegramWorkerReadyAtDeploy: integrations.body.telegramRuntime.personalWorkerStarted === true,
      telegramTestDelivered: false,
      telegramTestMessages: 0,
      telegramTestDeferredToProtectedActivation: true,
      policyMutationPerformed: false,
      liveTradingAuthorityGranted: false,
      autoTradingAuthorityGranted: false,
      orders: 0,
      cancels: 0,
      amends: 0,
      transfers: 0,
      withdrawals: 0,
      providerPrivateRequests: 0,
      secretsRecorded: false,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
});
