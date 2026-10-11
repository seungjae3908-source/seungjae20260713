import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginProductionReadOnly, productionReadOnlyAccessToken } from './support/production-readonly-login';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/u, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const targetSha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const outputDir = path.resolve(process.env.PRODUCTION_AUTO_LIVE_ARTIFACT_DIR ?? 'production-auto-live-artifacts');
const enabled = process.env.PRODUCTION_AUTO_LIVE_ONLY_QA === 'true';
const MARKETS = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
const PROVIDERS = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
const EXPECTED_PREACTIVATION_BLOCKERS = new Set([
  'MANUAL_LIVE_SERVER_GATE_OFF',
  'AUTOMATIC_LIVE_SERVER_GATE_OFF',
]);

test.skip(!enabled, 'Runs only in the protected Production Automatic LIVE-only QA lane.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA credential is required');
  if (!/^[0-9a-f]{40}$/u.test(targetSha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  }
}

async function appGet(page: Page, pathname: string) {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('PRODUCTION_AUTO_LIVE_AUTH_TOKEN_MISSING');
  return page.evaluate(async ({ pathname, token }) => {
    const response = await fetch(pathname, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, body };
  }, { pathname, token });
}

function memberPolicyBlockers(policy: any) {
  const blockers: string[] = [];
  if (policy?.mode !== 'automatic') blockers.push('MODE_NOT_AUTOMATIC');
  if (policy?.automaticEnabled !== true) blockers.push('MEMBER_AUTOMATIC_DISABLED');
  if (policy?.emergencyStopped !== false) blockers.push('EMERGENCY_STOPPED');
  if (policy?.newEntriesStopped !== false) blockers.push('NEW_ENTRIES_STOPPED');
  for (const market of MARKETS) {
    if (policy?.marketEnabled?.[market] !== true) blockers.push(`MARKET_DISABLED_${market.toUpperCase()}`);
  }
  const domesticBroker = policy?.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom';
  for (const provider of ['kiwoom', 'upbit', 'bitget', domesticBroker]) {
    if (policy?.exchangeEnabled?.[provider] !== true) blockers.push(`PROVIDER_DISABLED_${provider.toUpperCase()}`);
  }
  if (policy?.stockBrokerByMarket?.us_stock !== 'kiwoom') blockers.push('US_STOCK_BROKER_NOT_KIWOOM');
  const leverage = Number(policy?.bitgetLeverage);
  if (!Number.isInteger(leverage) || leverage < 2 || leverage > 7) blockers.push('BITGET_LEVERAGE_OUT_OF_POLICY');
  if (policy?.riskOptimizationEnabled !== true) blockers.push('RISK_OPTIMIZATION_DISABLED');
  if (!Array.isArray(policy?.enabledStrategies) || policy.enabledStrategies.length === 0) {
    blockers.push('STRATEGY_ALLOWLIST_EMPTY');
  }
  if (!['limited-50', 'validated', 'formula-ai-exception'].includes(String(policy?.pilotStage ?? ''))) {
    blockers.push('LIVE_PILOT_STAGE_NOT_READY');
  }
  return { blockers, domesticBroker, leverage };
}

test('Production Automatic LIVE-only preactivation is responsive, exact-SHA and zero-mutation', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });

  let mutationRequests = 0;
  let paperRequests = 0;
  let telegramRequests = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (/paper-journal|paper-runtime|paper-trading/iu.test(pathname)) paperRequests += 1;
    if (/telegram/iu.test(pathname)) telegramRequests += 1;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      mutationRequests += 1;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const healthResponse = await page.request.get('/api/health');
  expect(healthResponse.status()).toBe(200);
  const health: any = await healthResponse.json();
  expect(health?.ok).toBe(true);
  expect(String(health.deploySha ?? '').toLowerCase()).toBe(targetSha);
  expect(String(health.deployMarkerSha ?? '').toLowerCase()).toBe(targetSha);
  expect(health.identityMatch).toBe(true);
  const healthWorker = health?.autoTradingBackground;
  expect(healthWorker?.enabled, 'Automatic worker must be stopped before activation').toBe(false);
  expect(healthWorker?.liveModeRequested, 'LIVE background authority must remain off during QA').toBe(false);
  expect(healthWorker?.liveEntryArmPresent, 'LIVE entry arm must not exist during QA').toBe(false);
  expect(healthWorker?.liveEntriesArmed, 'LIVE entries must remain disarmed during QA').toBe(false);
  expect(healthWorker?.errorCode ?? null, 'Disabled worker must not carry a runtime error').toBeNull();

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('auto-trading-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('auto-trading-responsive-layout')).toBeVisible();
    await expect(page.getByTestId('technical-trading-modes')).toContainText('자동매매');
    await expect(page.getByTestId('trading-paper-modes')).toHaveCount(0);
    await expect(page.getByTestId('auto-trading-runtime-summary')).not.toContainText('확인 중');
    const holdings = page.getByTestId('trading-holdings');
    await expect(holdings).toBeVisible();
    await expect(holdings.getByRole('status')).toHaveCount(0);
    await expect(holdings.getByRole('alert')).toHaveCount(0);
    const holdingButtons = holdings.getByRole('button').filter({ visible: true });
    if (await holdingButtons.count() > 0) {
      await holdingButtons.first().click();
      const detail = page.getByTestId('holding-detail-dialog');
      await expect(detail).toBeVisible();
      await expect(detail.getByRole('button', { name: '종목상세', exact: true })).toBeVisible();
      await expect(detail.getByRole('button', { name: 'AI차트', exact: true })).toBeVisible();
      await expect(detail.getByTestId('holding-entry-evidence')).toBeVisible();
      await expect(detail.getByRole('button', { name: /매도|주문|승인/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(detail).not.toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByTestId('trading-mode-paper')).toHaveCount(0);
    await expect(page.getByTestId('optional-paper-readiness')).toHaveCount(0);
    if (viewport.width < 640) await expect(page.getByTestId('trading-market-select')).toBeVisible();
    else await expect(page.getByTestId('trading-market-tabs')).toBeVisible();
  }

  const status = await appGet(page, '/api/trade-automation/status');
  expect(status.ok, JSON.stringify(status.body)).toBe(true);
  expect(status.body?.ok).toBe(true);
  const policy = status.body?.policy;
  const policyReadiness = memberPolicyBlockers(policy);
  expect(policyReadiness.blockers, `member Automatic LIVE policy blockers: ${policyReadiness.blockers.join(',')}`).toEqual([]);

  let providerVerificationFresh = true;
  for (const provider of PROVIDERS) {
    const connection = (status.body?.connections ?? []).find((row: any) =>
      String(row?.exchange ?? row?.provider ?? '').toLowerCase() === provider);
    expect(connection, `missing provider ${provider}`).toBeTruthy();
    expect(connection?.configured, `${provider} configured`).toBe(true);
    expect(Boolean(connection?.lastVerifiedAt), `${provider} verified`).toBe(true);
    expect(connection?.lastErrorCode ?? null, `${provider} no verification error`).toBeNull();
    const readiness = status.body?.liveExecutionReadiness?.[provider];
    expect(readiness?.connectionConfigured, `${provider} LIVE connection configured`).toBe(true);
    expect(readiness?.providerVerified, `${provider} verification must be fresh`).toBe(true);
    providerVerificationFresh = providerVerificationFresh && readiness?.providerVerified === true;
    expect(readiness?.manualServerGateEnabled, `${provider} manual gate must remain OFF during QA`).toBe(false);
    expect(readiness?.automaticServerGateEnabled, `${provider} automatic gate must remain OFF during QA`).toBe(false);
    expect(status.body?.liveAutomaticExecutionServerEnabled?.[provider], `${provider} must remain OFF during QA`).toBe(false);
  }
  let pendingOrderCount = 0;
  let recoveryRequiredOrderCount = 0;
  let statusRequestOrderSubmissionCount = 0;
  for (const market of MARKETS) {
    const readiness = status.body?.liveAutomaticReadinessByMarket?.[market];
    const blockers = readiness?.blockers ?? [];
    const unexpectedBlockers = blockers.filter(
      (blocker: string) => !EXPECTED_PREACTIVATION_BLOCKERS.has(blocker),
    );
    expect(unexpectedBlockers, `${market} has non-gate readiness blockers`).toEqual([]);
    expect(new Set(blockers), `${market} exact preactivation blockers`).toEqual(EXPECTED_PREACTIVATION_BLOCKERS);
    expect(readiness?.connectionConfigured, `${market} connection configured`).toBe(true);
    expect(readiness?.providerVerified, `${market} provider verification fresh`).toBe(true);
    expect(readiness?.automaticPolicyEnabled, `${market} member automatic policy enabled`).toBe(true);
    expect(readiness?.marketAutomaticEnabled, `${market} market enabled`).toBe(true);
    expect(readiness?.exchangeAutomaticEnabled, `${market} provider enabled`).toBe(true);
    expect(readiness?.memberOrderCapability, `${market} member order capability`).toBe(true);
    expect(readiness?.memberStopped, `${market} member stop inactive`).toBe(false);
    expect(readiness?.globalStopped, `${market} global stop inactive`).toBe(false);
    expect(readiness?.orderSubmissionPerformedByStatusRequest).toBe(false);
    statusRequestOrderSubmissionCount += readiness?.orderSubmissionPerformedByStatusRequest === true ? 1 : 0;
    const activity = status.body?.marketActivityByMarket?.[market];
    expect(activity, `${market} activity summary`).toBeTruthy();
    expect(activity?.pendingOrders, `${market} pending orders`).toBe(0);
    expect(activity?.recoveryRequiredOrders, `${market} recovery-required orders`).toBe(0);
    pendingOrderCount += Number(activity?.pendingOrders ?? -1);
    recoveryRequiredOrderCount += Number(activity?.recoveryRequiredOrders ?? -1);
  }
  const statusWorker = status.body?.autoTradingBackground;
  expect(statusWorker?.enabled).toBe(false);
  expect(statusWorker?.liveModeRequested).toBe(false);
  expect(statusWorker?.liveEntryArmPresent).toBe(false);
  expect(statusWorker?.liveEntriesArmed).toBe(false);
  expect(statusWorker?.globalEmergencyStopActive).toBe(false);
  expect(statusWorker?.errorCode ?? null).toBeNull();
  expect(mutationRequests).toBe(0);
  expect(paperRequests).toBe(0);
  expect(telegramRequests).toBe(0);

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(outputDir, 'production-auto-live-qa.json'), `${JSON.stringify({
    schemaVersion: 'production-auto-live-readonly-qa-v2',
    targetSha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    identityMatch: true,
    viewports: ['desktop-1440', 'tablet-1024', 'mobile-390'],
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, 'PASS'])),
    markets: Object.fromEntries(MARKETS.map((market) => [market, 'PASS'])),
    memberAutoPolicyReady: true,
    memberAutoPolicyBlockers: [],
    memberAutoDomesticBroker: policyReadiness.domesticBroker,
    memberAutoBitgetLeverage: policyReadiness.leverage,
    memberAutoPilotStage: String(policy?.pilotStage ?? ''),
    memberAutoLivePilotReady: true,
    providerVerificationFresh,
    marketReadinessBlockersOnlyExpectedPreactivation: true,
    workerPreactivationSafe: true,
    workerEnabled: statusWorker.enabled,
    liveBackgroundRequested: statusWorker.liveModeRequested,
    liveEntryArmPresent: statusWorker.liveEntryArmPresent,
    liveEntriesArmed: statusWorker.liveEntriesArmed,
    pendingOrderCount,
    recoveryRequiredOrderCount,
    statusRequestOrderSubmissionCount,
    paperTrading: 'OUT_OF_SCOPE',
    telegram: 'OUT_OF_SCOPE',
    paperRequests: 0,
    telegramRequests: 0,
    observedMutationRequests: 0,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  }, null, 2)}\n`, { mode: 0o600 });
});
