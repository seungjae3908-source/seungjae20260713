import { expect, type ConsoleMessage, type Page, type Request, type Response } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const LOGIN_READY_BUDGET_MS = 15_000;
const LOGIN_NAVIGATION_TIMEOUT_RETRIES = 1;
const LOGIN_INTERACTIVE_COLD_RETRIES = 1;
const LOGIN_AUTH_PROFILE_PROOF_BUDGET_MS = 10_000;
const LOGIN_AUTH_PROFILE_TIMEOUT_RETRIES = 1;

type ProductionReadOnlyCredentials = {
  login: string;
  password: string;
};

export type LoginSurfaceState = {
  path: string;
  idVisible: boolean;
  passwordVisible: boolean;
  buttonVisible: boolean;
  fallbackVisible: boolean;
  membershipVisible: boolean;
  alertVisible: boolean;
  documentReadyState: string;
  rootChildCount: number;
};

type LoginDiagnostic = {
  kind: 'console' | 'pageerror' | 'http' | 'requestfailed';
  path: string;
  detail: string;
  status?: number;
};

function safePath(rawUrl: string) {
  try {
    return new URL(rawUrl).pathname.slice(0, 300);
  } catch {
    return 'unknown';
  }
}

function normalizedPagePath(page: Page) {
  const pathname = safePath(page.url()).replace(/\/+$/, '');
  return pathname || '/';
}

function redactDiagnosticDetail(value: string, credentials: ProductionReadOnlyCredentials) {
  let safe = value
    .replace(/https?:\/\/[^\s"'`<>]+/gi, '[redacted-url]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/\b(?:sb_publishable|sb_secret|service_role|anon)_[A-Za-z0-9._-]+\b/gi, '[redacted-key]')
    .replace(/((?:authorization|apikey|api[_-]?key|token|password|secret|key)\s*[:=]\s*)([^\s,;]+)/gi, '$1[redacted]');
  for (const secret of [credentials.login, credentials.password]) {
    if (secret) safe = safe.split(secret).join('[redacted-credential]');
  }
  return safe.slice(0, 400);
}

async function readLoginSurfaceState(page: Page): Promise<LoginSurfaceState> {
  if (page.isClosed()) {
    return {
      path: 'closed',
      idVisible: false,
      passwordVisible: false,
      buttonVisible: false,
      fallbackVisible: false,
      membershipVisible: false,
      alertVisible: false,
      documentReadyState: 'closed',
      rootChildCount: 0,
    };
  }
  const [idVisible, passwordVisible, buttonVisible, fallbackVisible, membershipVisible, alertVisible, document] = await Promise.all([
    page.getByLabel('아이디').isVisible({ timeout: 250 }).catch(() => false),
    page.getByLabel('비밀번호').isVisible({ timeout: 250 }).catch(() => false),
    page.getByRole('button', { name: '로그인', exact: true }).isVisible({ timeout: 250 }).catch(() => false),
    page.getByTestId('page-fallback').isVisible({ timeout: 250 }).catch(() => false),
    page.getByTestId('membership-label').isVisible({ timeout: 250 }).catch(() => false),
    page.locator('[role="alert"]').first().isVisible({ timeout: 250 }).catch(() => false),
    page.evaluate(() => ({
      readyState: document.readyState,
      rootChildCount: document.querySelector('#root')?.childElementCount ?? 0,
    })).catch(() => ({ readyState: 'unavailable', rootChildCount: 0 })),
  ]);
  return {
    path: normalizedPagePath(page),
    idVisible,
    passwordVisible,
    buttonVisible,
    fallbackVisible,
    membershipVisible,
    alertVisible,
    documentReadyState: document.readyState,
    rootChildCount: document.rootChildCount,
  };
}

function isLoginReady(state: LoginSurfaceState) {
  return state.idVisible && state.passwordVisible && state.buttonVisible && !state.fallbackVisible;
}

export function isDiagnosticFreeIncompleteLogin(state: LoginSurfaceState, diagnosticCount: number) {
  return state.path === '/login'
    && !isLoginReady(state)
    && !state.membershipVisible
    && !state.alertVisible
    && diagnosticCount === 0;
}

function writeLoginFailureDiagnostic(
  credentials: ProductionReadOnlyCredentials,
  startedAt: number,
  attempts: number,
  state: LoginSurfaceState,
  diagnostics: LoginDiagnostic[],
) {
  const configuredDir = String(process.env.PRODUCTION_LOGIN_DIAGNOSTIC_DIR ?? '').trim();
  if (!configuredDir) return;
  const directory = path.resolve(process.cwd(), configuredDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `production-login-readiness-failure-${Date.now()}-${process.pid}.json`);
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 'production-login-readiness-failure-v1',
    generatedAt: new Date().toISOString(),
    authenticated: false,
    durationMs: Date.now() - startedAt,
    attempts,
    finalState: state,
    diagnostics: diagnostics.slice(-40).map((item) => ({
      ...item,
      detail: redactDiagnosticDetail(item.detail, credentials),
    })),
    secretValuesRecorded: false,
  }, null, 2)}\n`, { mode: 0o600 });
}

function isPlaywrightTimeout(error: unknown) {
  return error instanceof Error
    && (error.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(error.message));
}

function accessTokenFromUnknown(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = accessTokenFromUnknown(item, depth + 1);
      if (token) return token;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.access_token === 'string' && record.access_token.length > 20) return record.access_token;
  for (const item of Object.values(record)) {
    const token = accessTokenFromUnknown(item, depth + 1);
    if (token) return token;
  }
  return null;
}

async function proveAuthenticatedProfileReadOnly(page: Page) {
  let origin: string;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    return false;
  }
  if (!/^https:\/\//.test(origin)) return false;

  const accessToken = await productionReadOnlyAccessToken(page);
  if (!accessToken) return false;

  for (let attempt = 0; attempt <= LOGIN_AUTH_PROFILE_TIMEOUT_RETRIES; attempt += 1) {
    try {
      const response = await page.request.get(new URL('/api/auth/profile', origin).toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: LOGIN_READY_BUDGET_MS,
        failOnStatusCode: false,
      });
      if (response.status() !== 200) return false;
      const payload = await response.json().catch(() => null);
      return Boolean(
        payload
        && typeof payload === 'object'
        && typeof (payload as Record<string, unknown>).id === 'string',
      );
    } catch (error) {
      if (!isPlaywrightTimeout(error) || attempt >= LOGIN_AUTH_PROFILE_TIMEOUT_RETRIES) return false;
    }
  }
  return false;
}

export async function productionReadOnlyAccessToken(page: Page) {
  let origin: string;
  try {
    origin = new URL(page.url()).origin;
  } catch {
    return null;
  }
  const state = await page.context().storageState();
  const originState = state.origins.find((entry) => entry.origin === origin);
  for (const entry of originState?.localStorage ?? []) {
    try {
      const token = accessTokenFromUnknown(JSON.parse(entry.value));
      if (token) return token;
    } catch {
      // Non-JSON localStorage values are unrelated to the authenticated session.
    }
  }
  return null;
}

async function gotoLoginWithTimeoutRetry(page: Page) {
  for (let attempt = 0; attempt <= LOGIN_NAVIGATION_TIMEOUT_RETRIES; attempt += 1) {
    try {
      await page.goto('/login', { waitUntil: 'commit', timeout: LOGIN_READY_BUDGET_MS });
      return;
    } catch (error) {
      if (!isPlaywrightTimeout(error) || attempt >= LOGIN_NAVIGATION_TIMEOUT_RETRIES) throw error;
    }
  }
  throw new Error('PRODUCTION_QA_LOGIN_NAVIGATION_UNAVAILABLE');
}

export async function loginProductionReadOnly(
  page: Page,
  credentials: ProductionReadOnlyCredentials,
) {
  const startedAt = Date.now();
  const diagnostics: LoginDiagnostic[] = [];
  let attempts = 0;
  const pushDiagnostic = (diagnostic: LoginDiagnostic) => {
    if (diagnostics.length < 80) diagnostics.push(diagnostic);
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === 'error') {
      pushDiagnostic({ kind: 'console', path: normalizedPagePath(page), detail: message.text() });
    }
  };
  const onPageError = (error: Error) => {
    pushDiagnostic({ kind: 'pageerror', path: normalizedPagePath(page), detail: error.message });
  };
  const onResponse = (response: Response) => {
    if (response.status() < 400) return;
    let responseUrl: URL;
    let pageUrl: URL;
    try {
      responseUrl = new URL(response.url());
      pageUrl = new URL(page.url());
    } catch {
      return;
    }
    if (responseUrl.origin !== pageUrl.origin) return;
    if (response.status() === 404 && /\/(?:manifest|favicon)/i.test(responseUrl.pathname)) return;
    pushDiagnostic({
      kind: 'http',
      path: responseUrl.pathname.slice(0, 300),
      status: response.status(),
      detail: `${response.request().method()} ${response.status()} ${response.statusText()}`,
    });
  };
  const onRequestFailed = (request: Request) => {
    if (!['document', 'script', 'stylesheet', 'fetch', 'xhr'].includes(request.resourceType())) return;
    const detail = request.failure()?.errorText ?? 'request failed';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(detail)) return;
    pushDiagnostic({
      kind: 'requestfailed',
      path: safePath(request.url()),
      detail: `${request.method()} ${detail}`,
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  const loginId = page.getByLabel('아이디');
  const loginPassword = page.getByLabel('비밀번호');
  const loginButton = page.getByRole('button', { name: '로그인', exact: true });
  try {
    for (let attempt = 0; attempt <= LOGIN_INTERACTIVE_COLD_RETRIES; attempt += 1) {
      attempts = attempt + 1;
      await gotoLoginWithTimeoutRetry(page);
      try {
        await expect.poll(async () => isLoginReady(await readLoginSurfaceState(page)) ? 'READY' : 'PENDING', {
          timeout: LOGIN_READY_BUDGET_MS,
          intervals: [100, 200, 400, 800],
        }).toBe('READY');
        break;
      } catch (error) {
        const state = await readLoginSurfaceState(page);
        if (!isDiagnosticFreeIncompleteLogin(state, diagnostics.length) || attempt >= LOGIN_INTERACTIVE_COLD_RETRIES) {
          throw error;
        }
      }
    }

    await loginId.fill(credentials.login, { timeout: 3_000 });
    await loginPassword.fill(credentials.password, { timeout: 3_000 });
    await loginButton.click({ timeout: 3_000 });

    try {
      await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: LOGIN_READY_BUDGET_MS });
    } catch (error) {
      if (!isPlaywrightTimeout(error)) throw error;

      // A slow authenticated bootstrap must not be confused with an auth failure.
      // Do not submit credentials a second time. Instead prove the already-created
      // session with the same read-only profile endpoint used by Production QA.
      await expect.poll(
        () => proveAuthenticatedProfileReadOnly(page),
        {
          timeout: LOGIN_AUTH_PROFILE_PROOF_BUDGET_MS,
          intervals: [200, 500, 1_000],
        },
      ).toBe(true);
    }
  } catch (error) {
    const state = await readLoginSurfaceState(page);
    writeLoginFailureDiagnostic(credentials, startedAt, attempts, state, diagnostics);
    const summary = diagnostics.slice(-8)
      .map((item) => `${item.kind}:${item.status ?? '-'}:${item.path}:${redactDiagnosticDetail(item.detail, credentials)}`)
      .join(' | ') || 'NO_CAPTURED_DIAGNOSTIC';
    const original = redactDiagnosticDetail(error instanceof Error ? error.message.split('\n')[0] : 'login failed', credentials);
    throw new Error(`[PRODUCTION_QA_LOGIN_NOT_READY] path=${state.path}; attempts=${attempts}; diagnostics=${summary}; original=${original}`);
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }
}
