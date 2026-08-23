import type { Page, Request, Route } from '@playwright/test';

export type ProductionRequestDecision =
  | { action: 'allow' }
  | { action: 'mock-private-account'; reason: 'PRIVATE_ACCOUNT_LIVE_QA_NOT_RUN' }
  | { action: 'block'; reason: string };

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PRIVATE_PROVIDER_HOSTS = new Set([
  'api.upbit.com',
  'api.bitget.com',
  'mockapi.kiwoom.com',
]);
const PRIVATE_APP_PATHS = [
  '/api/account-connections/snapshot',
  '/api/kiwoom/token-test',
  '/api/kiwoom/test',
];
const FINANCIAL_MUTATION_PATTERN = /(?:^|\/)(?:order|orders|cancel|amend|transfer|withdraw|withdrawal|trade|trading|trade-automation)(?:\/|$)/i;

export function classifyProductionRequest(
  rawUrl: string,
  method: string,
  productionOrigin: string,
): ProductionRequestDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: 'block', reason: 'MALFORMED_REQUEST_URL' };
  }

  const normalizedMethod = method.toUpperCase();
  if (PRIVATE_PROVIDER_HOSTS.has(url.hostname)) {
    return { action: 'block', reason: 'PRIVATE_PROVIDER_NETWORK_BLOCKED' };
  }

  if (url.origin === productionOrigin) {
    if (url.pathname === '/api/account-connections/status' && READ_METHODS.has(normalizedMethod)) {
      return { action: 'allow' };
    }
    if (PRIVATE_APP_PATHS.includes(url.pathname)) {
      return url.pathname === '/api/account-connections/snapshot' && READ_METHODS.has(normalizedMethod)
        ? { action: 'mock-private-account', reason: 'PRIVATE_ACCOUNT_LIVE_QA_NOT_RUN' }
        : { action: 'block', reason: 'PRIVATE_ACCOUNT_REQUEST_BLOCKED' };
    }
    if (url.pathname.startsWith('/api/') && !READ_METHODS.has(normalizedMethod)) {
      return {
        action: 'block',
        reason: FINANCIAL_MUTATION_PATTERN.test(url.pathname)
          ? 'FINANCIAL_MUTATION_REQUEST_BLOCKED'
          : 'PRODUCTION_APP_MUTATION_BLOCKED',
      };
    }
  }

  if (url.hostname.endsWith('.supabase.co')) {
    if (url.pathname.startsWith('/rest/v1/') && !READ_METHODS.has(normalizedMethod)) {
      return { action: 'block', reason: 'PRODUCTION_DATABASE_MUTATION_BLOCKED' };
    }
    if (url.pathname.startsWith('/storage/v1/') && !READ_METHODS.has(normalizedMethod)) {
      return { action: 'block', reason: 'PRODUCTION_STORAGE_MUTATION_BLOCKED' };
    }
  }

  return { action: 'allow' };
}

export function isIgnorableProductionRequestFailure(
  rawUrl: string,
  method: string,
  errorText: string,
  productionOrigin: string,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  const normalizedMethod = method.toUpperCase();
  return url.origin === productionOrigin
    && (normalizedMethod === 'GET' || normalizedMethod === 'HEAD')
    && errorText.trim() === 'net::ERR_ABORTED';
}

export function privateAccountDisconnectedFixture() {
  const provider = (name: string, code: string) => ({
    provider: name,
    configured: false,
    connected: false,
    readOnly: true,
    credentialSource: 'none',
    vaultError: null,
    error: code,
  });
  return {
    ok: true,
    readOnly: true,
    mutationsAllowed: false,
    credentialsReturned: false,
    providers: {
      kiwoom: provider('kiwoom', 'KIWOOM_NOT_CONFIGURED'),
      upbit: provider('upbit', 'UPBIT_NOT_CONFIGURED'),
      bitget: provider('bitget', 'BITGET_NOT_CONFIGURED'),
    },
    checkedAt: '1970-01-01T00:00:00.000Z',
    privateAccountLiveQa: 'NOT_RUN',
  };
}

export async function installProductionReadOnlyPolicy(
  page: Page,
  productionOrigin: string,
  onBlocked: (request: Request, reason: string) => void,
): Promise<void> {
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const decision = classifyProductionRequest(request.url(), request.method(), productionOrigin);
    if (decision.action === 'allow') {
      await route.continue();
      return;
    }
    if (decision.action === 'mock-private-account') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(privateAccountDisconnectedFixture()),
      });
      return;
    }

    onBlocked(request, decision.reason);
    await route.abort('blockedbyclient');
    throw new Error(`${decision.reason}: ${request.method()} ${new URL(request.url()).pathname}`);
  });
}
