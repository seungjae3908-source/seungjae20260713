import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/u, '');
const login = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const password = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const sha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const phase = String(process.env.AUTOMATIC_PAPER_ACTIVATION_PHASE ?? 'VERIFY').toUpperCase();
const enabled = process.env.PRODUCTION_AUTOMATIC_PAPER_ACTIVATION === 'true';
const artifactDir = path.resolve(process.cwd(), process.env.AUTOMATIC_PAPER_ARTIFACT_DIR
  ?? 'production-automatic-paper-activation-artifacts');

test.skip(!enabled, 'Production automatic Paper activation runs only in its protected workflow.');
if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('OFFICIAL_PRODUCTION_ORIGIN_REQUIRED');
  if (!login || !password) throw new Error('PRODUCTION_QA_CREDENTIAL_REQUIRED');
  if (!/^[0-9a-f]{40}$/u.test(sha)) throw new Error('EXACT_DEPLOY_SHA_REQUIRED');
  if (!['PREPARE', 'VERIFY'].includes(phase)) throw new Error('AUTOMATIC_PAPER_PHASE_INVALID');
}

type ApiResult = { ok: boolean; status: number; body: any };

async function api(page: Page, pathname: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): Promise<ApiResult> {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('AUTOMATIC_PAPER_AUTH_TOKEN_MISSING');
  const response = await page.request.fetch(new URL(pathname, baseUrl).toString(), {
    method,
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    data: body as any,
    failOnStatusCode: false,
  });
  return { ok: response.ok(), status: response.status(), body: await response.json().catch(() => null) };
}

function zeroAuthority(value: any) {
  expect(value?.orderSubmitted ?? false).toBe(false);
  expect(value?.exchangeRequestSent ?? false).toBe(false);
  expect(value?.privateProviderRequests ?? 0).toBe(0);
  expect(value?.financialMutationCount ?? 0).toBe(0);
  expect(value?.liveTradingAuthorityGranted ?? false).toBe(false);
  expect(value?.autoTradingAuthorityGranted ?? false).toBe(false);
}

test('activate and verify isolated four-market automatic Paper runtime', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await loginProductionReadOnly(page, { login, password });

  const healthResponse = await page.request.get(new URL('/api/health', baseUrl).toString());
  expect(healthResponse.ok()).toBe(true);
  const health = await healthResponse.json();
  expect(health?.deploySha).toBe(sha);
  expect(health?.identityMatch).toBe(true);

  let status = await api(page, '/api/trade-automation/status');
  expect(status.ok, JSON.stringify(status.body)).toBe(true);
  for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
    expect(status.body?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }

  if (phase === 'PREPARE') {
    let wallets = await api(page, '/api/paper-journal/four-market/status');
    expect(wallets.ok, JSON.stringify(wallets.body)).toBe(true);
    zeroAuthority(wallets.body);

    if (Number(wallets.body?.policy?.totalCapitalKrw ?? 0) < 1_000_000) {
      const policy = await api(page, '/api/paper-journal/admin-four-market/prepare-policy', 'POST', {
        confirmation: 'SET_ADMIN_FOUR_MARKETS_1M_PAPER_POLICY',
      });
      expect(policy.ok, JSON.stringify(policy.body)).toBe(true);
      zeroAuthority(policy.body);
      wallets = await api(page, '/api/paper-journal/four-market/status');
    }
    if (wallets.body?.ready !== true) {
      expect(wallets.body?.canCreate, JSON.stringify(wallets.body?.creationBlockers)).toBe(true);
      const created = await api(page, '/api/paper-journal/four-market/bootstrap', 'POST', {
        confirmation: 'START_ADMIN_FOUR_1M_PAPER_WALLETS_PRESERVE_HISTORY',
      });
      expect(created.ok, JSON.stringify(created.body)).toBe(true);
      expect(created.body?.ready).toBe(true);
      zeroAuthority(created.body);
    }

    const policy = status.body?.policy;
    const saved = await api(page, '/api/trade-automation/policy', 'PUT', {
      ...policy,
      mode: 'automatic',
      automaticEnabled: true,
      emergencyStopped: false,
      newEntriesStopped: false,
      marketEnabled: {
        ...policy?.marketEnabled,
        domestic_stock: true,
        us_stock: true,
        crypto_spot: true,
        crypto_futures: true,
      },
      stockBrokerByMarket: {
        ...policy?.stockBrokerByMarket,
        domestic_stock: policy?.stockBrokerByMarket?.domestic_stock === 'toss' ? 'toss' : 'kiwoom',
        us_stock: 'kiwoom',
      },
      exchangeEnabled: { ...policy?.exchangeEnabled, toss: true, kiwoom: true, upbit: true, bitget: true },
      enabledStrategies: [
        'KR_PRESSURE_BREAKOUT_V1',
        'US_STOCKS_IN_PLAY_ORB_RETEST_V1',
        'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1',
        'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1',
      ],
      riskOptimizationEnabled: true,
      bitgetLeverage: Number.isInteger(Number(policy?.bitgetLeverage))
        && Number(policy.bitgetLeverage) >= 2 && Number(policy.bitgetLeverage) <= 7
        ? Number(policy.bitgetLeverage) : 2,
      confirmation: { acknowledged: true },
    });
    expect(saved.ok, JSON.stringify(saved.body)).toBe(true);
    expect(saved.body?.policy?.automaticEnabled).toBe(true);
    expect(saved.body?.policy?.enabledStrategies).toHaveLength(4);
  }

  let readiness: ApiResult | null = null;
  for (let attempt = 0; attempt < (phase === 'VERIFY' ? 120 : 1); attempt += 1) {
    readiness = await api(page, '/api/trade-automation/paper-runtime-readiness');
    if (readiness.ok && readiness.body?.readyForPaperEvaluation === (phase === 'VERIFY')) break;
    await page.waitForTimeout(2_000);
  }
  expect(readiness?.ok, JSON.stringify(readiness?.body)).toBe(true);
  zeroAuthority(readiness?.body);
  if (phase === 'VERIFY') {
    expect(readiness?.body?.readyForPaperEvaluation, JSON.stringify(readiness?.body?.blockers)).toBe(true);
    expect(readiness?.body?.workerMode).toBe('PAPER_ONLY');
    expect(readiness?.body?.paperOnlyMode).toBe(true);
    expect(readiness?.body?.workerTickFresh).toBe(true);
    expect(readiness?.body?.handoffReady).toBe(true);
    expect(readiness?.body?.executionProjectionReady).toBe(true);
  } else {
    const allowed = new Set([
      'BACKGROUND_PAPER_ONLY_WORKER_REQUIRED',
      'BACKGROUND_WORKER_TICK_NOT_HEALTHY',
      'BACKGROUND_NEW_ENTRIES_FAIL_CLOSED',
      'BACKGROUND_CANONICAL_HANDOFF_NOT_READY',
      'BACKGROUND_EXECUTION_PROJECTION_NOT_HEALTHY',
    ]);
    expect((readiness?.body?.blockers ?? []).every((blocker: string) => allowed.has(blocker)),
      JSON.stringify(readiness?.body?.blockers)).toBe(true);
  }

  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(path.join(artifactDir, `${phase.toLowerCase()}.json`), `${JSON.stringify({
    schemaVersion: 'production-automatic-paper-only-activation-v1',
    generatedAt: new Date().toISOString(),
    targetSha: sha,
    phase,
    readyForPaperEvaluation: readiness?.body?.readyForPaperEvaluation === true,
    workerMode: readiness?.body?.workerMode ?? null,
    blockers: readiness?.body?.blockers ?? [],
    telegramRequired: false,
    orders: 0,
    cancels: 0,
    amends: 0,
    transfers: 0,
    withdrawals: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
  }, null, 2)}\n`, { mode: 0o600 });
});
