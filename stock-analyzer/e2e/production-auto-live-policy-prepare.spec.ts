import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginProductionReadOnly, productionReadOnlyAccessToken } from './support/production-readonly-login';
import { approvedAdministratorAutomaticLivePolicy, administratorAutomaticLivePolicyBlockers } from '../../api-server/src/services/automatic-live-owner-policy.service';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/u, '');
const login = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const password = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const targetSha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const enabled = process.env.PRODUCTION_AUTO_LIVE_POLICY_PREPARE === 'true';
const outputDir = path.resolve(
  process.env.PRODUCTION_AUTO_LIVE_POLICY_ARTIFACT_DIR ?? 'production-auto-live-policy-artifacts',
);
const MARKETS = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
const PROVIDERS = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
const DEFAULT_STRATEGIES = [
  'TREND_PULLBACK_REACCEL_V1',
  'US_EVENT_RVOL_FIRST_PULLBACK_V1',
  'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
  'KR_PRESSURE_BREAKOUT_V1',
  'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
  'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
] as const;

test.skip(!enabled, 'Runs only in the protected Automatic LIVE policy preparation lane.');

async function appApi(page: Page, pathname: string, method = 'GET', body?: unknown) {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('PRODUCTION_AUTO_LIVE_POLICY_TOKEN_MISSING');
  return page.evaluate(async ({ pathname, method, body, token }) => {
    const response = await fetch(pathname, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => null) };
  }, { pathname, method, body, token });
}

function policyBlockers(policy: any) {
  const blockers: string[] = administratorAutomaticLivePolicyBlockers(policy);
  if (policy?.mode !== 'automatic' || policy?.automaticEnabled !== true) blockers.push('AUTOMATIC_POLICY_OFF');
  if (policy?.emergencyStopped !== false || policy?.newEntriesStopped !== false) blockers.push('MEMBER_STOP_ACTIVE');
  for (const market of MARKETS) if (policy?.marketEnabled?.[market] !== true) blockers.push(`MARKET_OFF:${market}`);
  for (const provider of PROVIDERS) if (policy?.exchangeEnabled?.[provider] !== true) blockers.push(`PROVIDER_OFF:${provider}`);
  if (policy?.stockBrokerByMarket?.us_stock !== 'kiwoom') blockers.push('US_BROKER_NOT_KIWOOM');
  if (!['kiwoom', 'toss'].includes(policy?.stockBrokerByMarket?.domestic_stock)) blockers.push('KR_BROKER_INVALID');
  if (!Number.isInteger(policy?.bitgetLeverage) || policy.bitgetLeverage < 2 || policy.bitgetLeverage > 7) {
    blockers.push('BITGET_LEVERAGE_INVALID');
  }
  if (policy?.riskOptimizationEnabled !== true) blockers.push('RISK_OPTIMIZATION_OFF');
  if (!['limited-50', 'validated', 'formula-ai-exception'].includes(policy?.pilotStage)) blockers.push('PILOT_STAGE_NOT_LIVE');
  if (!Array.isArray(policy?.enabledStrategies) || policy.enabledStrategies.length === 0) blockers.push('STRATEGY_ALLOWLIST_EMPTY');
  return blockers;
}

test('prepare the administrator four-market Automatic LIVE policy without execution authority', async ({ page }) => {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!login || !password || !/^[0-9a-f]{40}$/u.test(targetSha)
    || !Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_AUTO_LIVE_POLICY_CONFIGURATION_INVALID');
  }
  await loginProductionReadOnly(page, { login, password });
  const healthResponse = await page.request.get('/api/health');
  expect(healthResponse.status()).toBe(200);
  const health: any = await healthResponse.json();
  expect(String(health?.deploySha ?? '').toLowerCase()).toBe(targetSha);
  expect(health?.identityMatch).toBe(true);
  expect(health?.autoTradingBackground?.liveModeRequested).toBe(false);
  expect(health?.autoTradingBackground?.liveEntriesArmed).toBe(false);

  let status = await appApi(page, '/api/trade-automation/status');
  expect(status.ok, JSON.stringify(status.body)).toBe(true);
  expect(status.body?.administratorOrderBaseline).toBe(true);
  expect(status.body?.administratorLeveragePolicy).toBe(true);
  let policy = status.body?.policy;
  let memberStopResumed = false;
  let policyConfigurationMutationCount = 0;

  // A deployment approval is not an owner instruction to remove a sticky
  // trading stop. Preparation must fail closed and preserve that setting.
  expect(policy?.emergencyStopped, 'PREACTIVATION_MEMBER_STOP_REQUIRES_OWNER_RESUME').toBe(false);
  expect(policy?.newEntriesStopped, 'PREACTIVATION_MEMBER_STOP_REQUIRES_OWNER_RESUME').toBe(false);
  for (const provider of PROVIDERS) expect(status.body?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);

  const leverage = Number.isInteger(policy?.bitgetLeverage)
    && policy.bitgetLeverage >= 2 && policy.bitgetLeverage <= 7 ? policy.bitgetLeverage : 2;
  const strategies = Array.isArray(policy?.enabledStrategies) && policy.enabledStrategies.length > 0
    ? policy.enabledStrategies : [...DEFAULT_STRATEGIES];
  const preparedPolicy = {
    ...approvedAdministratorAutomaticLivePolicy(policy),
    mode: 'automatic',
    automaticEnabled: true,
    emergencyStopped: false,
    newEntriesStopped: false,
    marketEnabled: Object.fromEntries(MARKETS.map((market) => [market, true])),
    exchangeEnabled: Object.fromEntries(PROVIDERS.map((provider) => [provider, true])),
    stockBrokerByMarket: {
      ...(policy?.stockBrokerByMarket ?? {}),
      domestic_stock: policy?.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom',
      us_stock: 'kiwoom',
    },
    bitgetLeverage: leverage,
    riskOptimizationEnabled: true,
    pilotStage: 'formula-ai-exception',
    enabledStrategies: strategies,
    confirmation: { acknowledged: true },
  };
  if (policyBlockers(policy).length > 0) {
    const saved = await appApi(page, '/api/trade-automation/policy', 'PUT', preparedPolicy);
    expect(saved.ok, JSON.stringify(saved.body)).toBe(true);
    expect(saved.body?.ok).toBe(true);
    expect(saved.body?.defaultOff).toBe(false);
    policyConfigurationMutationCount += 1;
  }

  status = await appApi(page, '/api/trade-automation/status');
  expect(status.ok, JSON.stringify(status.body)).toBe(true);
  const finalBlockers = policyBlockers(status.body?.policy);
  expect(finalBlockers, `Automatic LIVE policy blockers: ${finalBlockers.join(',')}`).toEqual([]);
  for (const provider of PROVIDERS) {
    expect(status.body?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }
  expect(status.body?.actualOrderSubmittedByStatusRequest).toBe(false);

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(outputDir, 'production-auto-live-policy-prepare.json'), `${JSON.stringify({
    schemaVersion: 'production-auto-live-policy-prepare-v1',
    targetSha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    administratorPolicy: true,
    fourMarketsEnabled: true,
    fourProvidersEnabled: true,
    strategyAllowlistReady: true,
    riskOptimizationEnabled: true,
    memberStopResumed,
    policyConfigurationMutationCount,
    policyReady: true,
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
