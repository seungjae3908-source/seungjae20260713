import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';

const enabled = process.env.PRODUCTION_AUTOMATION_RESEARCH_PREDEPLOY === 'true';
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '').trim();
const targetSha = String(process.env.TARGET_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_AUTOMATION_RESEARCH_PREDEPLOY_ARTIFACT_DIR
    ?? 'production-automation-research-predeploy-artifacts',
);

test.skip(!enabled, 'Runs only before the protected Automation/Research Production deployment mutates anything.');

if (enabled) {
  if (!qaLogin || !qaPassword) throw new Error('PRODUCTION_PREDEPLOY_LOGIN_REQUIRED');
  if (!/^[0-9a-f]{40}$/.test(targetSha)) throw new Error('PRODUCTION_PREDEPLOY_TARGET_SHA_REQUIRED');
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_PREDEPLOY_RUN_ID_REQUIRED');
  }
}

type ApiResult<T> = { ok: boolean; status: number; body: T | null };

async function appGet<T>(page: Page, pathname: string): Promise<ApiResult<T>> {
  const token = await productionReadOnlyAccessToken(page);
  if (!token) throw new Error('PRODUCTION_PREDEPLOY_AUTH_TOKEN_MISSING');
  const response = await page.request.get(pathname, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    failOnStatusCode: false,
    timeout: 15_000,
  });
  return {
    ok: response.ok(),
    status: response.status(),
    body: await response.json().catch(() => null) as T | null,
  };
}

function providerState(connections: unknown, provider: string) {
  return Array.isArray(connections)
    ? connections.find((row) => {
      const record = row && typeof row === 'object' ? row as Record<string, unknown> : {};
      return String(record.exchange ?? record.provider ?? '').toLowerCase() === provider;
    }) as Record<string, unknown> | undefined
    : undefined;
}

function writeEvidence(value: unknown) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-automation-research-predeploy-readiness.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

test('Production Automation/Paper/Research/Backtester readiness fails closed before any mutation', async ({ page }) => {
  test.setTimeout(120_000);
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });

  const [health, automation, paper] = await Promise.all([
    appGet<any>(page, '/api/health'),
    appGet<any>(page, '/api/trade-automation/status'),
    appGet<any>(page, '/api/trade-automation/paper-runtime-readiness'),
  ]);

  const blockers: string[] = [];
  if (!health.ok || health.body?.identityMatch !== true
    || !/^[0-9a-f]{40}$/.test(String(health.body?.deploySha ?? '').toLowerCase())
    || String(health.body?.deploySha ?? '').toLowerCase()
      !== String(health.body?.deployMarkerSha ?? '').toLowerCase()) {
    blockers.push('PRODUCTION_RUNTIME_IDENTITY_DRIFT');
  }

  if (!automation.ok || automation.body?.ok !== true) {
    blockers.push(`AUTOMATION_STATUS_HTTP_${automation.status}`);
  } else {
    for (const provider of ['toss', 'kiwoom', 'upbit', 'bitget']) {
      const connection = providerState(automation.body?.connections, provider);
      if (!connection) blockers.push(`PROVIDER_MISSING:${provider.toUpperCase()}`);
      else {
        if (connection.configured !== true) blockers.push(`PROVIDER_NOT_CONFIGURED:${provider.toUpperCase()}`);
        if (!connection.lastVerifiedAt) blockers.push(`PROVIDER_NOT_VERIFIED:${provider.toUpperCase()}`);
        if (connection.lastErrorCode != null) blockers.push(`PROVIDER_ERROR:${provider.toUpperCase()}`);
      }
      if (automation.body?.liveExecutionServerEnabled?.[provider] !== false) {
        blockers.push(`LIVE_SERVER_GATE_NOT_OFF:${provider.toUpperCase()}`);
      }
      if (automation.body?.liveAutomaticExecutionServerEnabled?.[provider] !== false) {
        blockers.push(`AUTO_SERVER_GATE_NOT_OFF:${provider.toUpperCase()}`);
      }
    }
  }

  if (!paper.ok || paper.body?.readOnlyProbe !== true
    || paper.body?.financialMutationCount !== 0
    || paper.body?.privateProviderRequests !== 0
    || paper.body?.orderSubmitted !== false
    || paper.body?.exchangeRequestSent !== false
    || paper.body?.realOrderAuthorityGranted !== false) {
    blockers.push(`PAPER_RUNTIME_READONLY_PRECHECK_FAILED_HTTP_${paper.status}`);
  }

  const uniqueBlockers = [...new Set(blockers)];
  writeEvidence({
    schemaVersion: 'production-automation-paper-research-backtester-predeploy-readiness-v2',
    generatedAt: new Date().toISOString(),
    targetSha,
    productionDeployRunId,
    activeProductionSha: /^[0-9a-f]{40}$/.test(String(health.body?.deploySha ?? '').toLowerCase())
      ? String(health.body?.deploySha).toLowerCase()
      : null,
    ready: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    providerReadiness: Object.fromEntries(['toss', 'kiwoom', 'upbit', 'bitget'].map((provider) => {
      const connection = providerState(automation.body?.connections, provider);
      return [provider, {
        configured: connection?.configured === true,
        verified: Boolean(connection?.lastVerifiedAt),
        errorFree: connection?.lastErrorCode == null,
        liveServerGateOff: automation.body?.liveExecutionServerEnabled?.[provider] === false,
        autoServerGateOff: automation.body?.liveAutomaticExecutionServerEnabled?.[provider] === false,
      }];
    })),
    scope: ['automaticTrading', 'automaticPaperTrading', 'researchCenter', 'backtester'],
    telegramExcludedFromScope: true,
    paperReadOnlyProbe: paper.body?.readOnlyProbe === true,
    readOnly: true,
    sshConfigured: false,
    databaseMutations: 0,
    deploymentExecuted: false,
    policyMutations: 0,
    telegramMessagesSent: 0,
    orders: 0,
    cancels: 0,
    amends: 0,
    transfers: 0,
    withdrawals: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  });

  expect(uniqueBlockers, `PRODUCTION_PREDEPLOY_READINESS_BLOCKED:${uniqueBlockers.join(',')}`).toEqual([]);
});
