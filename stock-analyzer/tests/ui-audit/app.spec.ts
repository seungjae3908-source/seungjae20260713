import { test, expect, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';

const routes = [
  '/',
  '/stocks',
  '/search',
  '/scanner',
  '/stock-info',
  '/assets',
  '/settings',
  '/learn',
  '/watchlist',
  '/alerts',
  '/account',
  '/recommendations',
  '/stock/000100',
  '/stock/AAPL',
  '/stock/QQQ',
  '/stock/390390',
  '/stock/252670',
];

async function login(page: Page) {
  const loginName = process.env.UI_TEST_LOGIN;
  const password = process.env.UI_TEST_PASSWORD;

  if (!loginName || !password) {
    throw new Error('UI_TEST_LOGIN 또는 UI_TEST_PASSWORD가 없습니다.');
  }

  await page.goto('/account', { waitUntil: 'domcontentloaded' });

  const logout = page.getByRole('button', { name: '로그아웃' });
  if ((await logout.count()) > 0) return;

  const username = page.locator('input[autocomplete="username"]');
  await username.waitFor({ state: 'visible', timeout: 20_000 });
  await username.fill(loginName);
  await page.locator('input[autocomplete="current-password"]').fill(password);
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click();

    await expect(
      page.locator('input[autocomplete="username"]'),
    ).toBeHidden({ timeout: 20_000 });
}

async function runAudit(
  page: Page,
  testInfo: TestInfo,
  deviceName: string,
) {
  const issues: string[] = [];
  const results: Array<Record<string, unknown>> = [];
  let currentRoute = '';

  page.on('pageerror', (error) => {
    issues.push(`${currentRoute}: 브라우저 예외 - ${error.message}`);
  });

  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /TypeError|ReferenceError|Unhandled|Cannot read|is not a function|Failed to fetch/i.test(
        message.text(),
      )
    ) {
      issues.push(`${currentRoute}: 콘솔 오류 - ${message.text()}`);
    }
  });

  page.on('response', (response) => {
    if (response.status() >= 500) {
      issues.push(
        `${currentRoute}: HTTP ${response.status()} - ${response.url()}`,
      );
    }
  });

  await login(page);

  for (const route of routes) {
    currentRoute = route;

    const response = await page.goto(route, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    await page.waitForTimeout(1_500);

    const bodyText = await page.locator('body').innerText().catch(() => '');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 3,
    );

    if (!bodyText.trim()) {
      issues.push(`${route}: 화면 내용이 비어 있음`);
    }

    if (overflow) {
      issues.push(`${route}: 화면 가로 넘침 발생`);
    }

    if (
      /Application error|Something went wrong|페이지를 표시할 수 없습니다/i.test(
        bodyText,
      )
    ) {
      issues.push(`${route}: 오류 화면 표시`);
    }

    if (
      route === '/stock/QQQ' &&
      /Invesco QQQ Trust/i.test(bodyText) &&
      /보통주/.test(bodyText)
    ) {
      issues.push('/stock/QQQ: ETF가 보통주로 표시됨');
    }

    const filename =
      route === '/'
        ? 'home'
        : route.replace(/^\/+/, '').replaceAll('/', '__');

    await page.screenshot({
      path: testInfo.outputPath(
        'screenshots',
        deviceName,
        `${filename}.png`,
      ),
      fullPage: false,
    });

    results.push({
      route,
      status: response?.status() ?? null,
      overflow,
      title: await page.title(),
    });
  }

  const summaryPath = testInfo.outputPath(`summary-${deviceName}.json`);
  fs.writeFileSync(
    summaryPath,
    JSON.stringify({ deviceName, results, issues }, null, 2),
  );

  await testInfo.attach(`summary-${deviceName}`, {
    path: summaryPath,
    contentType: 'application/json',
  });

  expect(issues, issues.join('\n')).toEqual([]);
}

test('PC UI 전체 자동검수', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await runAudit(page, testInfo, 'pc');
});

test('모바일 UI 전체 자동검수', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await runAudit(page, testInfo, 'mobile');
});
