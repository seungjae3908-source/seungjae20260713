import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import {
  provisionEphemeralStagingAccounts,
  type StagingAccountCredentials,
  type StagingAccountLifecycle,
} from './support/staging-account-lifecycle';

const strictMode = process.env.USER_INTEGRATIONS_STAGING_STRICT === 'true';
const targetSha = String(process.env.STAGING_TARGET_SHA ?? '').trim().toLowerCase();
const stagingBaseUrl = String(process.env.STAGING_BASE_URL ?? '').trim();
const artifactDir = path.resolve(
  process.env.STAGING_STRICT_ARTIFACT_DIR ?? '../staging-user-integrations-artifacts',
);
const evidencePath = path.join(artifactDir, 'staging-user-integrations-strict.json');

const emptyAccounts: StagingAccountCredentials = {
  pending: { loginName: '', password: '' },
  associate: { loginName: '', password: '' },
  regular: { loginName: '', password: '' },
  admin: { loginName: '', password: '' },
};

const evidence = {
  USER_INTEGRATIONS_GET_COUNT: 0,
  USER_INTEGRATIONS_HTTP_RESPONSE_COUNT: 0,
  USER_INTEGRATIONS_HTTP_TERMINAL_COUNT: 0,
  USER_INTEGRATIONS_HTTP_TERMINAL: false,
  USER_INTEGRATIONS_ACTUAL_ENDPOINT_SUCCESS_COUNT: 0,
  USER_INTEGRATIONS_UNEXPECTED_ABORT_COUNT: 0,
  USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT: 0,
  POST_LOGOUT_INTEGRATIONS_REQUEST_COUNT: 0,
  STALE_RESPONSE_PROBE_COUNT: 0,
  STALE_RESPONSE_UI_MUTATION_COUNT: 0,
  LOGOUT_DRAIN_PROBE_COUNT: 0,
  LOGOUT_STARTED_BEFORE_INTEGRATIONS_TERMINAL_COUNT: 0,
  AUTH_LOGOUT_REQUEST_COUNT: 0,
  HTTP_STATUSES: [] as number[],
};

let accounts = emptyAccounts;
let accountLifecycle: StagingAccountLifecycle | null = null;
let testCompleted = false;
let cleanupOk = false;
let logoutIntent = false;
const fixtureRequests = new WeakSet<Request>();

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for strict staging user-integrations verification`);
  return value;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

function isExactUserIntegrationsGet(request: Request) {
  try {
    const parsed = new URL(request.url());
    return request.method() === 'GET'
      && parsed.origin === new URL(stagingBaseUrl).origin
      && parsed.pathname === '/api/user-integrations'
      && parsed.searchParams.size === 0;
  } catch {
    return false;
  }
}

function isAuthLogout(request: Request) {
  try {
    const parsed = new URL(request.url());
    return request.method() === 'POST'
      && parsed.pathname === '/auth/v1/logout';
  } catch {
    return false;
  }
}

function attachStrictEvidence(page: Page) {
  page.on('request', (request) => {
    if (isExactUserIntegrationsGet(request)) {
      evidence.USER_INTEGRATIONS_GET_COUNT += 1;
      if (logoutIntent) evidence.POST_LOGOUT_INTEGRATIONS_REQUEST_COUNT += 1;
    }
    if (isAuthLogout(request)) evidence.AUTH_LOGOUT_REQUEST_COUNT += 1;
  });

  page.on('response', (response) => {
    const request = response.request();
    if (!isExactUserIntegrationsGet(request)) return;
    evidence.USER_INTEGRATIONS_HTTP_RESPONSE_COUNT += 1;
    evidence.HTTP_STATUSES.push(response.status());
    if (
      !fixtureRequests.has(request)
      && response.status() >= 200
      && response.status() < 300
    ) {
      evidence.USER_INTEGRATIONS_ACTUAL_ENDPOINT_SUCCESS_COUNT += 1;
    }
  });

  page.on('requestfinished', (request) => {
    if (isExactUserIntegrationsGet(request)) {
      evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT += 1;
    }
  });

  page.on('requestfailed', (request) => {
    if (!isExactUserIntegrationsGet(request)) return;
    evidence.USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT += 1;
    if (request.failure()?.errorText === 'net::ERR_ABORTED') {
      evidence.USER_INTEGRATIONS_UNEXPECTED_ABORT_COUNT += 1;
    }
  });
}

function integrationFixture(marker?: string) {
  return {
    brokerConnections: marker ? [{
      exchange: marker,
      accountMode: 'disabled',
      configured: false,
      lastVerifiedAt: null,
      lastErrorCode: null,
      credentialsExposed: false,
    }] : [],
    telegram: { connected: false, status: 'DISCONNECTED', connectedAt: null },
    preferences: {},
  };
}

async function fulfillIntegrationFixture(route: Route, marker?: string) {
  fixtureRequests.add(route.request());
  await route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(integrationFixture(marker)),
  });
}

function loginSubmitButton(page: Page) {
  return page.locator('form').getByRole('button', { name: /^로그인$|sign in|log in/i });
}

async function waitForPendingUserIntegrationsReads() {
  await expect.poll(
    () => evidence.USER_INTEGRATIONS_GET_COUNT - evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT,
    {
      message: 'login user-integrations GET must reach HTTP terminal before verifier navigation',
      timeout: 15_000,
      intervals: [100, 200, 300, 500],
    },
  ).toBe(0);
}

async function login(page: Page, loginName: string, password: string) {
  await page.goto('/login');
  const nameInput = page.locator(
    'input[type="email"], input[name="email"], input[autocomplete="username"]',
  ).first();
  const passwordInput = page.locator(
    'input[type="password"], input[name="password"], input[autocomplete="current-password"]',
  ).first();
  await expect(nameInput).toBeVisible();
  await nameInput.fill(loginName);
  await passwordInput.fill(password);
  await loginSubmitButton(page).click();
  await expect(page.getByRole('button', { name: /로그아웃|sign out/i })).toBeVisible({
    timeout: 30_000,
  });
  await waitForPendingUserIntegrationsReads();
}

async function openAccountAndRequireActualTerminal(page: Page) {
  await page.goto('/account');
  const panel = page.getByTestId('user-broker-telegram-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-user-integrations-request-state', 'success', {
    timeout: 30_000,
  });
  await expect.poll(() => evidence.USER_INTEGRATIONS_GET_COUNT).toBeGreaterThan(0);
  await expect.poll(() => evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT).toBeGreaterThan(0);
  await expect.poll(() => evidence.USER_INTEGRATIONS_ACTUAL_ENDPOINT_SUCCESS_COUNT).toBeGreaterThan(0);
  await waitForPendingUserIntegrationsReads();
  return panel;
}

async function runStaleResponseProbe(page: Page) {
  const release = deferred();
  let intercepted = 0;
  const beforeGet = evidence.USER_INTEGRATIONS_GET_COUNT;
  const beforeTerminal = evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT;

  await page.route('**/api/user-integrations', async (route) => {
    if (!isExactUserIntegrationsGet(route.request())) {
      await route.continue();
      return;
    }
    intercepted += 1;
    await release.promise;
    await fulfillIntegrationFixture(route, 'STALE_PROBE_MARKER');
  });

  try {
    const panel = page.getByTestId('user-broker-telegram-panel');
    await panel.getByRole('button', { name: '연결 상태 새로고침' }).click();
    await expect.poll(() => intercepted).toBe(1);
    await expect.poll(() => evidence.USER_INTEGRATIONS_GET_COUNT).toBe(beforeGet + 1);

    await page.evaluate(() => {
      window.history.pushState(null, '', '/settings');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page).toHaveURL(/\/settings(?:[?#].*)?$/);
    await expect(page.getByTestId('user-broker-telegram-panel')).toHaveCount(0);

    evidence.STALE_RESPONSE_PROBE_COUNT += 1;
    release.resolve();
    await expect.poll(() => evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT)
      .toBe(beforeTerminal + 1);
    await page.waitForTimeout(300);

    const panelCount = await page.getByTestId('user-broker-telegram-panel').count();
    const markerCount = await page.getByText(/STALE_PROBE_MARKER/i).count();
    if (panelCount > 0 || markerCount > 0) {
      evidence.STALE_RESPONSE_UI_MUTATION_COUNT += 1;
    }
    expect(panelCount, 'stale response must not remount the integration panel').toBe(0);
    expect(markerCount, 'stale response must not mutate the unmounted UI').toBe(0);
  } finally {
    release.resolve();
    await page.unroute('**/api/user-integrations');
  }
}

async function runLogoutDrainProbe(page: Page) {
  await openAccountAndRequireActualTerminal(page);

  const release = deferred();
  let intercepted = 0;
  const beforeGet = evidence.USER_INTEGRATIONS_GET_COUNT;
  const beforeTerminal = evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT;
  const beforeLogoutRequests = evidence.AUTH_LOGOUT_REQUEST_COUNT;

  await page.route('**/api/user-integrations', async (route) => {
    if (!isExactUserIntegrationsGet(route.request())) {
      await route.continue();
      return;
    }
    intercepted += 1;
    await release.promise;
    await fulfillIntegrationFixture(route);
  });

  try {
    const panel = page.getByTestId('user-broker-telegram-panel');
    await panel.getByRole('button', { name: '연결 상태 새로고침' }).click();
    await expect.poll(() => intercepted).toBe(1);
    await expect.poll(() => evidence.USER_INTEGRATIONS_GET_COUNT).toBe(beforeGet + 1);

    logoutIntent = true;
    await page.getByRole('button', { name: /로그아웃|sign out/i }).click();
    await expect(page.getByTestId('user-broker-telegram-panel')).toHaveCount(0);
    await page.waitForTimeout(300);

    if (evidence.AUTH_LOGOUT_REQUEST_COUNT !== beforeLogoutRequests) {
      evidence.LOGOUT_STARTED_BEFORE_INTEGRATIONS_TERMINAL_COUNT += 1;
    }
    expect(
      evidence.AUTH_LOGOUT_REQUEST_COUNT,
      'auth invalidation must wait for the pending user-integrations HTTP terminal',
    ).toBe(beforeLogoutRequests);

    evidence.LOGOUT_DRAIN_PROBE_COUNT += 1;
    release.resolve();
    await expect.poll(() => evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT)
      .toBe(beforeTerminal + 1);
    await expect.poll(() => evidence.AUTH_LOGOUT_REQUEST_COUNT)
      .toBeGreaterThan(beforeLogoutRequests);
    await expect(loginSubmitButton(page)).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(300);

    expect(
      evidence.POST_LOGOUT_INTEGRATIONS_REQUEST_COUNT,
      'logout must block all new user-integrations GET starts',
    ).toBe(0);
  } finally {
    release.resolve();
    await page.unroute('**/api/user-integrations');
  }
}

function strictPass() {
  const allResponses2xx = evidence.HTTP_STATUSES.length > 0
    && evidence.HTTP_STATUSES.every((status) => status >= 200 && status < 300);
  evidence.USER_INTEGRATIONS_HTTP_TERMINAL = evidence.USER_INTEGRATIONS_GET_COUNT >= 1
    && evidence.USER_INTEGRATIONS_HTTP_RESPONSE_COUNT === evidence.USER_INTEGRATIONS_GET_COUNT
    && evidence.USER_INTEGRATIONS_HTTP_TERMINAL_COUNT === evidence.USER_INTEGRATIONS_GET_COUNT
    && evidence.USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT === 0;

  return testCompleted
    && cleanupOk
    && evidence.USER_INTEGRATIONS_ACTUAL_ENDPOINT_SUCCESS_COUNT >= 1
    && evidence.USER_INTEGRATIONS_HTTP_TERMINAL
    && allResponses2xx
    && evidence.USER_INTEGRATIONS_UNEXPECTED_ABORT_COUNT === 0
    && evidence.USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT === 0
    && evidence.POST_LOGOUT_INTEGRATIONS_REQUEST_COUNT === 0
    && evidence.STALE_RESPONSE_PROBE_COUNT >= 1
    && evidence.STALE_RESPONSE_UI_MUTATION_COUNT === 0
    && evidence.LOGOUT_DRAIN_PROBE_COUNT >= 1
    && evidence.LOGOUT_STARTED_BEFORE_INTEGRATIONS_TERMINAL_COUNT === 0;
}

test.describe('strict staging user-integrations acceptance', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!strictMode, 'Requires isolated staging and explicit strict verifier mode');

  test.beforeAll(async () => {
    if (!/^[0-9a-f]{40}$/.test(targetSha)) {
      throw new Error('STAGING_TARGET_SHA must be an exact 40-character commit SHA');
    }
    accountLifecycle = await provisionEphemeralStagingAccounts({
      supabaseUrl: required('STAGING_SUPABASE_URL'),
      supabaseSecretKey: required('STAGING_SUPABASE_SECRET_KEY'),
      artifactDir,
    });
    accounts = accountLifecycle.accounts;
  });

  test.afterAll(async () => {
    let cleanupError: unknown = null;
    try {
      await accountLifecycle?.cleanup();
      cleanupOk = true;
    } catch (cause) {
      cleanupError = cause;
    }

    fs.mkdirSync(artifactDir, { recursive: true });
    const passed = strictPass();
    const artifact = {
      status: passed ? 'passed' : 'failed',
      target_sha: targetSha,
      ...evidence,
      EPHEMERAL_ACCOUNT_CLEANUP_OK: cleanupOk,
      source_run_id: String(process.env.GITHUB_RUN_ID ?? ''),
      source_run_attempt: String(process.env.GITHUB_RUN_ATTEMPT ?? ''),
      generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

    if (cleanupError) throw cleanupError;
    expect(passed, 'strict user-integrations staging evidence must pass every acceptance gate').toBe(true);
  });

  test('actual terminal, stale isolation, and logout drain remain strict', async ({ page }) => {
    attachStrictEvidence(page);
    await login(page, accounts.regular.loginName, accounts.regular.password);
    await openAccountAndRequireActualTerminal(page);

    expect(evidence.USER_INTEGRATIONS_UNEXPECTED_ABORT_COUNT).toBe(0);
    expect(evidence.USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT).toBe(0);

    await runStaleResponseProbe(page);
    await runLogoutDrainProbe(page);

    expect(evidence.USER_INTEGRATIONS_UNEXPECTED_ABORT_COUNT).toBe(0);
    expect(evidence.USER_INTEGRATIONS_UNEXPECTED_REQUESTFAILED_COUNT).toBe(0);
    expect(evidence.POST_LOGOUT_INTEGRATIONS_REQUEST_COUNT).toBe(0);
    expect(evidence.STALE_RESPONSE_UI_MUTATION_COUNT).toBe(0);
    testCompleted = true;
  });
});
