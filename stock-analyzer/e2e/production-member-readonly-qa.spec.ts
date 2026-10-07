import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

// Release-candidate refresh: merge only after canonical Application CI itself is completed/success,
 // not merely after its six required commit statuses turn green.
const enabled = process.env.PRODUCTION_MEMBER_READONLY_QA === 'true';
const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').trim().replace(/\/$/, '');
const expectedSha = String(process.env.EXPECTED_DEPLOY_SHA ?? '').trim().toLowerCase();
const deployRunId = Number(process.env.PRODUCTION_DEPLOY_RUN_ID ?? 0);
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '').trim();
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionOrigin = enabled && baseUrl ? new URL(baseUrl).origin : 'https://lsj119.com';
const artifactDir = path.resolve(process.env.PRODUCTION_MEMBER_READONLY_ARTIFACT_DIR ?? 'production-member-readonly-artifacts');

test.skip(!enabled, 'Production member-only QA runs only in the dedicated protected workflow.');

if (enabled) {
  if (!baseUrl || new URL(baseUrl).origin !== 'https://lsj119.com') throw new Error('Official Production origin is required');
  if (!qaLogin || !qaPassword) throw new Error('Production QA login credential is required');
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('EXPECTED_DEPLOY_SHA must be exact');
  if (!Number.isSafeInteger(deployRunId) || deployRunId <= 0) throw new Error('PRODUCTION_DEPLOY_RUN_ID must be exact');
  fs.mkdirSync(artifactDir, { recursive: true });
}

type MemberTier = 'associate' | 'regular' | 'admin';
type Diagnostic = { kind: string; path: string; detail: string; status?: number };
type Profile = {
  id: string;
  status: string;
  membership_level: string | null;
  is_active: boolean | null;
  membership_expires_at: string | null;
};

function safePath(raw: string) {
  try { return new URL(raw).pathname; } catch { return '[invalid-url]'; }
}

function attachDiagnostics(page: Page, diagnostics: Diagnostic[]) {
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push({ kind: 'console', path: safePath(page.url()), detail: message.text().slice(0, 300) });
  });
  page.on('pageerror', (error) => diagnostics.push({ kind: 'pageerror', path: safePath(page.url()), detail: error.message.slice(0, 300) }));
  page.on('requestfailed', (request: Request) => {
    const failure = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), failure, productionOrigin)) return;
    diagnostics.push({ kind: 'requestfailed', path: safePath(request.url()), detail: `${request.method()} ${failure}`.slice(0, 300) });
  });
  page.on('response', (response) => {
    if (response.status() < 500) return;
    const url = new URL(response.url());
    if (url.origin !== productionOrigin) return;
    diagnostics.push({ kind: 'http', path: url.pathname, status: response.status(), detail: `${response.request().method()} ${response.status()}` });
  });
}

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.getByLabel('아이디').fill(qaLogin);
  await page.getByLabel('비밀번호').fill(qaPassword);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

async function accessToken(page: Page) {
  return page.evaluate(() => {
    const find = (value: unknown, depth = 0): string | null => {
      if (depth > 6 || value == null) return null;
      if (Array.isArray(value)) {
        for (const item of value) { const found = find(item, depth + 1); if (found) return found; }
        return null;
      }
      if (typeof value !== 'object') return null;
      const record = value as Record<string, unknown>;
      if (typeof record.access_token === 'string' && record.access_token.length > 20) return record.access_token;
      for (const child of Object.values(record)) { const found = find(child, depth + 1); if (found) return found; }
      return null;
    };
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try { const found = find(JSON.parse(raw)); if (found) return found; } catch {}
    }
    return null;
  });
}

function memberTierFromLabel(label: string): MemberTier | null {
  if (label.includes('준회원')) return 'associate';
  if (label.includes('정회원')) return 'regular';
  if (label.includes('관리자')) return 'admin';
  return null;
}

async function openMemberRoute(page: Page, route: string) {
  await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('capability-denied')).toHaveCount(0, { timeout: 15_000 });
}

test('Production member-only access contract is exact-SHA, read-only, and tier-consistent', async ({ page }, testInfo: TestInfo) => {
  const diagnostics: Diagnostic[] = [];
  const blocked: Diagnostic[] = [];
  attachDiagnostics(page, diagnostics);
  await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
    blocked.push({ kind: 'blocked-mutation', path: safePath(request.url()), detail: `${reason}:${request.method()}` });
  });

  const healthResponse = await page.request.get(`${baseUrl}/api/health`);
  expect(healthResponse.status()).toBe(200);
  const health = await healthResponse.json() as Record<string, unknown>;
  expect(health.ok).toBe(true);
  expect(String(health.deploySha ?? '').toLowerCase()).toBe(expectedSha);
  expect(health.identityMatch).toBe(true);

  await login(page);
  const label = String(await page.getByTestId('membership-label').textContent() ?? '');
  const tier = memberTierFromLabel(label);
  expect(tier, `Production QA account must be an approved member tier: ${label}`).not.toBeNull();

  const token = await accessToken(page);
  expect(token).toBeTruthy();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const profileResponse = await page.request.get(`${baseUrl}/api/auth/profile`, { headers: authHeaders });
  expect(profileResponse.status()).toBe(200);
  const profile = await profileResponse.json() as Profile;
  expect(profile.status).toBe('approved');
  expect(profile.is_active).toBe(true);
  expect(profile.membership_level).toBe(tier);
  if (profile.membership_expires_at) expect(Date.parse(profile.membership_expires_at)).toBeGreaterThan(Date.now());

  await openMemberRoute(page, '/account');
  await expect(page.getByTestId('membership-label')).toContainText(tier === 'admin' ? '관리자' : tier === 'regular' ? '정회원' : '준회원');
  const liveOrderPanels = await page.getByTestId('trade-execution-connections').count();
  expect(liveOrderPanels).toBe(tier === 'admin' ? 1 : 0);

  await openMemberRoute(page, '/scanner');
  const sGrade = await page.request.get(
    `${baseUrl}/api/market/scan?market=KR&grade=S&strategy=scalping&timeframe=5m&batchSize=10`,
    { headers: authHeaders, timeout: 20_000 },
  );
  const sBody = await sGrade.json().catch(() => ({})) as { error?: string };
  expect(sGrade.status()).not.toBe(401);
  expect(sBody.error).not.toBe('SCANNER_GRADE_FORBIDDEN');
  expect(sBody.error).not.toBe('CAPABILITY_REQUIRED');

  await openMemberRoute(page, '/ai-chart?assetType=stock&market=KR&symbol=005930&ticker=005930&name=%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90&timeframe=5m');
  await expect(page.getByTestId('unified-analysis-chart')).toBeVisible({ timeout: 15_000 });

  await openMemberRoute(page, '/position?tab=journal');
  await expect(page.getByTestId('unified-trade-journal')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('unified-journal-analytics')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('ai-review-panel')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('unified-journal-import-history')).toHaveCount(tier === 'associate' ? 0 : 1);

  await page.goto('/admin', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 15_000 });
  if (tier === 'admin') {
    await expect(page.getByRole('heading', { name: '회원 관리', exact: true })).toBeVisible({ timeout: 15_000 });
  } else {
    await expect(page.getByTestId('capability-denied')).toBeVisible({ timeout: 15_000 });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await openMemberRoute(page, '/account');
  await expect(page.getByTestId('membership-label')).toBeVisible();
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
  expect(overflow).toBeLessThanOrEqual(2);

  expect(blocked).toEqual([]);
  expect(diagnostics.filter((item) => item.kind !== 'http')).toEqual([]);

  const receipt = {
    schemaVersion: 'production-member-readonly-qa-v1',
    complete: true,
    targetSha: expectedSha,
    productionDeployRunId: deployRunId,
    officialProductionOrigin: true,
    authenticatedProductionSession: true,
    membershipLevel: tier,
    profileStatus: profile.status,
    memberActive: profile.is_active === true,
    membershipExpiryValid: profile.membership_expires_at == null || Date.parse(profile.membership_expires_at) > Date.now(),
    sGradeAccessAllowed: sBody.error !== 'SCANNER_GRADE_FORBIDDEN',
    aiChartAccessible: true,
    tradingAnalyticsAccessible: true,
    aiTradingReviewAccessible: true,
    adminSurfaceMatchedTier: true,
    liveOrderSurfaceMatchedTier: true,
    mobileAccountLayoutSafe: true,
    blockedMutationRequests: blocked.length,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    realOrderSubmitted: false,
    liveTradingAuthorityGranted: false,
    autoTradingAuthorityGranted: false,
    secretValuesRecorded: false,
    accountValuesRecorded: false,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(artifactDir, 'production-member-readonly-qa.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  testInfo.annotations.push({ type: 'member-tier', description: tier! });
});
