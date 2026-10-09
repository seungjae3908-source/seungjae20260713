import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { requestWithBrowserSession } from './support/browser-session-api';

const activated = process.env.STAGING_TRADING_CORE_ONLY_QA === 'true';
test.skip(!activated, 'Runs only in explicitly dispatched, protected Trading Core Staging QA.');

const MARKETS = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
const PROVIDERS = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
const outputDir = path.resolve('staging-trading-core-artifacts');

function required(name: string) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error('STAGING_TRADING_CORE_REQUIRED_CONFIGURATION:' + name);
  return value;
}
// Isolated Staging admin may have no login_name in Auth metadata.
// Use the actual Staging password-grant session without inventing a username.
// This verifies browser session restoration, NOT the interactive login form.
async function restoreStagingAdminSession(page: Page) {
  const email = required('STAGING_ADMIN_EMAIL').toLowerCase();
  const supabase = new URL(required('STAGING_SUPABASE_URL'));
  const response = await fetch(new URL('/auth/v1/token?grant_type=password', supabase), {
    method: 'POST',
    headers: {
      apikey: required('STAGING_SUPABASE_ANON_KEY'),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email, password: required('STAGING_ADMIN_PASSWORD') }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('STAGING_ADMIN_PASSWORD_GRANT_HTTP_' + response.status);
  const body: any = await response.json().catch(() => null);
  if (typeof body?.access_token !== 'string' || body.access_token.length < 20
    || typeof body?.refresh_token !== 'string' || body.refresh_token.length < 10
    || !Number.isSafeInteger(body?.expires_in) || body.expires_in < 60
    || typeof body?.user?.id !== 'string'
    || String(body?.user?.email ?? '').toLowerCase() !== email) {
    throw new Error('STAGING_ADMIN_SESSION_CONTRACT_INVALID');
  }
  const origin = new URL(required('STAGING_BASE_URL')).origin;
  const profileResponse = await page.request.get(new URL('/api/auth/profile', origin).toString(), {
    headers: { Authorization: 'Bearer ' + body.access_token },
  });
  if (profileResponse.status() !== 200) {
    throw new Error('STAGING_ADMIN_PROFILE_HTTP_' + profileResponse.status());
  }
  const profile: any = await profileResponse.json().catch(() => null);
  if (profile?.id !== body.user.id) throw new Error('STAGING_ADMIN_PROFILE_IDENTITY_MISMATCH');
  if (profile?.role !== 'admin' || profile?.status !== 'approved'
    || profile?.is_active === false) {
    throw new Error('STAGING_ADMIN_PROFILE_NOT_APPROVED');
  }
  const session = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: 'bearer',
    expires_in: body.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + body.expires_in,
    user: body.user,
  };
  const storageKey = 'sb-' + supabase.hostname.split('.')[0] + '-auth-token';
  // The session stays only in Playwright's isolated browser context.
  // No credential, identity, storageState, trace, screenshot or video artifact.
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ origin, storageKey, session }) => {
    if (window.location.origin !== origin) throw new Error('STAGING_AUTH_STORAGE_ORIGIN_MISMATCH');
    window.localStorage.setItem(storageKey, JSON.stringify(session));
  }, { origin, storageKey, session });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /로그아웃|sign out/i }).first())
    .toBeVisible({ timeout: 30_000 });
}
function validateIsolation() {
  const target = required('STAGING_TARGET_SHA').toLowerCase();
  expect(target).toMatch(/^[0-9a-f]{40}$/);
  const base = new URL(required('STAGING_BASE_URL'));
  expect(base.protocol).toBe('https:');
  expect(base.hostname).not.toBe('lsj119.com');
  expect(base.hostname).not.toMatch(/\.supabase\.co$/);
  const supabase = new URL(required('STAGING_SUPABASE_URL'));
  expect(supabase.protocol).toBe('https:');
  expect(supabase.hostname).toMatch(/^[a-z0-9]+\.supabase\.co$/);
  expect(supabase.hostname).not.toBe('bawcbkoyovbeajkrnduq.supabase.co');
  return target;
}
function failCodeOnly(code: unknown) {
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,90}$/.test(code) ? code : 'UNCLASSIFIED';
}
async function readOwned(page: Page, endpoint: string) {
  const response = await requestWithBrowserSession(page, endpoint);
  expect(response.status(), 'Read-only scoped Trading Core API must be available: ' + endpoint)
    .toBe(200);
  const value: any = await response.json().catch(() => null);
  expect(value?.ok, 'Scoped Trading Core API returned no successful canonical contract: ' + endpoint)
    .toBe(true);
  return value;
}
function assertReadonly(value: any, endpoint: string) {
  expect(value.readOnlyProbe, endpoint).toBe(true);
  expect(value.financialMutationCount, endpoint).toBe(0);
  expect(value.privateProviderRequests, endpoint).toBe(0);
  expect(value.orderSubmitted, endpoint).toBe(false);
  expect(value.exchangeRequestSent, endpoint).toBe(false);
  // Paper readiness reports a dedicated realOrderAuthorityGranted=false contract.
  // The wallet readback uses liveTradingAuthorityGranted=false instead.
  expect(value.realOrderAuthorityGranted === false || value.liveTradingAuthorityGranted === false, endpoint).toBe(true);
}

test('Trading Core scoped Staging: immutable SHA, 4-market wallet, Paper worker, Journal and Telegram readback only', async ({ page }, testInfo) => {
  const sha = validateIsolation();
  const base = new URL(required('STAGING_BASE_URL'));
  let forbiddenMutationRequests = 0;
  // App navigation must not submit even a simulated order, policy change,
  // Telegram message, wallet bootstrap, or private-provider request.
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      forbiddenMutationRequests += 1;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const anonymous = await page.request.get('/api/paper-journal/admin-four-market/status');
  expect([401, 403]).toContain(anonymous.status());
  const healthResponse = await page.request.get('/api/health');
  expect(healthResponse.status()).toBe(200);
  const health = await healthResponse.json();
  expect(health?.ok).toBe(true);
  expect(String(health.deploySha ?? '').toLowerCase()).toBe(sha);
  expect(String(health.deployMarkerSha ?? '').toLowerCase()).toBe(sha);
  expect(health.identityMatch).toBe(true);
  expect(health.backgroundWorkersEnabled).toBe(false);

  await restoreStagingAdminSession(page);
  await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).not.toBeEmpty();
  await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
  await expect(page.getByText(/자동매매|모의매매|자동 거래/i).first()).toBeVisible({ timeout: 20_000 });
  expect(forbiddenMutationRequests).toBe(0);
  const status = await readOwned(page, '/api/trade-automation/status');
  expect(status.policy?.marketEnabled).toBeTruthy();
  expect(Array.isArray(status.connections)).toBe(true);
  for (const market of MARKETS) {
    expect(typeof status.policy.marketEnabled[market]).toBe('boolean');
    expect(status.liveAutomaticReadinessByMarket?.[market]?.orderSubmissionPerformedByStatusRequest).toBe(false);
  }
  for (const provider of PROVIDERS) {
    expect(status.liveExecutionServerEnabled?.[provider]).toBe(false);
  }
  const paperRuntime = await readOwned(page, '/api/trade-automation/paper-runtime-readiness');
  assertReadonly(paperRuntime, 'paper-runtime-readiness');
  expect(Array.isArray(paperRuntime.blockers)).toBe(true);
  expect(paperRuntime.workerMode).toBeDefined();

  const wallets = await readOwned(page, '/api/paper-journal/admin-four-market/status');
  assertReadonly(wallets, 'admin-four-market');
  expect(wallets.initialCapitalKrw).toBe(4_000_000);
  expect(wallets.marketInitialCapitalKrw).toBe(1_000_000);
  expect(wallets.rlsGuardReady).toBe(true);
  expect(wallets.marketCapitalComputedFrom).toBe('CANONICAL_CURRENT_EPOCH_SETTLEMENT_ONLY');
  for (const market of MARKETS) {
    expect(wallets.marketWallets?.[market]?.initialCapitalKrw).toBe(1_000_000);
    expect(typeof wallets.marketWallets?.[market]?.ready).toBe('boolean');
    expect(typeof wallets.marketCapital?.[market]?.settlementReady).toBe('boolean');
  }
  // The unified-ledger route may import live broker history. Read the
  // canonical Paper snapshot only; provider-private account reads are forbidden
  // in this scoped Staging QA.
  const journal = await readOwned(page, '/api/paper-journal/snapshot');
  expect(Array.isArray(journal.records)).toBe(true);
  expect(journal.orderSubmitted).toBe(false);
  expect(journal.exchangeRequestSent).toBe(false);
  const integrations = await readOwned(page, '/api/user-integrations');
  expect(Array.isArray(integrations.brokerConnections)).toBe(true);
  expect(integrations.brokerConnectionsAvailable).toBe(true);
  expect(integrations.privateApiRequests).toBe(0);
  expect(integrations.ordersSubmitted).toBe(0);
  expect(integrations.ordersCancelled).toBe(0);
  expect(integrations.telegramRuntime).toBeTruthy();
  expect(forbiddenMutationRequests).toBe(0);

  const roomCodes = wallets.creationBlockers?.filter((v: unknown) => failCodeOnly(v) !== 'UNCLASSIFIED')
    .map((v: unknown) => failCodeOnly(v)).slice(0, 20) ?? [];
  const workerBlockers = paperRuntime.blockers
    .filter((v: unknown) => failCodeOnly(v) !== 'UNCLASSIFIED')
    .map((v: unknown) => failCodeOnly(v)).slice(0, 30);
  const receipt = {
    schemaVersion: 'staging-trading-core-only-v1',
    targetSha: sha,
    project: testInfo.project.name,
    stagingScopedQa: 'PASS',
    browserAuthMode: 'STAGING_PASSWORD_SESSION_RESTORE',
    interactiveLoginFormTested: false,
    stagesChecked: ['health','browser-auto-trading','policy-four-markets','provider-server-gates','paper-worker','admin-four-wallets','paper-journal-snapshot','telegram-config'],
    fourMarketsStructural: true,
    providersValidatedWithoutPrivateCalls: true,
    walletSeedPerMarketKrw: 1_000_000,
    walletCount: MARKETS.filter(m => wallets.marketWallets[m].ready).length,
    stagingWalletReady: wallets.ready === true,
    paperWorkerReady: paperRuntime.readyForPaperEvaluation === true,
    walletBlockers: roomCodes,
    workerBlockers,
    canaryPaperFillObserved: false,
    telegramSentReceiptObserved: false,
    realOrderAuthorityGranted: false,
    providerPrivateRequests: 0,
    tradingMutations: 0,
    productionReleaseReady: false,
    fullStagingReleaseVerdict: 'NOT_EVALUATED',
    automaticTradingActivated: false,
  };
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(outputDir, 'scoped-' + testInfo.project.name + '.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
});
