import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const TARGET_MAX_ORDER_KRW = 1_000_000;
const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_TRADING_POLICY_ARTIFACT_DIR ?? 'production-trading-policy-artifacts',
);
const enabled = process.env.PRODUCTION_TRADING_POLICY_LIMIT_APPLY === 'true';

test.skip(!enabled, 'Production trading policy apply runs only in its protected workflow.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA login credential is required');
  if (!/^[0-9a-f]{40}$/.test(expectedDeploySha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  }
}

type ApiResult<T> = { ok: boolean; status: number; body: T };

async function appApi<T>(page: Page, pathname: string, method: 'GET' | 'POST' = 'GET', body?: unknown) {
  const accessToken = await productionReadOnlyAccessToken(page);
  if (!accessToken) throw new Error('PRODUCTION_TRADING_POLICY_AUTH_TOKEN_MISSING');
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
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 200) }; }
    return { ok: response.ok, status: response.status, body: payload };
  }, { pathname, method, body, token: accessToken }) as Promise<ApiResult<T>>;
}

function writeEvidence(value: unknown) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-trading-policy-limit-apply.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test('Production admin policy aligns the single-entry ceiling to 1M with zero order authority', async ({ page }) => {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
  const before = await appApi<any>(page, '/api/trade-automation/status');
  expect(before.ok, JSON.stringify(before.body)).toBe(true);
  expect(before.body?.ok).toBe(true);
  const providers = ['toss', 'kiwoom', 'upbit', 'bitget'];
  for (const provider of providers) {
    expect(before.body?.liveExecutionServerEnabled?.[provider], `manual LIVE gate must be OFF: ${provider}`).toBe(false);
    expect(before.body?.liveAutomaticExecutionServerEnabled?.[provider], `AUTO LIVE gate must be OFF: ${provider}`).toBe(false);
  }
  const originalPolicy = structuredClone(before.body?.policy);
  expect(originalPolicy).toBeTruthy();
  expect(Number(originalPolicy.maxOrderKrw)).toBeLessThanOrEqual(TARGET_MAX_ORDER_KRW);

  const applied = await appApi<any>(page, '/api/trade-automation/admin/order-limit-1m', 'POST', {
    maxOrderKrw: TARGET_MAX_ORDER_KRW,
    confirmation: 'SET_MAX_ORDER_KRW_1000000_WITH_LIVE_DISABLED',
  });
  expect(applied.ok, JSON.stringify(applied.body)).toBe(true);
  expect(applied.body?.ok).toBe(true);
  expect(applied.body?.targetMaxOrderKrw).toBe(TARGET_MAX_ORDER_KRW);
  expect(applied.body?.policy?.maxOrderKrw).toBe(TARGET_MAX_ORDER_KRW);
  expect(applied.body?.policy?.totalCapitalKrw).toBeGreaterThanOrEqual(TARGET_MAX_ORDER_KRW);
  expect(applied.body?.liveTradingEnabledByThisRequest).toBe(false);
  expect(applied.body?.automaticTradingEnabledByThisRequest).toBe(false);
  expect(applied.body?.executionAuthority).toBe('NONE');
  for (const key of ['orderSubmitted', 'cancelRequested', 'amendRequested', 'transferRequested', 'withdrawalRequested']) {
    expect(applied.body?.[key], key).toBe(false);
  }

  const expectedPolicy = structuredClone(originalPolicy);
  expectedPolicy.totalCapitalKrw = Math.max(Number(originalPolicy.totalCapitalKrw), TARGET_MAX_ORDER_KRW);
  expectedPolicy.maxOrderKrw = TARGET_MAX_ORDER_KRW;
  expect(isDeepStrictEqual(applied.body?.policy, expectedPolicy)).toBe(true);

  const after = await appApi<any>(page, '/api/trade-automation/status');
  expect(after.ok, JSON.stringify(after.body)).toBe(true);
  expect(after.body?.ok).toBe(true);
  expect(isDeepStrictEqual(after.body?.policy, expectedPolicy)).toBe(true);
  expect(after.body?.actualOrderSubmittedByStatusRequest).toBe(false);
  for (const provider of providers) {
    expect(after.body?.liveExecutionServerEnabled?.[provider]).toBe(false);
    expect(after.body?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }

  writeEvidence({
    schemaVersion: 'production-trading-policy-limit-apply-v1',
    targetSha: expectedDeploySha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    officialProductionOrigin: true,
    authenticatedAdminSession: true,
    requestedMaxOrderKrw: TARGET_MAX_ORDER_KRW,
    appliedMaxOrderKrw: after.body.policy.maxOrderKrw,
    totalCapitalAtLeastTarget: after.body.policy.totalCapitalKrw >= TARGET_MAX_ORDER_KRW,
    policyUpdated: applied.body.policyUpdated === true,
    idempotent: applied.body.idempotent === true,
    unrelatedPolicyFieldsPreserved: true,
    manualLiveGatesOff: true,
    automaticLiveGatesOff: true,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    orders: 0,
    cancels: 0,
    amends: 0,
    transfers: 0,
    withdrawals: 0,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  });
});
