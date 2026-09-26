import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_ACCOUNT_READONLY_ARTIFACT_DIR ?? 'production-account-readonly-artifacts',
);

const productionLiveQaEnabled = process.env.PRODUCTION_ACCOUNT_READONLY_LIVE_QA === 'true';
test.skip(!productionLiveQaEnabled, 'Production real-account read-only QA runs only in its protected dedicated workflow.');

if (productionLiveQaEnabled) {
  if (!baseUrl) throw new Error('PRODUCTION_BASE_URL is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA login credential is required');
  if (!/^[0-9a-f]{40}$/.test(expectedDeploySha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
}

const productionOrigin = productionLiveQaEnabled ? new URL(baseUrl).origin : 'https://lsj119.com';
const cryptoProviders = ['upbit', 'bitget'] as const;
const stockProviders = ['toss', 'kiwoom'] as const;
type Provider = typeof cryptoProviders[number] | typeof stockProviders[number];

type SafetySnapshot = {
  provider: string;
  readOnly: boolean;
  connected: boolean;
  status: string;
  checkedAt: string;
  lastGoodAt: string | null;
  stale: boolean;
  errorCode: string | null;
  orderRequests: number;
  cancelRequests: number;
  amendRequests: number;
  transferRequests: number;
  withdrawalRequests: number;
  credentialsReturned: boolean;
  liveTradingEnabled: boolean;
  autoTradingEnabled: boolean;
};

type CredentialStatus = {
  ok?: boolean;
  encryptionConfigured?: boolean;
  supportedProviders?: string[];
  hiddenProviders?: string[];
  credentialsReturned?: boolean;
  privateProviderRequests?: number;
  orderRequests?: number;
  cancelRequests?: number;
  amendRequests?: number;
  transferRequests?: number;
  withdrawalRequests?: number;
  liveTradingEnabled?: boolean;
  autoTradingEnabled?: boolean;
};

function writeEvidence(value: unknown) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-account-readonly-live-qa.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function assertZeroMutationSafety(value: SafetySnapshot) {
  expect(value.readOnly).toBe(true);
  expect(value.orderRequests).toBe(0);
  expect(value.cancelRequests).toBe(0);
  expect(value.amendRequests).toBe(0);
  expect(value.transferRequests).toBe(0);
  expect(value.withdrawalRequests).toBe(0);
  expect(value.credentialsReturned).toBe(false);
  expect(value.liveTradingEnabled).toBe(false);
  expect(value.autoTradingEnabled).toBe(false);
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'commit', timeout: 15_000 });
  const loginId = page.getByLabel('아이디');
  const loginPassword = page.getByLabel('비밀번호');
  const loginButton = page.getByRole('button', { name: '로그인', exact: true });

  await expect(loginId).toBeVisible({ timeout: 15_000 });
  await expect(loginPassword).toBeVisible({ timeout: 15_000 });
  await expect(loginButton).toBeVisible({ timeout: 15_000 });

  await loginId.fill(qaLogin);
  await loginPassword.fill(qaPassword);
  await loginButton.click();
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

test('Production real-account read-only providers return fresh connected snapshots with zero mutation authority', async ({ page }) => {
  const blocked: Array<{ method: string; path: string; reason: string }> = [];
  const observedAppMutations: Array<{ method: string; path: string }> = [];
  const snapshots = new Map<Provider, SafetySnapshot>();
  let credentialStatus: CredentialStatus | null = null;

  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    const url = new URL(request.url());
    blocked.push({ method: request.method(), path: url.pathname, reason });
  });

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== productionOrigin || !url.pathname.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase())) {
      observedAppMutations.push({ method: request.method(), path: url.pathname });
    }
  });

  page.on('response', async (response) => {
    const request = response.request();
    if (request.method() !== 'GET') return;
    const url = new URL(response.url());
    if (url.origin !== productionOrigin) return;

    if (url.pathname === '/api/accounts/read-only/credentials/status' && response.ok()) {
      try {
        credentialStatus = await response.json() as CredentialStatus;
      } catch {
        // The explicit wait below fails closed if no valid JSON status is captured.
      }
      return;
    }

    const match = /^\/api\/accounts\/read-only\/(toss|kiwoom|upbit|bitget)$/.exec(url.pathname);
    if (!match || !response.ok()) return;
    try {
      snapshots.set(match[1] as Provider, await response.json() as SafetySnapshot);
    } catch {
      // The explicit provider assertions below fail closed on missing valid JSON.
    }
  });

  await login(page);
  await page.goto('/account', { waitUntil: 'commit', timeout: 15_000 });
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => credentialStatus !== null, {
    timeout: 20_000,
    intervals: [200, 500, 1_000],
  }).toBe(true);

  const supported = new Set(
    Array.isArray(credentialStatus?.supportedProviders)
      ? credentialStatus!.supportedProviders!.map((value) => String(value).toLowerCase())
      : [],
  );

  for (const provider of cryptoProviders) {
    expect(supported.has(provider), `${provider} must be supported in Production account read-only QA`).toBe(true);
  }
  expect(
    stockProviders.some((provider) => supported.has(provider)),
    'Toss or Kiwoom stock account read-only provider must be supported',
  ).toBe(true);

  const providers: Provider[] = [
    ...stockProviders.filter((provider) => supported.has(provider)),
    ...cryptoProviders,
  ];

  const refresh = page.getByRole('button', { name: '계좌 연결 새로고침' });
  await expect(refresh).toBeVisible({ timeout: 10_000 });
  await refresh.click();

  await expect.poll(
    () => providers.every((provider) => snapshots.has(provider)),
    { timeout: 45_000, intervals: [500, 1_000, 2_000] },
  ).toBe(true);

  expect(credentialStatus?.ok).toBe(true);
  expect(credentialStatus?.encryptionConfigured).toBe(true);
  expect(credentialStatus?.credentialsReturned).toBe(false);
  expect(credentialStatus?.privateProviderRequests).toBe(0);
  expect(credentialStatus?.orderRequests).toBe(0);
  expect(credentialStatus?.cancelRequests).toBe(0);
  expect(credentialStatus?.amendRequests).toBe(0);
  expect(credentialStatus?.transferRequests).toBe(0);
  expect(credentialStatus?.withdrawalRequests).toBe(0);
  expect(credentialStatus?.liveTradingEnabled).toBe(false);
  expect(credentialStatus?.autoTradingEnabled).toBe(false);

  const sanitizedProviders: Array<{
    provider: Provider;
    connected: boolean;
    status: string;
    stale: boolean;
    errorCode: string | null;
    checkedAtPresent: boolean;
    lastGoodAtPresent: boolean;
  }> = [];

  for (const provider of providers) {
    const snapshot = snapshots.get(provider);
    expect(snapshot, `${provider} Production snapshot must be captured`).toBeTruthy();
    expect(snapshot!.provider).toBe(provider);
    assertZeroMutationSafety(snapshot!);

    const isRequiredCrypto = cryptoProviders.includes(provider as typeof cryptoProviders[number]);
    if (isRequiredCrypto || snapshot!.connected) {
      expect(snapshot!.connected, `${provider} must prove a real connected account read`).toBe(true);
      expect(snapshot!.status).toBe('CONNECTED');
      expect(snapshot!.stale).toBe(false);
      expect(snapshot!.errorCode).toBeNull();
      expect(Number.isFinite(Date.parse(snapshot!.checkedAt))).toBe(true);
      expect(snapshot!.lastGoodAt).not.toBeNull();
      expect(Number.isFinite(Date.parse(String(snapshot!.lastGoodAt)))).toBe(true);
    }

    sanitizedProviders.push({
      provider,
      connected: snapshot!.connected,
      status: snapshot!.status,
      stale: snapshot!.stale,
      errorCode: snapshot!.errorCode,
      checkedAtPresent: Number.isFinite(Date.parse(snapshot!.checkedAt)),
      lastGoodAtPresent: snapshot!.lastGoodAt !== null,
    });
  }

  const connectedStockProviders = stockProviders.filter((provider) => snapshots.get(provider)?.connected === true);
  expect(connectedStockProviders.length, 'At least one real stock account provider must be connected').toBeGreaterThanOrEqual(1);

  expect(blocked).toEqual([]);
  expect(observedAppMutations).toEqual([]);

  writeEvidence({
    schemaVersion: 'production-account-readonly-live-qa-v1',
    targetSha: expectedDeploySha,
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    credentialVaultEncryptionConfigured: true,
    providers: sanitizedProviders,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    blockedMutationRequests: 0,
    observedAppMutationRequests: 0,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
  });
});
