import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { loginProductionReadOnly } from './support/production-readonly-login';

const enabled = process.env.PRODUCTION_LIVE_CREDENTIAL_REUSE_QA === 'true';
const baseUrl = process.env.PRODUCTION_BASE_URL?.trim() ?? '';
const login = process.env.PRODUCTION_QA_LOGIN?.trim() ?? '';
const password = process.env.PRODUCTION_QA_PASSWORD ?? '';
const expectedSha = process.env.EXPECTED_DEPLOY_SHA?.trim().toLowerCase() ?? '';
const productionDeployRunId = Number(process.env.EXPECTED_PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(process.env.PRODUCTION_LIVE_CREDENTIAL_REUSE_ARTIFACT_DIR ?? 'production-live-credential-reuse-artifacts');
// Toss is intentionally last. The preceding Account QA already performs a real
// Toss read, so verifying the other providers first avoids an immediate second
// token burst while preserving the required four-provider sequence.
const providers = ['kiwoom', 'upbit', 'bitget', 'toss'] as const;
type Provider = typeof providers[number];

// Backend verification can legitimately consume multiple 4s provider probes plus
// two transient retries (1s/2s backoff). Keep the browser wait budget above the
// provider-specific worst case so QA does not time out while the server is still
// performing a valid read-only verification.
const reuseResponseTimeoutMs: Record<Provider, number> = {
  kiwoom: 45_000,
  upbit: 25_000,
  bitget: 75_000,
  toss: 60_000,
};

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

function assertReuseBody(body: Record<string, unknown> | null) {
  expect(body).not.toBeNull();
  assertNoSensitiveKeys(body);
  expect(body?.ok).toBe(true);
  expect(body?.accountMode).toBe('live');
  expect(body?.configured).toBe(true);
  expect(body?.verified).toBe(true);
  expect(body?.reusedReadonlyCredential).toBe(true);
  expect(body?.credentialsReturned).toBe(false);
  expect(body?.liveExecutionActivated).toBe(false);
  expect(body?.automaticLiveExecutionActivated).toBe(false);
  expect(body?.orderRequests).toBe(0);
  expect(body?.cancelRequests).toBe(0);
  expect(body?.amendRequests).toBe(0);
  expect(body?.transferRequests).toBe(0);
  expect(body?.withdrawalRequests).toBe(0);
  expect(body?.realOrderSubmitted).toBe(false);
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
  test.setTimeout(7 * 60_000);
  if (!baseUrl || !login || !password || !/^[0-9a-f]{40}$/.test(expectedSha)
    || !Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
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
  page.on('request', (request) => {
    const method = request.method().toUpperCase();
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return;
    const url = new URL(request.url());
    if (url.origin !== new URL(baseUrl).origin) return;
    if (!url.pathname.startsWith('/api/trade-automation/')) return;
    observedMutations.push({ method, path: url.pathname });
  });

  const evidence: Array<Record<string, unknown>> = [];

  for (const provider of providers) {
    const card = page.getByTestId('live-connection-' + provider);
    await expect(card).toBeVisible({ timeout: 15000 });
    const button = card.getByRole('button', { name: '저장된 조회키로 연결·검증' });
    const buttonVisible = await button.isVisible({ timeout: 1000 }).catch(() => false);

    if (buttonVisible) {
      const endpoint = '/api/trade-automation/connections/' + provider + '/reuse-readonly';
      const timeoutMs = reuseResponseTimeoutMs[provider];

      const response = await test.step('reuse-readonly UI verification: ' + provider, async () => {
        const responsePromise = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return candidate.request().method() === 'POST' && url.pathname === endpoint;
        }, { timeout: timeoutMs });

        await button.click({ timeout: 5000 });
        try {
          return await responsePromise;
        } catch (error) {
          throw new Error(
            'PRODUCTION_CREDENTIAL_REUSE_RESPONSE_TIMEOUT:' + provider + ':' + timeoutMs,
            { cause: error },
          );
        }
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      expect(response.status(), provider + ':' + JSON.stringify(body)).toBe(200);
      assertReuseBody(body);

      await expect(card).toContainText(/거래키\s*저장됨/, { timeout: 15000 });
      await expect(card).toContainText(/검증됨/, { timeout: 15000 });

      evidence.push({
        provider,
        uiAction: 'clicked',
        configured: true,
        verified: true,
        reusedReadonlyCredential: true,
        credentialsReturned: false,
        liveExecutionActivated: false,
        automaticLiveExecutionActivated: false,
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
        transferRequests: 0,
        withdrawalRequests: 0,
        realOrderSubmitted: false,
      });
    } else {
      const endpoint = '/api/trade-automation/connections/' + provider + '/reuse-readonly';
      const token = await productionAccessToken(page);
      const response = await page.request.post(new URL(endpoint, baseUrl).toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        data: { confirmed: true },
        timeout: 30000,
        failOnStatusCode: false,
      });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      expect(response.status(), JSON.stringify(body)).toBe(200);
      assertReuseBody(body);
      observedMutations.push({ method: 'POST', path: endpoint });

      await page.reload({ waitUntil: 'commit' });
      const refreshedCard = page.getByTestId('live-connection-' + provider);
      await expect(refreshedCard).toContainText(/거래키\s*저장됨/, { timeout: 15000 });
      await expect(refreshedCard).toContainText(/검증됨/, { timeout: 15000 });
      evidence.push({
        provider,
        uiAction: 'already-verified',
        configured: true,
        verified: true,
        reusedReadonlyCredential: true,
        credentialsReturned: false,
        liveExecutionActivated: false,
        automaticLiveExecutionActivated: false,
        orderRequests: 0,
        cancelRequests: 0,
        amendRequests: 0,
        transferRequests: 0,
        withdrawalRequests: 0,
        realOrderSubmitted: false,
      });
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
    expect(after?.liveExecutionReadiness?.[provider]?.connectionConfigured).toBe(true);
    expect(after?.liveExecutionReadiness?.[provider]?.providerVerified).toBe(true);
    expect(after?.liveExecutionServerEnabled?.[provider]).toBe(false);
    expect(after?.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'production-live-credential-reuse-qa.json'), JSON.stringify({
    schemaVersion: 'production-live-credential-reuse-qa-v1',
    targetSha: expectedSha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
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
});
