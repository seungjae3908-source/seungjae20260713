import { expect, type Page } from '@playwright/test';

const LOGIN_READY_BUDGET_MS = 15_000;
const LOGIN_NAVIGATION_TIMEOUT_RETRIES = 1;
const LOGIN_INTERACTIVE_COLD_RETRIES = 1;

type ProductionReadOnlyCredentials = {
  login: string;
  password: string;
};

function isPlaywrightTimeout(error: unknown) {
  return error instanceof Error
    && (error.name === 'TimeoutError' || /Timeout \d+ms exceeded/i.test(error.message));
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
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: LOGIN_READY_BUDGET_MS });
}
