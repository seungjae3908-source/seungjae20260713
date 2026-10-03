import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginProductionReadOnly } from './support/production-readonly-login';

const enabled = process.env.PRODUCTION_LIVE_CREDENTIAL_REUSE_QA === 'true';
const baseUrl = process.env.PRODUCTION_BASE_URL?.trim() ?? '';
const login = process.env.PRODUCTION_QA_LOGIN?.trim() ?? '';
const password = process.env.PRODUCTION_QA_PASSWORD ?? '';
const expectedSha = process.env.EXPECTED_DEPLOY_SHA?.trim().toLowerCase() ?? '';
const artifactDir = path.resolve(process.env.PRODUCTION_LIVE_CREDENTIAL_REUSE_ARTIFACT_DIR ?? 'production-live-credential-reuse-artifacts');
const providers = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
type Provider = typeof providers[number];

function accessTokenFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = accessTokenFromUnknown(item, depth + 1);
      if (token) return token;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.access_token === 'string' && record.access_token.length > 20) return record.access_token;
  for (const child of Object.values(record)) {
    const token = accessTokenFromUnknown(child, depth + 1);
    if (token) return token;
  }
  return null;
}

async function productionAccessToken(page: Page) {
  const state = await page.context().storageState();
  const origin = new URL(baseUrl).origin;
  const originState = state.origins.find((entry) => entry.origin === origin);
  for (const entry of originState?.localStorage ?? []) {
    try {
      const token = accessTokenFromUnknown(JSON.parse(entry.value));
      if (token) return token;
    } catch {
      // Ignore unrelated localStorage values.
    }
  }
  throw new Error('PRODUCTION_CREDENTIAL_REUSE_ACCESS_TOKEN_MISSING');
}

function assertNoSensitiveKeys(value: unknown, trail: string[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, [...trail, String(index)]));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const forbidden = new Set([
    'clientSecret', 'secretKey', 'accessKey', 'apiKey', 'passphrase',
    'encryptedCredentials', 'authorization', 'signature', 'prehash',
    'accountUid', 'accountRef', 'vaultRowId',
  ]);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) {
      throw new Error('PRODUCTION_CREDENTIAL_REUSE_SECRET_LEAK:' + [...trail, key].join('.'));
    }
    assertNoSensitiveKeys(child, [...trail, key]);
  }
}

async function requireHealthIdentity(page: Page) {
  const response = await page.request.get(new URL('/api/health', baseUrl).toString(), {
    timeout: 15000,
    failOnStatusCode: false,
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.ok).toBe(true);
  expect(body.deploySha).toBe(expectedSha);
  expect(body.processDeploySha).toBe(expectedSha);
  expect(body.deployMarkerSha).toBe(expectedSha);
  expect(body.identityMatch).toBe(true);
  expect(body.identityStatus).toBe('match');
}

test.skip(!enabled, 'Production credential reuse QA is disabled');

test('saved read-only credentials connect and verify all providers with zero financial mutation', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  if (!baseUrl || !login || !password || !/^[0-9a-f]{40}$/.test(expectedSha)) {
    throw new Error('PRODUCTION_CREDENTIAL_REUSE_QA_ENV_INCOMPLETE');
  }

  await requireHealthIdentity(page);
  await loginProductionReadOnly(page, { login, password });
  const accessToken = await productionAccessToken(page);
  await page.goto('/account', { waitUntil: 'commit', timeout: 20000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 20000 });

  const beforeResponse = await page.request.get(new URL('/api/trade-automation/status', baseUrl).toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
    },
    timeout: 15000,
    failOnStatusCode: false,
  });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  assertNoSensitiveKeys(before);

  for (const provider of providers) {
    expect(before?.liveExecutionServerEnabled?.[provider]).toBe(false);
    expect(before?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }

  const observedMutations: Array<{ method: string; path: string }> = [];
  const evidence: Array<Record<string, unknown>> = [];
  const failures: Array<{ provider: Provider; status: number; errorCode: string | null }> = [];

  for (const provider of providers) {
    const endpoint = '/api/trade-automation/connections/' + provider + '/reuse-readonly';
    const response = await page.request.post(new URL(endpoint, baseUrl).toString(), {
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      data: { confirmed: true },
      timeout: 30000,
      failOnStatusCode: false,
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (body) assertNoSensitiveKeys(body);

    observedMutations.push({ method: 'POST', path: endpoint });
    const success = response.status() === 200
      && body?.ok === true
      && body?.accountMode === 'live'
      && body?.configured === true
      && body?.verified === true
      && body?.reusedReadonlyCredential === true
      && body?.credentialsReturned === false
      && body?.liveExecutionActivated === false
      && body?.automaticLiveExecutionActivated === false
      && body?.orderRequests === 0
      && body?.cancelRequests === 0
      && body?.amendRequests === 0
      && body?.transferRequests === 0
      && body?.withdrawalRequests === 0
      && body?.realOrderSubmitted === false;

    const errorCode = typeof body?.error === 'string' ? body.error : null;
    evidence.push({
      provider,
      httpStatus: response.status(),
      configured: body?.configured === true,
      verified: body?.verified === true,
      reusedReadonlyCredential: body?.reusedReadonlyCredential === true,
      credentialsReturned: body?.credentialsReturned === false ? false : null,
      liveExecutionActivated: body?.liveExecutionActivated === true,
      automaticLiveExecutionActivated: body?.automaticLiveExecutionActivated === true,
      orderRequests: Number(body?.orderRequests ?? 0),
      cancelRequests: Number(body?.cancelRequests ?? 0),
      amendRequests: Number(body?.amendRequests ?? 0),
      transferRequests: Number(body?.transferRequests ?? 0),
      withdrawalRequests: Number(body?.withdrawalRequests ?? 0),
      realOrderSubmitted: body?.realOrderSubmitted === true,
      errorCode,
    });
    if (!success) failures.push({ provider, status: response.status(), errorCode });
  }

  await page.reload({ waitUntil: 'commit' });
  for (const row of evidence) {
    const provider = row.provider as Provider;
    const card = page.getByTestId('live-connection-' + provider);
    await expect(card).toBeVisible({ timeout: 15000 });
    if (row.verified === true) {
      await expect(card).toContainText(/거래키\s*저장됨/, { timeout: 15000 });
      await expect(card).toContainText(/검증됨/, { timeout: 15000 });
    }
  }

  const allowed = new Set(providers.map((provider) => '/api/trade-automation/connections/' + provider + '/reuse-readonly'));
  for (const mutation of observedMutations) {
    expect(mutation.method).toBe('POST');
    expect(allowed.has(mutation.path), 'Unexpected trade mutation: ' + mutation.method + ' ' + mutation.path).toBe(true);
  }

  const afterResponse = await page.request.get(new URL('/api/trade-automation/status', baseUrl).toString(), {
    headers: {
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
    },
    timeout: 15000,
    failOnStatusCode: false,
  });
  expect(afterResponse.status()).toBe(200);
  const after = await afterResponse.json();
  assertNoSensitiveKeys(after);

  for (const provider of providers) {
    const row = evidence.find((candidate) => candidate.provider === provider);
    if (row?.verified === true) {
      expect(after?.liveExecutionReadiness?.[provider]?.connectionConfigured).toBe(true);
      expect(after?.liveExecutionReadiness?.[provider]?.providerVerified).toBe(true);
    }
    expect(after?.liveExecutionServerEnabled?.[provider]).toBe(false);
    expect(after?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'production-live-credential-reuse-qa.json'), JSON.stringify({
    schemaVersion: 'production-live-credential-reuse-qa-v1',
    targetSha: expectedSha,
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    providers: evidence,
    observedCredentialConnectionMutations: observedMutations.length,
    observedMutationPaths: observedMutations,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    credentialsReturned: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
  }, null, 2) + '\n');

  expect(
    failures,
    'Credential reuse provider failures: ' + JSON.stringify(failures),
  ).toEqual([]);
});
