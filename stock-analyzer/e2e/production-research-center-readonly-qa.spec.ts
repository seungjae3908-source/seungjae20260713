import { expect, test, type Page, type Request } from '@playwright/test';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';

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

type Failure = { kind: string; detail: string };

async function login(page: Page) {
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 10_000 });
  await page.getByLabel('아이디').fill(qaLogin, { timeout: 3_000 });
  await page.getByLabel('비밀번호').fill(qaPassword, { timeout: 3_000 });
  await page.getByRole('button', { name: '로그인', exact: true }).click({ timeout: 3_000 });
  await expect(page.getByTestId('membership-label')).toBeVisible({ timeout: 15_000 });
}

function attachRuntimeFailures(page: Page, failures: Failure[]) {
  page.on('pageerror', (error) => failures.push({ kind: 'pageerror', detail: error.message.slice(0, 500) }));
  page.on('requestfailed', (request: Request) => {
    const errorText = request.failure()?.errorText ?? 'request failed';
    if (isIgnorableProductionRequestFailure(request.url(), request.method(), errorText, productionOrigin)) return;
    failures.push({ kind: 'requestfailed', detail: `${request.method()} ${request.url()} ${errorText}`.slice(0, 500) });
  });
}

test.describe('Production Research Center read-only QA', () => {
  test.skip(!productionQaEnabled, 'Dedicated Production QA credentials and read-only flag are required');

  test('admin Research Center is reachable, bounded, scrollable, and read-only', async ({ page }) => {
    test.setTimeout(60_000);
    const blocked: Failure[] = [];
    const runtimeFailures: Failure[] = [];
    attachRuntimeFailures(page, runtimeFailures);
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push({ kind: 'blocked-mutation', detail: `${reason}: ${request.method()} ${request.url()}`.slice(0, 500) });
    });
    await login(page);

    await page.goto('/research-center', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page).toHaveURL(/\/research-center(?:$|[?#])/i, { timeout: 5_000 });
    await expect(page.getByTestId('research-center-page')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });

    const pending = page.getByText('연구 상태를 불러오는 중입니다.', { exact: true });
    if (await pending.isVisible({ timeout: 500 }).catch(() => false)) {
      await expect(pending).toBeHidden({ timeout: 8_000 });
    }

    const surface = page.getByTestId('research-center-page');
    const metrics = await surface.evaluate((main) => {
      const element = main as HTMLElement;
      const rootOverflow = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth;
      const before = element.scrollTop;
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const moved = element.scrollHeight <= element.clientHeight + 8 || element.scrollTop > before;
      const reachedBottom = element.scrollHeight <= element.clientHeight + 8
        || Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) <= 4;
      element.scrollTop = before;
      return {
        horizontalOverflowPx: Math.max(0, Math.round(rootOverflow)),
        moved,
        reachedBottom,
      };
    });

    await expect(page.getByRole('heading', { name: '연구센터', exact: true })).toBeVisible();
    await expect(page.getByText('READ ONLY', { exact: true })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.getByRole('tab').allTextContents()).resolves.toEqual(['연구 현황', 'AI 분석실', '검증 리포트', '모의매매']);
    await expect(page.getByRole('button', { name: '연구센터 새로고침' })).toBeVisible();

    expect(metrics.horizontalOverflowPx, 'Research Center horizontal overflow').toBeLessThanOrEqual(2);
    expect(metrics.moved, 'Research Center scroll container could not move').toBe(true);
    expect(metrics.reachedBottom, 'Research Center scroll container could not reach bottom').toBe(true);
    expect(blocked, 'Research Center QA attempted a blocked mutation').toEqual([]);
    expect(runtimeFailures, 'Research Center browser/runtime failures detected').toEqual([]);
  });
});
