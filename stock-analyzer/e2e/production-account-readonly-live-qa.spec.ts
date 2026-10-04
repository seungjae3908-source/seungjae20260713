import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginProductionReadOnly } from './support/production-readonly-login';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';
import { parseBitgetReadonlyDiagnosticHeader, type SanitizedBitgetReadonlyDiagnostic } from './production-account-readonly-live-qa-diagnostic';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const rawTargetProviders = String(process.env.PRODUCTION_ACCOUNT_READONLY_TARGET_PROVIDERS ?? '').trim();
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
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  }
  if (new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
}

const productionOrigin = productionLiveQaEnabled ? new URL(baseUrl).origin : 'https://lsj119.com';
const cryptoProviders = ['upbit', 'bitget'] as const;
const stockProviders = ['toss', 'kiwoom'] as const;
const activationProviders = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
type Provider = typeof cryptoProviders[number] | typeof stockProviders[number];
type ActivationProvider = typeof activationProviders[number];

const requestedProviders = rawTargetProviders === '' ? [] : rawTargetProviders.split(',');
const testedProviders = [...requestedProviders].sort() as ActivationProvider[];
const activationProviderSet = new Set<string>(activationProviders);

if (productionLiveQaEnabled && rawTargetProviders !== '') {
  if (requestedProviders.length === 0
    || new Set(requestedProviders).size !== requestedProviders.length
    || requestedProviders.some((provider) => !activationProviderSet.has(provider))) {
    throw new Error('PRODUCTION_ACCOUNT_READONLY_TARGET_PROVIDERS must be a unique toss,kiwoom,upbit,bitget subset');
  }
}

const UPBIT_OPTIONAL_ORDER_READ_SCOPE_ERROR = 'UPBIT_OPEN_ORDERS_UPBIT_PERMISSION_DENIED';

function providerReadErrorAccepted(provider: Provider, errorCode: string | null) {
  return errorCode === null
    || (provider === 'upbit' && errorCode === UPBIT_OPTIONAL_ORDER_READ_SCOPE_ERROR);
}

type SafetySnapshot = {
  provider: string;
  readOnly: boolean;
  connected: boolean;
  status: string;
  checkedAt: string;
  lastGoodAt: string | null;
  stale: boolean;
  errorCode: string | null;
  openOrders: unknown[] | null;
  positions: Array<{
    symbol: string;
    quantity: number | null;
    currentPrice: number | null;
    leverage: number | null;
    liquidationPrice: number | null;
    marginMode: string | null;
    side: string | null;
  }> | null;
  positionMode?: 'one_way_mode' | 'hedge_mode' | null;
  orderRequests: number;
  cancelRequests: number;
  amendRequests: number;
  transferRequests: number;
  withdrawalRequests: number;
  credentialsReturned: boolean;
  liveTradingEnabled: boolean;
  autoTradingEnabled: boolean;
};

type LocalOrderSnapshot = {
  ok?: boolean;
  dashboardItems?: Array<{
    accountMode?: string | null;
    state?: string;
    clientOrderId?: string | null;
    exchangeOrderId?: string | null;
    updatedAt?: string;
  }>;
  orderSubmitted?: boolean;
  orderCanceled?: boolean;
  orderAmended?: boolean;
  privateTradingRequestSent?: boolean;
};

type ApprovalQueueSnapshot = {
  ok?: boolean;
  items?: Array<{
    accountMode?: string;
    state?: string;
    approvalExpiresAt?: string | null;
    approval?: { approvalEnabled?: boolean; expiresAt?: string | null };
  }>;
  orderSubmitted?: boolean;
  orderCanceled?: boolean;
  privateTradingRequestSent?: boolean;
};

const ACTIVE_ORDER_STATES = new Set(['SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED', 'RECOVERY_REQUIRED']);
const STALE_ACTIVE_ORDER_MS = 15 * 60_000;
const MIN_LIQUIDATION_DISTANCE_PERCENT = 5;

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

function zeroMutationSafetyFailures(value: SafetySnapshot): string[] {
  const failures: string[] = [];
  if (value.readOnly !== true) failures.push('readOnly!=true');
  if (value.orderRequests !== 0) failures.push(`orderRequests=${value.orderRequests}`);
  if (value.cancelRequests !== 0) failures.push(`cancelRequests=${value.cancelRequests}`);
  if (value.amendRequests !== 0) failures.push(`amendRequests=${value.amendRequests}`);
  if (value.transferRequests !== 0) failures.push(`transferRequests=${value.transferRequests}`);
  if (value.withdrawalRequests !== 0) failures.push(`withdrawalRequests=${value.withdrawalRequests}`);
  if (value.credentialsReturned !== false) failures.push('credentialsReturned!=false');
  if (value.liveTradingEnabled !== false) failures.push('liveTradingEnabled!=false');
  if (value.autoTradingEnabled !== false) failures.push('autoTradingEnabled!=false');
  return failures;
}

async function login(page: Page) {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
}

test('Production real-account read-only providers return fresh connected snapshots with zero mutation authority', async ({ page }) => {
  const blocked: Array<{ method: string; path: string; reason: string }> = [];
  const observedAppMutations: Array<{ method: string; path: string }> = [];
  const snapshots = new Map<Provider, SafetySnapshot>();
  const bitgetDiagnostics = new Map<Provider, SanitizedBitgetReadonlyDiagnostic>();
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
    if (match[1] === 'bitget') {
      const diagnostic = parseBitgetReadonlyDiagnosticHeader(
        response.headers()['x-account-readonly-bitget-diagnostic'],
      );
      if (diagnostic) bitgetDiagnostics.set('bitget', diagnostic);
    }
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

  if (testedProviders.length > 0) {
    for (const provider of testedProviders) {
      expect(supported.has(provider), `${provider} activation target must be supported in Production account read-only QA`).toBe(true);
    }
  } else {
    // The separate provider-activation recovery workflow overlays this spec without
    // an activation target. Preserve its legacy all-provider readiness assertions.
    for (const provider of cryptoProviders) {
      expect(supported.has(provider), `${provider} must be supported in Production account read-only QA`).toBe(true);
    }
    expect(
      stockProviders.some((provider) => supported.has(provider)),
      'Toss or Kiwoom stock account read-only provider must be supported',
    ).toBe(true);
  }

  const providers: Provider[] = [
    ...stockProviders.filter((provider) => supported.has(provider)),
    ...cryptoProviders,
  ];

  const requiredSnapshots: Provider[] = testedProviders.length > 0 ? testedProviders : providers;

  // AccountConnections performs its own read-only refresh on mount and may run
  // once more when Kiwoom support is resolved. Do not immediately add a third
  // provider fan-out from QA; that previously increased Toss rate-limit risk.
  // Reuse the real UI's initial snapshots when they arrive, and issue exactly
  // one bounded manual refresh only if a required provider is still missing.
  const requiredSnapshotsHealthy = () => requiredSnapshots.every((provider) => {
    const snapshot = snapshots.get(provider);
    return snapshot?.connected === true
      && snapshot.status === 'CONNECTED'
      && snapshot.stale === false
      && snapshot.errorCode === null
      && Array.isArray(snapshot.openOrders);
  });

  let initialSnapshotsHealthy = false;
  try {
    await expect.poll(
      requiredSnapshotsHealthy,
      { timeout: 20_000, intervals: [200, 500, 1_000, 2_000] },
    ).toBe(true);
    initialSnapshotsHealthy = true;
  } catch {
    initialSnapshotsHealthy = false;
  }

  if (!initialSnapshotsHealthy) {
    const refresh = page.getByRole('button', { name: '계좌 연결 새로고침' });
    await expect(refresh).toBeVisible({ timeout: 10_000 });
    await expect(refresh).toBeEnabled({ timeout: 15_000 });
    await refresh.click();
    await expect.poll(
      requiredSnapshotsHealthy,
      { timeout: 45_000, intervals: [500, 1_000, 2_000, 5_000] },
    ).toBe(true);
  }

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

  const runtimeState = await page.evaluate(async () => {
    const read = async (url: string) => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error(`READONLY_RUNTIME_STATE_HTTP_${response.status}`);
      return response.json() as Promise<unknown>;
    };
    const [orders, approvalQueue] = await Promise.all([
      read('/api/trade-automation/orders'),
      read('/api/trade-automation/approval-queue'),
    ]);
    return { orders, approvalQueue };
  }) as { orders: LocalOrderSnapshot; approvalQueue: ApprovalQueueSnapshot };

  expect(runtimeState.orders.ok).toBe(true);
  expect(runtimeState.orders.orderSubmitted).toBe(false);
  expect(runtimeState.orders.orderCanceled).toBe(false);
  expect(runtimeState.orders.orderAmended).toBe(false);
  expect(runtimeState.orders.privateTradingRequestSent).toBe(false);
  expect(runtimeState.approvalQueue.ok).toBe(true);
  expect(runtimeState.approvalQueue.orderSubmitted).toBe(false);
  expect(runtimeState.approvalQueue.orderCanceled).toBe(false);
  expect(runtimeState.approvalQueue.privateTradingRequestSent).toBe(false);

  const now = Date.now();
  const localOrders = Array.isArray(runtimeState.orders.dashboardItems)
    ? runtimeState.orders.dashboardItems.filter((order) => order.accountMode === 'live')
    : [];
  const activeLocalOrders = localOrders.filter((order) => ACTIVE_ORDER_STATES.has(String(order.state ?? '')));
  const localOrderIdentities = new Set(localOrders.flatMap((order) => [
    String(order.clientOrderId ?? '').trim(),
    String(order.exchangeOrderId ?? '').trim(),
  ]).filter(Boolean));
  const clientOrderIds = localOrders.map((order) => String(order.clientOrderId ?? '').trim()).filter(Boolean);
  const duplicateClientOrderIdCount = clientOrderIds.length - new Set(clientOrderIds).size;
  const staleLocalOrderCount = activeLocalOrders.filter((order) => {
    const updatedAt = Date.parse(String(order.updatedAt ?? ''));
    return !Number.isFinite(updatedAt) || now - updatedAt > STALE_ACTIVE_ORDER_MS;
  }).length;
  const approvalItems = Array.isArray(runtimeState.approvalQueue.items)
    ? runtimeState.approvalQueue.items
    : [];
  const stalePlanCount = approvalItems.filter((item) => {
    if (item.accountMode !== 'live') return false;
    if (String(item.state ?? '') !== 'APPROVAL_PENDING') return false;
    const expiresAt = Date.parse(String(item.approvalExpiresAt ?? item.approval?.expiresAt ?? ''));
    return item.approval?.approvalEnabled !== true || !Number.isFinite(expiresAt) || expiresAt <= now;
  }).length;

  const providerOpenOrders = providers.flatMap((provider) => {
    const openOrders = snapshots.get(provider)?.openOrders;
    return Array.isArray(openOrders) ? openOrders : [];
  });
  const orphanOrderCount = providerOpenOrders.filter((order) => {
    if (order === null || typeof order !== 'object') return true;
    const id = String((order as { id?: unknown }).id ?? '').trim();
    return !id || !localOrderIdentities.has(id);
  }).length;
  const bitgetSnapshot = snapshots.get('bitget');
  const bitgetPositions = Array.isArray(bitgetSnapshot?.positions)
    ? bitgetSnapshot.positions.filter((position) => Math.abs(Number(position.quantity ?? 0)) > 0)
    : [];
  const sidesBySymbol = new Map<string, Set<string>>();
  for (const position of bitgetPositions) {
    const symbol = String(position.symbol ?? '').trim().toUpperCase();
    const side = String(position.side ?? '').trim().toLowerCase();
    const sides = sidesBySymbol.get(symbol) ?? new Set<string>();
    if (side) sides.add(side);
    sidesBySymbol.set(symbol, sides);
  }
  const oppositePositionDuplicateCount = [...sidesBySymbol.values()]
    .filter((sides) => sides.has('long') && sides.has('short')).length;
  const nonIsolatedPositionCount = bitgetPositions
    .filter((position) => String(position.marginMode ?? '').trim().toLowerCase() !== 'isolated').length;
  const outOfPolicyLeveragePositionCount = bitgetPositions.filter((position) => {
    const leverage = Number(position.leverage);
    return !Number.isInteger(leverage) || leverage < 2 || leverage > 7;
  }).length;
  const liquidationRiskPositionCount = bitgetPositions.filter((position) => {
    const currentPrice = Number(position.currentPrice);
    const liquidationPrice = Number(position.liquidationPrice);
    if (!(currentPrice > 0) || !(liquidationPrice > 0)) return true;
    return Math.abs(currentPrice - liquidationPrice) / currentPrice * 100 <= MIN_LIQUIDATION_DISTANCE_PERCENT;
  }).length;
  const safetyCounters = {
    openOrderCount: providerOpenOrders.length,
    orphanOrderCount,
    activeLocalOrderCount: activeLocalOrders.length,
    staleLocalOrderCount,
    duplicateClientOrderIdCount,
    stalePlanCount,
    bitgetActivePositionCount: bitgetPositions.length,
    oppositePositionDuplicateCount,
    nonIsolatedPositionCount,
    outOfPolicyLeveragePositionCount,
    liquidationRiskPositionCount,
  };

  const sanitizedProviders = providers.map((provider) => {
    const snapshot = snapshots.get(provider);
    const checkedAtPresent = typeof snapshot?.checkedAt === 'string' && Number.isFinite(Date.parse(snapshot.checkedAt));
    const lastGoodAtPresent = typeof snapshot?.lastGoodAt === 'string'
      && Number.isFinite(Date.parse(snapshot.lastGoodAt));
    const fresh = snapshot?.stale === false && checkedAtPresent && lastGoodAtPresent;
    const reconciliationPassed = snapshot?.errorCode === null && Array.isArray(snapshot?.openOrders);
    return {
      provider,
      connected: snapshot?.connected === true,
      status: typeof snapshot?.status === 'string' ? snapshot.status : 'MISSING',
      stale: snapshot?.stale === true,
      errorCode: typeof snapshot?.errorCode === 'string' ? snapshot.errorCode : null,
      checkedAtPresent,
      lastGoodAtPresent,
      fresh,
      openOrderCount: Array.isArray(snapshot?.openOrders) ? snapshot.openOrders.length : -1,
      reconciliation: reconciliationPassed ? 'PASS' : 'FAIL',
      reconciliationPassed,
      diagnosticReadAccepted: snapshot !== undefined && providerReadErrorAccepted(
        provider,
        typeof snapshot.errorCode === 'string' ? snapshot.errorCode : null,
      ),
      ...(provider === 'bitget'
        ? { bitgetDiagnostic: bitgetDiagnostics.get('bitget') ?? null }
        : {}),
    };
  });

  // Persist bounded, sanitized provider state before any connectivity assertion so a
  // Production failure identifies the exact provider status/error without retaining
  // account values, credentials, traces, screenshots, or mutation payloads.
  writeEvidence({
    schemaVersion: 'production-account-readonly-live-qa-v3',
    targetSha: expectedDeploySha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    credentialVaultEncryptionConfigured: credentialStatus?.encryptionConfigured === true,
    testedProviders,
    providers: sanitizedProviders,
    safetyCounters,
    bitgetPositionMode: bitgetSnapshot?.positionMode ?? null,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    orderRequests: Number(credentialStatus?.orderRequests ?? -1),
    cancelRequests: Number(credentialStatus?.cancelRequests ?? -1),
    amendRequests: Number(credentialStatus?.amendRequests ?? -1),
    transferRequests: Number(credentialStatus?.transferRequests ?? -1),
    withdrawalRequests: Number(credentialStatus?.withdrawalRequests ?? -1),
    realOrderSubmitted: false,
    blockedMutationRequests: blocked.length,
    observedAppMutationRequests: observedAppMutations.length,
    liveTradingAuthorityGranted: credentialStatus?.liveTradingEnabled === true,
    autoTradingAuthorityGranted: credentialStatus?.autoTradingEnabled === true,
  });

  const providerFailures: string[] = [];
  for (const provider of providers) {
    const snapshot = snapshots.get(provider);
    const isActivationTarget = testedProviders.includes(provider as ActivationProvider);
    const isLegacyRequiredCrypto = testedProviders.length === 0
      && cryptoProviders.includes(provider as typeof cryptoProviders[number]);
    if (!snapshot) {
      if (isActivationTarget || isLegacyRequiredCrypto || testedProviders.length === 0) {
        providerFailures.push(`${provider}: snapshot missing`);
      }
      continue;
    }
    if (snapshot.provider !== provider) {
      providerFailures.push(`${provider}: provider identity=${snapshot.provider}`);
    }
    for (const failure of zeroMutationSafetyFailures(snapshot)) {
      providerFailures.push(`${provider}: ${failure}`);
    }

    if (isActivationTarget || isLegacyRequiredCrypto || (testedProviders.length === 0 && snapshot.connected)) {
      if (snapshot.connected !== true) {
        providerFailures.push(
          `${provider}: not connected; status=${snapshot.status}; errorCode=${snapshot.errorCode ?? 'none'}`,
        );
      }
      if (snapshot.status !== 'CONNECTED') providerFailures.push(`${provider}: status=${snapshot.status}`);
      if (snapshot.stale !== false) providerFailures.push(`${provider}: stale=${snapshot.stale}`);
      if (isActivationTarget && snapshot.errorCode !== null) {
        providerFailures.push(`${provider}: reconciliation errorCode=${snapshot.errorCode}`);
      } else if (!isActivationTarget && !providerReadErrorAccepted(provider, snapshot.errorCode)) {
        providerFailures.push(`${provider}: unexpected errorCode=${snapshot.errorCode ?? 'none'}`);
      }
      if (!Number.isFinite(Date.parse(snapshot.checkedAt))) providerFailures.push(`${provider}: checkedAt invalid`);
      if (snapshot.lastGoodAt === null || !Number.isFinite(Date.parse(String(snapshot.lastGoodAt)))) {
        providerFailures.push(`${provider}: lastGoodAt invalid`);
      }
      if (isActivationTarget && !Array.isArray(snapshot.openOrders)) {
        providerFailures.push(`${provider}: reconciliation openOrders unavailable`);
      }
    }
  }

  const connectedStockProviders = stockProviders.filter((provider) => snapshots.get(provider)?.connected === true);
  if (testedProviders.length === 0 && connectedStockProviders.length < 1) {
    const stockState = stockProviders
      .map((provider) => {
        const snapshot = snapshots.get(provider);
        return `${provider}=${snapshot?.status ?? 'MISSING'}/${snapshot?.errorCode ?? 'none'}`;
      })
      .join(',');
    providerFailures.push(`stock-provider: no connected provider; ${stockState}`);
  }
  if (blocked.length > 0) providerFailures.push(`blocked mutation requests=${blocked.length}`);
  if (observedAppMutations.length > 0) providerFailures.push(`observed app mutations=${observedAppMutations.length}`);
  for (const [name, value] of Object.entries(safetyCounters)) {
    if (name === 'bitgetActivePositionCount') continue;
    if (value !== 0) providerFailures.push(`${name}=${value}`);
  }
  if (bitgetSnapshot?.positionMode !== 'one_way_mode') {
    providerFailures.push(`bitget positionMode=${bitgetSnapshot?.positionMode ?? 'unknown'}`);
  }

  expect(
    providerFailures,
    testedProviders.length > 0
      ? `Production account read-only QA blockers (activation targets: ${testedProviders.join(',')})`
      : 'Production account read-only QA blockers (legacy provider activation recovery)',
  ).toEqual([]);

});
