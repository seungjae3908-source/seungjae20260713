import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loginProductionReadOnly } from './support/production-readonly-login';
import { requestWithBrowserSession } from './support/browser-session-api';

const enabled = process.env.STAGING_TRADING_CORE_QA === 'true';
const baseURL = String(process.env.STAGING_BASE_URL ?? '').trim();
const origin = enabled ? new URL(baseURL) : new URL('https://staging.example.invalid');
const targetSha = String(process.env.STAGING_TARGET_SHA ?? '').trim();
const adminLogin = String(process.env.STAGING_ADMIN_EMAIL ?? '');
const adminPassword = String(process.env.STAGING_ADMIN_PASSWORD ?? '');
const artifactDir = path.resolve(process.env.STAGING_TRADING_CORE_ARTIFACT_DIR ?? 'staging-trading-core-artifacts');
const MARKETS = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
const PROVIDERS = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;

test.skip(!enabled, 'Protected Staging Trading Core GET-only QA only');

type RecordValue = Record<string, unknown>;

function verifyEnv() {
  if (!/^[0-9a-f]{40}$/.test(targetSha)) throw new Error('STAGING_CORE_SHA_REQUIRED');
  if (!adminLogin || !adminPassword) throw new Error('STAGING_CORE_ADMIN_AUTH_REQUIRED');
  if (origin.protocol !== 'https:' || origin.hostname === 'lsj119.com'
    || origin.hostname === 'lsj119.duckdns.org') throw new Error('STAGING_CORE_PRODUCTION_ORIGIN_FORBIDDEN');
}

async function getAdminApi(page: Page, pathName: string): Promise<RecordValue> {
  const allow = [
    '/api/trade-automation/status',
    '/api/trade-automation/paper-runtime-readiness',
    '/api/paper-journal/admin-four-market/status',
    '/api/paper-journal/unified-ledger?range=30D&source=APP_PAPER',
    '/api/user-integrations',
  ];
  if (!allow.includes(pathName)) throw new Error('STAGING_CORE_ROUTE_NOT_ALLOWLISTED');
  const response = await requestWithBrowserSession(page, pathName);
  if (response.status() !== 200) throw new Error('STAGING_CORE_API_HTTP_' + response.status() + ':' + pathName.split('?')[0]);
  const raw: unknown = await response.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || (raw as RecordValue).ok !== true) throw new Error('STAGING_CORE_API_UNAVAILABLE:' + pathName.split('?')[0]);
  return raw as RecordValue;
}

function verifyPureRead(value: RecordValue, endpoint: string) {
  const required: Record<string, number | boolean> = {
    financialMutationCount: 0,
    privateProviderRequests: 0,
    orderSubmitted: false,
    exchangeRequestSent: false,
  };
  for (const [field, expected] of Object.entries(required)) {
    if (value[field] !== expected) throw new Error('STAGING_CORE_READ_AUTHORITY_VIOLATION:' + endpoint + ':' + field);
  }
}

function writeRedactedReceipt(info: TestInfo, blockerCodes: readonly string[]) {
  const viewport = info.project.name.endsWith('mobile') ? 'mobile' : 'desktop';
  const blockers = [...new Set(blockerCodes.filter(value => /^[A-Z][A-Z0-9_]{1,110}$/.test(value)))].slice(0, 40);
  const receipt = {
    schemaVersion: 1, scope: 'TRADING_CORE_ONLY', viewport, targetSha,
    observedAt: new Date().toISOString(), dataSource: 'AUTHENTICATED_STAGING_GET_ONLY',
    markets: [...MARKETS], providers: [...PROVIDERS], blockers,
    readOnly: true, productionDeployApproved: false, activationVerified: false,
    naturalPaperFillJournalTelegramSentVerified: false,
    fullStagingReleaseReady: 'NOT_EVALUATED',
    realOrders: 0, paperOrdersCreated: 0, telegramSends: 0,
    unsafeMutations: 0, consoleErrors: 0, pageErrors: 0, unexpectedHttpErrors: 0,
    secretsRecorded: false,
  };
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(artifactDir, 'staging-core-' + viewport + '.json'),
    JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}

test('Staging: administrator automatic/Paper and Telegram/Journal read-only journeys', async ({ page }, testInfo) => {
  verifyEnv();
  const mutations: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const httpErrors: string[] = [];

  // Auth token exchange is the sole allowed POST. Reject any app or
  // Supabase data/edge-function writes before they hit a server.
  await page.route('**/*', async route => {
    const request: Request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const protectedMutation = method !== 'GET' && method !== 'HEAD'
      && (url.pathname.startsWith('/api/')
        || url.pathname.startsWith('/rest/v1/')
        || url.pathname.startsWith('/functions/v1/')
        || (url.pathname.startsWith('/auth/v1/') && !url.pathname.startsWith('/auth/v1/token')));
    if (protectedMutation) {
      mutations.push(url.pathname.slice(0, 100));
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push('browser-console-error');
  });
  page.on('pageerror', () => pageErrors.push('unhandled-browser-error'));
  page.on('response', response => {
    try {
      const url = new URL(response.url());
      if (url.origin === origin.origin && url.pathname.startsWith('/api/')
        && response.status() >= 400) httpErrors.push(url.pathname.slice(0, 100));
    } catch {
      httpErrors.push('invalid-response-url');
    }
  });

  const health = await page.request.get('/api/health', { headers: { 'Cache-Control': 'no-cache' } });
  expect(health.status()).toBe(200);
  const current = await health.json() as { ok?: boolean; deploySha?: string };
  expect(current.ok).toBe(true);
  expect(current.deploySha).toBe(targetSha);
  await loginProductionReadOnly(page, { login: adminLogin, password: adminPassword });

  const auto = await getAdminApi(page, '/api/trade-automation/status');
  expect(auto.actualOrderSubmittedByStatusRequest).toBe(false);
  expect(Array.isArray(auto.connections)).toBe(true);
  const policy = auto.policy as RecordValue | undefined;
  expect(policy && typeof policy === 'object').toBeTruthy();
  const enabledMarkets = policy?.marketEnabled as RecordValue | undefined;
  for (const market of MARKETS) expect(typeof enabledMarkets?.[market], market).toBe('boolean');
  const liveAutomatic = auto.liveAutomaticExecutionServerEnabled as RecordValue | undefined;
  expect(liveAutomatic && typeof liveAutomatic === 'object').toBeTruthy();
  for (const provider of PROVIDERS) {
    expect(liveAutomatic?.[provider], provider + ' live automatic gate MUST stay OFF').toBe(false);
  }

  const readiness = await getAdminApi(page, '/api/trade-automation/paper-runtime-readiness');
  expect(readiness.readOnlyProbe).toBe(true);
  expect(readiness.memberScope).toBe('SELF');
  expect(readiness.realOrderAuthorityGranted).toBe(false);
  verifyPureRead(readiness, 'paper-runtime');
  expect(typeof readiness.readyForPaperEvaluation).toBe('boolean');
  expect(Array.isArray(readiness.blockers)).toBe(true);
  expect(readiness.readyForPaperEvaluation).toBe((readiness.blockers as unknown[]).length === 0);

  const wallet = await getAdminApi(page, '/api/paper-journal/admin-four-market/status');
  verifyPureRead(wallet, 'admin-four-market');
  expect(wallet.readOnlyProbe).toBe(true);
  expect(wallet.ownerScope).toBe('SELF');
  expect(wallet.administratorOnly).toBe(true);
  expect(wallet.initialCapitalKrw).toBe(4_000_000);
  expect(typeof wallet.ready).toBe('boolean');
  const byMarket = wallet.marketWallets as RecordValue | undefined;
  for (const market of MARKETS) {
    const account = byMarket?.[market] as RecordValue | undefined;
    expect(typeof account?.ready, market + ' wallet present').toBe('boolean');
    if (account?.ready === true) expect(account.initialCapitalKrw).toBe(1_000_000);
  }

  const journal = await getAdminApi(page, '/api/paper-journal/unified-ledger?range=30D&source=APP_PAPER');
  expect(journal.ok).toBe(true);
  const telegram = await getAdminApi(page, '/api/user-integrations');
  expect(telegram.ok).toBe(true);

  await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('auto-trading-page')).toBeVisible();
  await expect(page.getByTestId('trading-market-tabs')).toBeVisible();
  await page.getByTestId('trading-section-settings').click();
  await expect(page.getByTestId('auto-trading-settings-column')).toBeVisible();
  await page.goto('/paper-trading', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('paper-trading-shell')).toBeVisible();
  await page.getByTestId('trading-section-journal').click();
  await expect(page.getByTestId('trading-workspace-journal')).toBeVisible();

  expect(mutations, 'All app/Provider data writes forbidden').toEqual([]);
  expect(consoleErrors, 'Unexpected console error count').toEqual([]);
  expect(pageErrors, 'Unhandled browser error count').toEqual([]);
  expect(httpErrors, 'Unexpected same-origin HTTP error count').toEqual([]);

  const codes = [
    ...(Array.isArray(readiness.blockers) ? readiness.blockers : []),
    ...(Array.isArray(wallet.creationBlockers) ? wallet.creationBlockers : []),
  ].filter((value): value is string => typeof value === 'string');
  writeRedactedReceipt(testInfo, codes);
});
