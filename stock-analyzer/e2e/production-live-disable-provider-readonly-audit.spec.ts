import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SAFE_DISABLE_PROVIDER_ORDER,
  providerDiagnostic,
  providerDiagnosticHealthy,
  providerDiagnosticRetryable,
  type ReadonlyProbeObservation,
  type ReadonlyProviderSnapshot,
  type SafeDisableProvider,
  type SanitizedProviderDiagnostic,
} from './support/production-live-disable-provider-audit';
import {
  loginProductionReadOnly,
  productionReadOnlyAccessToken,
} from './support/production-readonly-login';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/u, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const expectedDeploySha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const productionDeployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const artifactDir = path.resolve(
  process.cwd(),
  process.env.PRODUCTION_ACCOUNT_READONLY_ARTIFACT_DIR ?? 'production-live-disable-provider-artifacts',
);
const auditPhase = process.env.PRODUCTION_LIVE_DISABLE_AUDIT_PHASE === 'post'
  ? 'POST_DISABLE_SAFETY'
  : 'PRE_DISABLE_SAFETY';
const enabled = process.env.PRODUCTION_LIVE_DISABLE_READONLY_AUDIT === 'true';

test.skip(!enabled, 'Deterministic Production safe-disable provider audit runs only in its protected workflow.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA login credential is required');
  if (!/^[0-9a-f]{40}$/u.test(expectedDeploySha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (!Number.isSafeInteger(productionDeployRunId) || productionDeployRunId <= 0) {
    throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  }
}

type CredentialStatusPayload = {
  ok?: unknown;
  encryptionConfigured?: unknown;
  supportedProviders?: unknown;
  credentialsReturned?: unknown;
  privateProviderRequests?: unknown;
  orderRequests?: unknown;
  cancelRequests?: unknown;
  amendRequests?: unknown;
  transferRequests?: unknown;
  withdrawalRequests?: unknown;
  liveTradingEnabled?: unknown;
  autoTradingEnabled?: unknown;
};

type EndpointProbe = {
  responseReceived: boolean;
  httpStatus: number | null;
  payload: Record<string, unknown> | null;
  transportClassification: 'NONE' | 'NETWORK_TIMEOUT' | 'NETWORK_FAILURE' | 'INVALID_JSON';
};

const MAX_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 10_000;
const BACKOFF_MS = [750, 1_500] as const;

function writeEvidence(value: unknown) {
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(artifactDir, 'production-live-disable-provider-readonly-audit.json'),
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function readOnlyGet(page: Page, pathName: string, accessToken: string): Promise<EndpointProbe> {
  return page.evaluate(async ({ url, token, timeoutMs }) => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      });
      try {
        const payload = await response.json() as Record<string, unknown>;
        return {
          responseReceived: true,
          httpStatus: response.status,
          payload,
          transportClassification: 'NONE' as const,
        };
      } catch {
        return {
          responseReceived: true,
          httpStatus: response.status,
          payload: null,
          transportClassification: 'INVALID_JSON' as const,
        };
      }
    } catch (error) {
      return {
        responseReceived: false,
        httpStatus: null,
        payload: null,
        transportClassification: error instanceof DOMException && error.name === 'AbortError'
          ? 'NETWORK_TIMEOUT' as const
          : 'NETWORK_FAILURE' as const,
      };
    } finally {
      window.clearTimeout(timer);
    }
  }, {
    url: new URL(pathName, baseUrl).toString(),
    token: accessToken,
    timeoutMs: ATTEMPT_TIMEOUT_MS,
  });
}

function credentialClassification(probe: EndpointProbe) {
  if (!probe.responseReceived) return probe.transportClassification;
  if (probe.httpStatus === 401) return 'AUTHENTICATION_REJECTED';
  if (probe.httpStatus === 403) return 'PERMISSION_REJECTED';
  if (probe.httpStatus === 429) return 'RATE_LIMITED';
  if (probe.httpStatus !== 200) return probe.httpStatus != null && probe.httpStatus >= 500
    ? 'PROVIDER_OR_NETWORK_UNAVAILABLE'
    : 'HTTP_ERROR';
  if (probe.transportClassification === 'INVALID_JSON' || !probe.payload) return 'INVALID_JSON';
  const value = probe.payload as CredentialStatusPayload;
  if (value.ok !== true) return 'STATUS_NOT_OK';
  if (value.encryptionConfigured !== true) return 'ENCRYPTION_NOT_CONFIGURED';
  if (value.credentialsReturned !== false) return 'CREDENTIAL_EXPOSURE_CONTRACT_FAILED';
  if (value.liveTradingEnabled !== false || value.autoTradingEnabled !== false) return 'QA_AUTHORITY_NOT_FALSE';
  if ([
    value.privateProviderRequests,
    value.orderRequests,
    value.cancelRequests,
    value.amendRequests,
    value.transferRequests,
    value.withdrawalRequests,
  ].some((counter) => counter !== 0)) return 'MUTATION_COUNTER_NONZERO';
  const supported = Array.isArray(value.supportedProviders)
    ? new Set(value.supportedProviders.map((provider) => String(provider).toLowerCase()))
    : new Set<string>();
  if (SAFE_DISABLE_PROVIDER_ORDER.some((provider) => !supported.has(provider))) return 'REQUIRED_PROVIDER_UNSUPPORTED';
  return 'PASS';
}

function retryableClassification(classification: string) {
  return [
    'NETWORK_TIMEOUT',
    'NETWORK_FAILURE',
    'RATE_LIMITED',
    'PROVIDER_OR_NETWORK_UNAVAILABLE',
  ].includes(classification);
}

async function probeCredentialStatus(page: Page, token: string) {
  let probe: EndpointProbe = {
    responseReceived: false,
    httpStatus: null,
    payload: null,
    transportClassification: 'NETWORK_FAILURE',
  };
  let classification = 'NETWORK_FAILURE';
  let attemptCount = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    attemptCount = attempt + 1;
    probe = await readOnlyGet(page, '/api/accounts/read-only/credentials/status', token);
    classification = credentialClassification(probe);
    if (classification === 'PASS' || !retryableClassification(classification)) break;
    if (attempt < BACKOFF_MS.length) await page.waitForTimeout(BACKOFF_MS[attempt]);
  }
  return { probe, classification, attemptCount };
}

async function probeProvider(page: Page, token: string, provider: SafeDisableProvider) {
  let observation: ReadonlyProbeObservation = {
    responseReceived: false,
    httpStatus: null,
    payload: null,
    transportClassification: 'NETWORK_FAILURE',
  };
  let diagnostic = providerDiagnostic(provider, observation);
  let attemptCount = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    attemptCount = attempt + 1;
    const probe = await readOnlyGet(page, `/api/accounts/read-only/${provider}`, token);
    observation = {
      ...probe,
      payload: probe.payload as ReadonlyProviderSnapshot | null,
    };
    diagnostic = providerDiagnostic(provider, observation);
    if (providerDiagnosticHealthy(diagnostic) || !providerDiagnosticRetryable(diagnostic)) break;
    if (attempt < BACKOFF_MS.length) await page.waitForTimeout(BACKOFF_MS[attempt]);
  }
  return { observation, diagnostic, attemptCount };
}

function knownZeroCounter(values: unknown[]) {
  return values.every((value) => value === 0) ? 0 : null;
}

test('safe-disable provider audit is deterministic, sequential, sanitized, and zero-mutation', async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const blocked: Array<{ method: string; path: string; reason: string }> = [];
  const observedAppMutations: Array<{ method: string; path: string }> = [];
  const origin = new URL(baseUrl).origin;

  await installProductionReadOnlyPolicy(page, origin, (request, reason) => {
    blocked.push({ method: request.method(), path: new URL(request.url()).pathname, reason });
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/')
      && !['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase())) {
      observedAppMutations.push({ method: request.method(), path: url.pathname });
    }
  });

  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
  const accessToken = await productionReadOnlyAccessToken(page);
  expect(accessToken, 'Authenticated Production access token must remain in memory only').not.toBeNull();

  const credential = await probeCredentialStatus(page, accessToken!);
  const providerResults: Array<{
    provider: SafeDisableProvider;
    observation: ReadonlyProbeObservation;
    diagnostic: SanitizedProviderDiagnostic;
    attemptCount: number;
  }> = [];

  if (credential.classification === 'PASS') {
    for (const provider of SAFE_DISABLE_PROVIDER_ORDER) {
      const result = await probeProvider(page, accessToken!, provider);
      providerResults.push({ provider, ...result });
    }
  }

  const incompleteProviders = credential.classification === 'PASS'
    ? providerResults
      .filter(({ diagnostic }) => !providerDiagnosticHealthy(diagnostic))
      .map(({ provider }) => provider)
    : ['credential-status'];
  const snapshots = providerResults.map(({ observation }) => observation.payload);
  const credentialPayload = credential.probe.payload as CredentialStatusPayload | null;
  const counterSources = [credentialPayload, ...snapshots];
  const orderRequests = knownZeroCounter(counterSources.map((value) => value?.orderRequests));
  const cancelRequests = knownZeroCounter(counterSources.map((value) => value?.cancelRequests));
  const amendRequests = knownZeroCounter(counterSources.map((value) => value?.amendRequests));
  const transferRequests = knownZeroCounter(counterSources.map((value) => value?.transferRequests));
  const withdrawalRequests = knownZeroCounter(counterSources.map((value) => value?.withdrawalRequests));
  const openOrderCount = snapshots.reduce((count, snapshot) => (
    count + (Array.isArray(snapshot?.openOrders) ? snapshot.openOrders.length : 0)
  ), 0);
  const sanitizedBlockers = providerResults.flatMap(({ provider, observation }) => {
    const openOrders = observation.payload?.openOrders;
    if (!Array.isArray(openOrders)) return [];
    return openOrders.map(() => ({
      provider,
      symbol: 'REDACTED',
      state: 'OPEN_ORDER',
    }));
  }).slice(0, 50).map((item) => ({
    provider: item.provider,
    symbol: item.symbol,
    state: /^[A-Z0-9_/-]{1,64}$/u.test(item.state) ? item.state : 'OPEN_ORDER',
  }));
  const zeroMutationKnown = [orderRequests, cancelRequests, amendRequests, transferRequests, withdrawalRequests]
    .every((value) => value === 0)
    && blocked.length === 0
    && observedAppMutations.length === 0;
  const authorityFalse = credentialPayload?.liveTradingEnabled === false
    && credentialPayload?.autoTradingEnabled === false
    && snapshots.every((snapshot) => snapshot?.liveTradingEnabled === false && snapshot?.autoTradingEnabled === false);
  const credentialsRedacted = credentialPayload?.credentialsReturned === false
    && snapshots.every((snapshot) => snapshot?.credentialsReturned === false);
  if ((!zeroMutationKnown || !authorityFalse || !credentialsRedacted) && incompleteProviders.length === 0) {
    incompleteProviders.push('safety-contract');
  }

  const status = incompleteProviders.length > 0
    ? `BLOCKED_PROVIDER_READONLY_AUDIT_INCOMPLETE:${incompleteProviders.join(',')}`
    : openOrderCount > 0
      ? 'BLOCKED_LIVE_STATE_NOT_TERMINAL'
      : 'PASS';
  const evidence = {
    schemaVersion: 'production-live-disable-provider-readonly-audit-v2',
    auditPurpose: auditPhase,
    status,
    targetSha: expectedDeploySha,
    productionDeployRunId,
    generatedAt: new Date().toISOString(),
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    readOnlyEnforced: true,
    providerSequence: SAFE_DISABLE_PROVIDER_ORDER,
    credentialStatus: {
      responseReceived: credential.probe.responseReceived,
      httpStatus: credential.probe.httpStatus,
      ok: credentialPayload?.ok === true,
      encryptionConfigured: credentialPayload?.encryptionConfigured === true,
      allProvidersSupported: credential.classification !== 'REQUIRED_PROVIDER_UNSUPPORTED',
      credentialsReturned: credentialPayload?.credentialsReturned === false ? false : null,
      diagnosticClassification: credential.classification,
      attemptCount: credential.attemptCount,
    },
    providers: providerResults.map(({ diagnostic, attemptCount }) => ({ ...diagnostic, attemptCount })),
    safetyCounters: {
      openOrderCount,
      orphanOrderCount: openOrderCount === 0 ? 0 : null,
    },
    sanitizedBlockers,
    ordersMutationRequests: orderRequests,
    cancelRequests,
    amendRequests,
    transferRequests,
    withdrawalRequests,
    blockedMutationRequests: blocked.length,
    observedAppMutationRequests: observedAppMutations.length,
    realOrderSubmitted: false,
    credentialsReturned: credentialsRedacted ? false : null,
    rawSecretsReturned: false,
    rawAccountValuesReturned: false,
    liveTradingAuthorityGranted: credentialPayload?.liveTradingEnabled === true,
    autoTradingAuthorityGranted: credentialPayload?.autoTradingEnabled === true,
  };
  writeEvidence(evidence);

  if (status !== 'PASS') {
    console.error(`SAFE_DISABLE_PROVIDER_DIAGNOSTICS=${JSON.stringify(evidence.providers)}`);
    throw new Error(status);
  }
});
