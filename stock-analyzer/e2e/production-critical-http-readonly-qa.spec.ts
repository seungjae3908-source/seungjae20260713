import { expect, test, type Page, type Response } from '@playwright/test';
import { installProductionReadOnlyPolicy } from './support/production-readonly-policy';

const baseUrl = String(process.env.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const qaLogin = String(process.env.PRODUCTION_QA_LOGIN ?? '');
const qaPassword = String(process.env.PRODUCTION_QA_PASSWORD ?? '');
const productionQaEnabled = Boolean(
  baseUrl
  && qaLogin
  && qaPassword
  && process.env.PRODUCTION_READONLY_E2E === 'true',
);
const productionOrigin = baseUrl ? new URL(baseUrl).origin : 'http://production-qa-disabled.invalid';

const ROUTES = [
  '/scanner',
  '/portfolio',
  '/account',
  '/paper-trading',
  '/ai-chart?assetType=coin_futures&market=BITGET&symbol=BTCUSDT&ticker=BTCUSDT&name=BTCUSDT&timeframe=5m',
  '/stock-info/analysis?asset=stock&market=KR&ticker=005930',
] as const;

type HttpFailure = {
  route: string;
  status: number;
  method: string;
  path: string;
};

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

function responsePath(response: Response) {
  try {
    const url = new URL(response.url());
    return `${url.pathname}${url.search}`.slice(0, 500);
  } catch {
    return response.url().slice(0, 500);
  }
}

test.describe('Production critical same-origin HTTP read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('critical UI routes do not emit authenticated GET 401/403/5xx', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'prod-desktop-1440');
    test.setTimeout(3 * 60_000);

    const blocked: string[] = [];
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push(`${reason}: ${request.method()} ${request.url()}`);
    });
    await login(page);

    const failures: HttpFailure[] = [];
    let activeRoute = '[LOGIN_COMPLETE]';
    const onResponse = (response: Response) => {
      let url: URL;
      try { url = new URL(response.url()); } catch { return; }
      if (url.origin !== productionOrigin) return;
      const method = response.request().method().toUpperCase();
      if (method !== 'GET') return;
      const status = response.status();
      if (!(status === 401 || status === 403 || status >= 500)) return;
      failures.push({ route: activeRoute, status, method, path: responsePath(response) });
    };
    page.on('response', onResponse);

    try {
      for (const route of ROUTES) {
        activeRoute = route;
        await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 }).catch(() => undefined);
        if (route.startsWith('/ai-chart')) {
          await expect(page.getByTestId('unified-chart-wrapper')).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
        }
        await page.waitForTimeout(1_500);
      }
    } finally {
      page.off('response', onResponse);
    }

    expect(blocked, 'critical HTTP QA attempted a blocked Production mutation').toEqual([]);
    expect(failures, 'critical authenticated GET returned 401/403/5xx').toEqual([]);
  });
});
