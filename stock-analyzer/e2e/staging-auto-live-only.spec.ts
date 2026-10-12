import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hasCapability } from '../../packages/member-access/src/index.js';
import { requestWithBrowserSession } from './support/browser-session-api';

const enabled = process.env.STAGING_AUTO_LIVE_ONLY_QA === 'true';
const MARKETS = ['domestic_stock', 'us_stock', 'crypto_spot', 'crypto_futures'] as const;
const PROVIDERS = ['toss', 'kiwoom', 'upbit', 'bitget'] as const;
const outputDir = path.resolve('staging-auto-live-artifacts');

test.skip(!enabled, 'Runs only in the protected Automatic LIVE-only Staging lane.');

function required(name: string) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`STAGING_AUTO_LIVE_REQUIRED_CONFIGURATION:${name}`);
  return value;
}

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
  if (!response.ok) throw new Error(`STAGING_AUTO_LIVE_ADMIN_AUTH_HTTP_${response.status}`);
  const body: any = await response.json().catch(() => null);
  if (typeof body?.access_token !== 'string' || typeof body?.refresh_token !== 'string'
    || typeof body?.user?.id !== 'string' || String(body?.user?.email ?? '').toLowerCase() !== email) {
    throw new Error('STAGING_AUTO_LIVE_ADMIN_SESSION_INVALID');
  }
  const origin = new URL(required('STAGING_BASE_URL')).origin;
  const profileResponse = await page.request.get(new URL('/api/auth/profile', origin).toString(), {
    headers: { Authorization: `Bearer ${body.access_token}` },
  });
  if (profileResponse.status() !== 200) throw new Error(`STAGING_AUTO_LIVE_PROFILE_HTTP_${profileResponse.status()}`);
  const profile: any = await profileResponse.json().catch(() => null);
  if (profile?.id !== body.user.id || profile?.status !== 'approved' || profile?.is_active !== true
    || !hasCapability(profile, 'canManageMembers')) {
    throw new Error('STAGING_AUTO_LIVE_ADMIN_PROFILE_NOT_APPROVED');
  }
  const session = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: 'bearer',
    expires_in: body.expires_in,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expires_in),
    user: body.user,
  };
  const storageKey = `sb-${supabase.hostname.split('.')[0]}-auth-token`;
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ storageKey, session }) => {
    window.localStorage.setItem(storageKey, JSON.stringify(session));
  }, { storageKey, session });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 30_000 });
}

async function readOwned(page: Page, endpoint: string) {
  const response = await requestWithBrowserSession(page, endpoint);
  expect(response.status(), endpoint).toBe(200);
  const value: any = await response.json().catch(() => null);
  expect(value?.ok, endpoint).toBe(true);
  return value;
}

test('Automatic LIVE-only Staging proves responsive UI and read-only four-market wiring', async ({ page }) => {
  const targetSha = required('STAGING_TARGET_SHA').toLowerCase();
  expect(targetSha).toMatch(/^[0-9a-f]{40}$/);
  const base = new URL(required('STAGING_BASE_URL'));
  expect(base.protocol).toBe('https:');
  expect(base.hostname).not.toBe('lsj119.com');

  let financialMutations = 0;
  let paperRequests = 0;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (/paper-journal|paper-runtime|paper-trading/i.test(url.pathname)) paperRequests += 1;
    if (url.origin === base.origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      financialMutations += 1;
      return route.abort('blockedbyclient');
    }
    return route.continue();
  });

  const healthResponse = await page.request.get('/api/health');
  expect(healthResponse.status()).toBe(200);
  const health: any = await healthResponse.json();
  expect(health?.ok).toBe(true);
  expect(String(health.deploySha ?? '').toLowerCase()).toBe(targetSha);
  expect(String(health.deployMarkerSha ?? '').toLowerCase()).toBe(targetSha);
  expect(health.identityMatch).toBe(true);
  expect(health.backgroundWorkersEnabled).toBe(false);

  await restoreStagingAdminSession(page);
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/auto-trading', { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('auto-trading-page')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId('auto-trading-responsive-layout')).toBeVisible();
    await expect(page.getByTestId('technical-trading-modes')).toContainText('자동매매');
    await expect(page.getByTestId('technical-trading-modes')).toContainText('모의매매');
    await expect(page.getByTestId('trading-paper-modes')).toHaveCount(0);
    await expect(page.getByTestId('trading-holdings')).toBeVisible();
    await expect(page.getByTestId('auto-trading-runtime-summary')).not.toContainText('확인 중');
    await expect(page.getByTestId('trading-workspace-safety-note')).toHaveCount(0);
    await expect(page.getByTestId('trading-mode-paper')).toHaveCount(0);
    await expect(page.getByTestId('paper-trading-shell')).toHaveCount(0);
    if (viewport.width < 640) {
      await expect(page.getByTestId('trading-market-select')).toBeVisible();
    } else {
      await expect(page.getByTestId('trading-market-tabs')).toBeVisible();
    }
  }

  const status = await readOwned(page, '/api/trade-automation/status');
  expect(status.policy?.marketEnabled).toBeTruthy();
  expect(Array.isArray(status.connections)).toBe(true);
  for (const market of MARKETS) {
    expect(typeof status.policy.marketEnabled[market]).toBe('boolean');
    expect(status.liveAutomaticReadinessByMarket?.[market]?.orderSubmissionPerformedByStatusRequest).toBe(false);
  }
  for (const provider of PROVIDERS) {
    expect(status.liveAutomaticExecutionServerEnabled?.[provider]).toBe(false);
  }
  expect(financialMutations).toBe(0);
  expect(paperRequests).toBe(0);

  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(outputDir, 'staging-auto-live-only.json'), JSON.stringify({
    schemaVersion: 'staging-auto-live-only-v1',
    targetSha,
    stagingScopedQa: 'PASS',
    viewports: ['desktop-1440', 'tablet-1024', 'mobile-390'],
    markets: [...MARKETS],
    providers: [...PROVIDERS],
    automaticTradingReadinessVerified: true,
    paperTradingOutOfScope: true,
    telegramOutOfScope: true,
    paperRequests: 0,
    financialMutations: 0,
    privateProviderRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    productionReleaseReady: true,
  }, null, 2), { mode: 0o600 });
});
