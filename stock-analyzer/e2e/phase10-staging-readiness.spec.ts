import fs from 'node:fs';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';

const stagingMode = process.env.PHASE10_STAGING_E2E === 'true';
const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for full staging release validation`);
  return value;
};

function stagingAccount(emailName: string, passwordName: string) {
  const configuredEmail = required(emailName);
  const loginName = configuredEmail.split('@', 1)[0]?.trim() ?? '';
  if (!/^[가-힣a-zA-Z0-9 _.-]{2,20}$/.test(loginName)) {
    throw new Error(`${emailName} local part must be a valid 2-20 character application login ID`);
  }
  return { loginName, password: required(passwordName) };
}

const targetSha = stagingMode ? required('STAGING_TARGET_SHA').toLowerCase() : '';
const artifactDir = path.resolve(process.env.STAGING_ARTIFACT_DIR ?? '../staging-artifacts');
const diagnosticsPath = path.join(artifactDir, 'staging-browser-results.json');
const accounts = stagingMode ? {
  pending: stagingAccount('STAGING_PENDING_EMAIL', 'STAGING_PENDING_PASSWORD'),
  associate: stagingAccount('STAGING_ASSOCIATE_EMAIL', 'STAGING_ASSOCIATE_PASSWORD'),
  regular: stagingAccount('STAGING_REGULAR_EMAIL', 'STAGING_REGULAR_PASSWORD'),
  admin: stagingAccount('STAGING_ADMIN_EMAIL', 'STAGING_ADMIN_PASSWORD'),
} : {
  pending: { loginName: '', password: '' },
  associate: { loginName: '', password: '' },
  regular: { loginName: '', password: '' },
  admin: { loginName: '', password: '' },
};

type Diagnostic = { test: string; url: string; detail: string; status?: number };
const diagnostics: {
  console_errors: Diagnostic[];
  page_errors: Diagnostic[];
  unhandled_rejections: Diagnostic[];
  unexpected_http_errors: Diagnostic[];
} = {
  console_errors: [],
  page_errors: [],
  unhandled_rejections: [],
  unexpected_http_errors: [],
};

function recordUnhandled(testName: string, url: string, detail: string) {
  if (/unhandled|uncaught.*promise|promise rejection/i.test(detail)) {
    diagnostics.unhandled_rejections.push({ test: testName, url, detail });
  }
}

function attachDiagnostics(page: Page, testInfo: TestInfo) {
  const testName = testInfo.titlePath.join(' > ');
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const detail = message.text();
    diagnostics.console_errors.push({ test: testName, url: page.url(), detail });
    recordUnhandled(testName, page.url(), detail);
  });
  page.on('pageerror', (error) => {
    diagnostics.page_errors.push({ test: testName, url: page.url(), detail: error.message });
    recordUnhandled(testName, page.url(), error.message);
  });
  page.on('response', (response) => {
    if (response.status() < 400) return;
    diagnostics.unexpected_http_errors.push({
      test: testName,
      url: response.url(),
      status: response.status(),
      detail: `${response.request().method()} ${response.status()} ${response.statusText()}`,
    });
  });
  page.on('requestfailed', (request) => {
    diagnostics.unexpected_http_errors.push({
      test: testName,
      url: request.url(),
      status: 0,
      detail: `${request.method()} ${request.failure()?.errorText ?? 'request failed'}`,
    });
  });
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
}

async function login(page: Page, loginName: string, password: string) {
  await page.goto('/login');
  const nameInput = page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"], input[autocomplete="current-password"]').first();
  await expect(nameInput).toBeVisible();
  await nameInput.fill(loginName);
  await passwordInput.fill(password);
  await page.getByRole('button', { name: /^로그인$|sign in|log in/i }).click();
  await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible({ timeout: 30_000 });
}

async function logout(page: Page) {
  await page.getByRole('button', { name: /로그아웃|sign out/i }).click();
  await expect(page.getByRole('button', { name: /^로그인$|sign in|log in/i })).toBeVisible({ timeout: 20_000 });
}

async function expectMembership(page: Page, label: RegExp) {
  await expect(page.getByTestId('membership-label')).toContainText(label);
}

async function expectHealthyRoute(page: Page, route: string) {
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
  if (response) expect(response.status(), `${route} returned HTTP ${response.status()}`).toBeLessThan(400);
  await settle(page);
  await expect(page.locator('body')).not.toContainText(/페이지를 찾을 수 없습니다|page not found/i);
  await expect(page.locator('body')).not.toBeEmpty();
}

function errorsFor(testInfo: TestInfo) {
  const testName = testInfo.titlePath.join(' > ');
  return {
    console: diagnostics.console_errors.filter((item) => item.test === testName),
    page: diagnostics.page_errors.filter((item) => item.test === testName),
    rejection: diagnostics.unhandled_rejections.filter((item) => item.test === testName),
    http: diagnostics.unexpected_http_errors.filter((item) => item.test === testName),
  };
}

test.describe('real staging release readiness', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!stagingMode, 'Requires isolated staging, exact SHA, and four staging-only accounts');

  test.beforeEach(async ({ page }, testInfo) => {
    attachDiagnostics(page, testInfo);
  });

  test.afterEach(async ({}, testInfo) => {
    const errors = errorsFor(testInfo);
    expect(errors.console, 'browser console errors').toEqual([]);
    expect(errors.page, 'pageerror events').toEqual([]);
    expect(errors.rejection, 'unhandled promise rejections').toEqual([]);
    expect(errors.http, 'unexpected browser HTTP 4xx/5xx or failed requests').toEqual([]);
  });

  test.afterAll(() => {
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8');
  });

  test('anonymous: health, login boundary, and protected API denial', async ({ page }) => {
    const health = await page.request.get('/api/health');
    expect(health.ok()).toBeTruthy();
    const body = await health.json();
    expect(body.ok).toBe(true);
    const reportedSha = String(body.deploySha ?? body.sha ?? body.commitSha ?? '').toLowerCase();
    expect(reportedSha).toBe(targetSha);

    await page.goto('/paper-trading');
    await expect(page.getByRole('button', { name: /^로그인$|sign in|log in/i })).toBeVisible();
    await expect(page.locator('nav')).toHaveCount(0);

    const protectedResponse = await page.request.get('/api/paper-journal/snapshot');
    expect([401, 403]).toContain(protectedResponse.status());
  });

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ] as const) {
    test(`${name}: login, refresh session retention, responsive layout, and logout`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page, accounts.regular.loginName, accounts.regular.password);
      await expectMembership(page, /정회원/);
      await page.reload();
      await settle(page);
      await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await logout(page);
    });
  }

  test('pending: approval-waiting account cannot enter approved UI, URL, or API', async ({ page }) => {
    await login(page, accounts.pending.loginName, accounts.pending.password);
    await expectMembership(page, /승인대기/);
    await expect(page.getByText(/관리자 승인 대기 중/)).toBeVisible();
    await page.goto('/stock-info');
    await expect(page.getByText(/관리자 승인 대기 중/)).toBeVisible();
    await expect(page.locator('nav')).toHaveCount(0);
    const response = await page.request.get('/api/paper-journal/snapshot');
    expect([401, 403]).toContain(response.status());
  });

  test('associate: basic stock and spot access allowed; futures, AI-risk, portfolio, and APIs denied', async ({ page }) => {
    await login(page, accounts.associate.loginName, accounts.associate.password);
    await expectMembership(page, /준회원/);
    await expectHealthyRoute(page, '/');
    await expectHealthyRoute(page, '/stock-info?asset=stock&market=KR&symbol=005930');
    await expectHealthyRoute(page, '/stock-info?asset=coin&coinMarket=spot&symbol=BTC');

    for (const route of [
      '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT',
      '/scanner',
      '/portfolio',
    ]) {
      await page.goto(route);
      await expect(page.getByTestId('capability-denied')).toBeVisible();
    }

    const response = await page.request.post('/api/paper-journal/ai-review/preview', { data: {} });
    expect([401, 403]).toContain(response.status());
  });

  test('regular: futures, scanner, paper trading, and safe AI preview are available without real orders', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    await expectMembership(page, /정회원/);
    await expectHealthyRoute(page, '/stock-info?asset=coin&coinMarket=futures&symbol=BTCUSDT');
    await expectHealthyRoute(page, '/scanner');
    await expectHealthyRoute(page, '/paper-trading');
    await expect(page.locator('body')).toContainText(/모의|paper/i);

    const preview = await page.request.post('/api/paper-journal/ai-review/preview', { data: {} });
    expect(preview.ok()).toBeTruthy();
    const previewBody = await preview.json();
    expect(previewBody.externalAiCalled).toBe(false);
    expect(previewBody.orderSubmitted).toBe(false);
    expect(previewBody.exchangeRequestSent).toBe(false);
  });

  test('admin: member management is allowed while another users private journal remains blocked', async ({ page }) => {
    await login(page, accounts.admin.loginName, accounts.admin.password);
    await expectMembership(page, /관리자/);
    await expectHealthyRoute(page, '/admin');
    await expect(page.locator('body')).toContainText(/회원|member/i);
    const foreignJournal = await page.request.get('/api/paper-journal/snapshot?userId=11111111-1111-1111-1111-111111111111');
    expect([400, 403]).toContain(foreignJournal.status());
  });

  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['mobile', 390, 844],
  ] as const) {
    test(`${name}: major screens, search/detail, domestic/overseas/coin, watchlist, alerts, and settings`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await login(page, accounts.regular.loginName, accounts.regular.password);
      for (const route of [
        '/',
        '/search',
        '/stock/005930',
        '/stock-info?asset=stock&market=KR&symbol=005930',
        '/stock-info?asset=stock&market=US&symbol=AAPL',
        '/stock-info?asset=coin&coinMarket=spot&symbol=BTC',
        '/watchlist',
        '/alerts',
        '/themes',
        '/market-overview',
        '/learn',
        '/more',
      ]) {
        await expectHealthyRoute(page, route);
      }
    });
  }

  test('bottom navigation and popup menus traverse every visible destination', async ({ page }) => {
    await login(page, accounts.regular.loginName, accounts.regular.password);
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav).toBeVisible();

    for (const label of ['홈', '종목', '테마', '관심', '설정']) {
      await nav.getByRole('button', { name: label, exact: true }).click();
      await settle(page);
    }

    await nav.getByRole('button', { name: '기술', exact: true }).click();
    for (const label of ['AI 검색기', 'AI 차트 분석기', '자동매매']) {
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await settle(page);
      await nav.getByRole('button', { name: '기술', exact: true }).click();
    }
    await page.keyboard.press('Escape');

    await nav.getByRole('button', { name: '정보', exact: true }).click();
    for (const label of ['정보', '공부', '시황', 'AI 채팅', '포트폴리오']) {
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await settle(page);
      await nav.getByRole('button', { name: '정보', exact: true }).click();
    }
  });
});
