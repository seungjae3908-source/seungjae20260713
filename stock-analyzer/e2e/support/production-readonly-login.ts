import { expect, type Page } from '@playwright/test';

const LOGIN_READY_BUDGET_MS = 15_000;
const LOGIN_NAVIGATION_TIMEOUT_RETRIES = 1;
const LOGIN_INTERACTIVE_COLD_RETRIES = 1;
const LOGIN_AUTH_PROFILE_PROOF_BUDGET_MS = 10_000;
const LOGIN_AUTH_PROFILE_TIMEOUT_RETRIES = 1;

type ProductionReadOnlyCredentials = {
  login: string;
  password: string;
};

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
  const loginId = page.getByLabel('아이디');
  const loginPassword = page.getByLabel('비밀번호');
  const loginButton = page.getByRole('button', { name: '로그인', exact: true });

  for (let attempt = 0; attempt <= LOGIN_INTERACTIVE_COLD_RETRIES; attempt += 1) {
    await gotoLoginWithTimeoutRetry(page);
    try {
      await expect.poll(async () => {
        const [idVisible, passwordVisible, buttonVisible, fallbackVisible] = await Promise.all([
          loginId.isVisible({ timeout: 250 }).catch(() => false),
          loginPassword.isVisible({ timeout: 250 }).catch(() => false),
          loginButton.isVisible({ timeout: 250 }).catch(() => false),
          page.getByTestId('page-fallback').isVisible({ timeout: 250 }).catch(() => false),
        ]);
        return idVisible && passwordVisible && buttonVisible && !fallbackVisible ? 'READY' : 'PENDING';
      }, { timeout: LOGIN_READY_BUDGET_MS, intervals: [100, 200, 400, 800] }).toBe('READY');
      break;
    } catch (error) {
      const [idVisible, passwordVisible, buttonVisible, fallbackVisible] = await Promise.all([
        loginId.isVisible({ timeout: 250 }).catch(() => false),
        loginPassword.isVisible({ timeout: 250 }).catch(() => false),
        loginButton.isVisible({ timeout: 250 }).catch(() => false),
        page.getByTestId('page-fallback').isVisible({ timeout: 250 }).catch(() => false),
      ]);
      const stillCold = new URL(page.url()).pathname === '/login'
        && fallbackVisible
        && !idVisible
        && !passwordVisible
        && !buttonVisible;
      if (!stillCold || attempt >= LOGIN_INTERACTIVE_COLD_RETRIES) throw error;
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
}
