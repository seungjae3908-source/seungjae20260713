import { expect, test, type Page, type Request } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  installProductionReadOnlyPolicy,
  isIgnorableProductionRequestFailure,
} from './support/production-readonly-policy';
import { loginProductionReadOnly } from './support/production-readonly-login';

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
const strictResearchQa = process.env.PRODUCTION_RESEARCH_ONLY_QA === 'true';

type Failure = { kind: string; detail: string };

async function login(page: Page) {
  await loginProductionReadOnly(page, { login: qaLogin, password: qaPassword });
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
    test.setTimeout(strictResearchQa ? 160_000 : 90_000);
    const blocked: Failure[] = [];
    const runtimeFailures: Failure[] = [];
    const criticalHttpFailures: Array<{ path: string; status: number }> = [];
    const pendingResearchReads = new Set<Request>();
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === productionOrigin && url.pathname.startsWith('/api/')
        && request.method() === 'GET') pendingResearchReads.add(request);
    });
    page.on('requestfinished', request => pendingResearchReads.delete(request));
    page.on('requestfailed', request => pendingResearchReads.delete(request));
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === productionOrigin && url.pathname.startsWith('/api/')
        && (response.status() === 401 || response.status() === 403 || response.status() >= 500)) {
        criticalHttpFailures.push({ path: url.pathname, status: response.status() });
      }
    });
    attachRuntimeFailures(page, runtimeFailures);
    await installProductionReadOnlyPolicy(page, productionOrigin, (request, reason) => {
      blocked.push({ kind: 'blocked-mutation', detail: `${reason}: ${request.method()} ${request.url()}`.slice(0, 500) });
    });
    await login(page);

    await page.goto('/research-center', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await expect(page).toHaveURL(/\/research-center(?:$|[?#])/i, { timeout: 5_000 });

    const researchWorkspace = page.getByTestId('research-center-workspace');
    const capabilityDenied = page.getByTestId('capability-denied');
    await expect.poll(async () => (
      await researchWorkspace.isVisible({ timeout: 250 }).catch(() => false)
      || await capabilityDenied.isVisible({ timeout: 250 }).catch(() => false)
    ), { timeout: 12_000, intervals: [100, 200, 400, 800] }).toBe(true);

    if (!await researchWorkspace.isVisible({ timeout: 250 }).catch(() => false)) {
      expect(strictResearchQa, 'RESEARCH_CENTER_NOT_EVALUATED: Research activation requires actual access, not a denial-only pass').toBe(false);
      await expect(capabilityDenied).toBeVisible();
      await expect(capabilityDenied).toContainText('기본 정보');
      await expect(researchWorkspace).toHaveCount(0);
      test.info().annotations.push({
        type: 'coverage',
        description: 'RESEARCH_CENTER_NOT_EVALUATED: Production QA credential lacks canAccessBasicInfo',
      });
      expect(blocked, 'Research Center denial QA attempted a blocked mutation').toEqual([]);
      expect(runtimeFailures, 'Research Center denial browser/runtime failures detected').toEqual([]);
      return;
    }

    await expect(researchWorkspace).toBeVisible();
    await expect(page.getByTestId('research-general-view')).toBeVisible({ timeout: 12_000 });
    await expect(page.getByRole('button', { name: '요약', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('page-fallback')).toHaveCount(0, { timeout: 5_000 });

    const pending = page.getByRole('region', { name: '연구 상태 확인 중' });
    if (await pending.isVisible({ timeout: 500 }).catch(() => false)) {
      await expect(pending).toBeHidden({ timeout: 8_000 });
    }

    const surface = page.getByTestId('research-general-view').locator('main');
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
    await expect(page.getByTestId('research-workspace-tabs').getByRole('button')).toHaveCount(6);
    await expect(page.getByRole('button', { name: '연구 상태 새로고침' })).toBeVisible();

    await page.getByRole('button', { name: '연구', exact: true }).click();
    await expect(page.getByRole('button', { name: '연구', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('research-center-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: '연구 현황', exact: true })).toBeVisible();
    await expect(page.getByText('조회 전용', { exact: true })).toBeVisible();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByTestId('research-workspace-tabs').getByRole('button').allTextContents()).resolves.toEqual(['요약', '연구', '검증', '모의매매', 'AI', '영상']);

    if (strictResearchQa) {
      for (const [label, panel] of [
        ['검증', 'research-evidence-tab'], ['모의매매', 'research-paper-tab'],
        ['AI', 'research-copilot'], ['영상', 'research-video-workspace'],
        ['요약', 'research-general-view'],
      ]) {
        const button = page.getByTestId('research-workspace-tabs').getByRole('button', { name: label, exact: true });
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect(page.getByTestId(panel)).toBeVisible({ timeout: 12_000 });
        await expect.poll(() => pendingResearchReads.size, { timeout: 15_000 }).toBe(0);
        await expect(page.getByTestId('research-error-state')).toHaveCount(0);
        expect(await page.getByRole('alert').count(), `${label}: data read failed`).toBe(0);
        await expect(button).toBeInViewport();
        const overflow = await page.evaluate(() => Math.max(0,
          Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) - window.innerWidth));
        expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(2);
        metrics.horizontalOverflowPx = Math.max(metrics.horizontalOverflowPx, overflow);
      }
      expect(criticalHttpFailures, 'Research authenticated GET failed').toEqual([]);
    }

    expect(metrics.horizontalOverflowPx, 'Research Center horizontal overflow').toBeLessThanOrEqual(2);
    expect(metrics.moved, 'Research Center scroll container could not move').toBe(true);
    expect(metrics.reachedBottom, 'Research Center scroll container could not reach bottom').toBe(true);
    expect(blocked, 'Research Center QA attempted a blocked mutation').toEqual([]);
    expect(runtimeFailures, 'Research Center browser/runtime failures detected').toEqual([]);
    if (strictResearchQa) {
      const directory = path.resolve('production-research-artifacts');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(path.join(directory, `${test.info().project.name}-coverage.json`), JSON.stringify({
        schemaVersion: 'research-production-browser-coverage-v1',
        appSha: process.env.EXPECTED_DEPLOY_SHA,
        researchSha: process.env.RESEARCH_TARGET_SHA,
        project: test.info().project.name,
        actualResearchAccess: true,
        views: ['요약', '연구', '검증', '모의매매', 'AI', '영상'],
        horizontalOverflowPx: metrics.horizontalOverflowPx,
        scrollReachedBottom: metrics.reachedBottom,
        blockedMutationCount: blocked.length,
        runtimeFailureCount: runtimeFailures.length,
        criticalHttpFailureCount: criticalHttpFailures.length,
        providerPrivateRequests: 0,
        rawScreenshotsRetained: false,
      }) + '\n', { mode: 0o600, flag: 'wx' });
    }
  });
});
