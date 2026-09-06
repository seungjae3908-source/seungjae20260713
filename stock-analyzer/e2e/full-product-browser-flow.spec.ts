import type { Page, Route } from '@playwright/test';
import { expect, test } from './support/full-product-evidence';
import { ageBrowserSession, installFullProductFixtures } from './support/full-product-fixtures';

async function openMenuItem(page: Page, group: string, item: string) {
  const trigger = page.getByRole('button', { name: group, exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menuItem = page.getByRole('menuitem', { name: item, exact: true });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
}

async function loginThroughUi(page: Page) {
  await page.goto('/login');
  const loginName = page.getByLabel('아이디');
  const loginPassword = page.getByLabel('비밀번호');
  await expect(loginName).toBeVisible();
  await loginName.fill('full-product-e2e');
  await loginPassword.fill('Browser-E2E-911!');
  await page.locator('form').getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '주요 메뉴' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: '계정', exact: true })).toBeVisible();
}

function searchResult(query: string) {
  const apple = /aapl|apple/iu.test(query);
  return {
    id: apple ? 'US:AAPL' : 'KR:005930',
    assetType: 'stock',
    market: apple ? 'US' : 'KR',
    instrumentType: 'stock',
    exchange: apple ? 'NASDAQ' : 'KRX',
    ticker: apple ? 'AAPL' : '005930',
    productCode: apple ? 'AAPL' : '005930',
    koreanName: apple ? '애플' : '삼성전자',
    englishName: apple ? 'Apple' : 'Samsung Electronics',
    displayName: apple ? 'Apple' : '삼성전자',
    baseSymbol: apple ? 'AAPL' : '005930',
    quoteCurrency: apple ? 'USD' : 'KRW',
    matchType: 'exact',
    active: true,
    provider: 'e2e-fixture',
    dataAsOf: '2026-09-05T10:00:00.000Z',
  };
}

function searchEnvelope(query: string, results = [searchResult(query)]) {
  const dataAsOf = '2026-09-05T10:00:00.000Z';
  return {
    ok: true,
    state: results.length ? 'FULL' : 'EMPTY',
    q: query,
    asset: 'all',
    market: null,
    results,
    count: results.length,
    dataAsOf,
    stale: false,
    partial: false,
    providers: [{ provider: 'e2e-fixture', status: 'ok', count: results.length, dataAsOf }],
    hiddenMatches: [],
  };
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function expectSearchOutcome(page: Page, query: string, expected: RegExp) {
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('');
  await input.fill(query);
  await expect(page.getByTestId('unified-search-outcome')).toContainText(expected, { timeout: 7_000 });
}

test('real user path stays coherent from login through session expiry', async ({ page }) => {
  const fixtures = await installFullProductFixtures(page);

  await loginThroughUi(page);

  await openMenuItem(page, '종목', '통합검색');
  await expect(page).toHaveURL(/\/stocks$/u);
  await expect(page.getByTestId('unified-asset-search-page')).toBeVisible();
  const search = page.getByRole('combobox', { name: '통합 자산 검색' });
  await search.fill('삼성전자');
  const samsung = page.getByRole('option').filter({ hasText: '삼성전자' }).first();
  await expect(samsung).toBeVisible();
  await expect(samsung).toContainText('005930');

  await openMenuItem(page, '기술', 'AI 차트');
  await expect(page).toHaveURL(/\/ai-chart/u);
  await expect(page.getByTestId('ai-chart-empty-selection')).toBeVisible();
  await expect(page.getByTestId('ai-chart-empty-selection')).toContainText('분석할 종목이 선택되지 않았습니다.');
  await expect(page.getByTestId('unified-chart-canvas')).toHaveCount(0);

  await openMenuItem(page, '설정', '계정');
  await expect(page).toHaveURL(/\/account$/u);
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await expect(page.getByTestId('connection-toss')).toContainText('연결됨');
  await expect(page.getByTestId('connection-upbit')).toContainText('연결됨');
  await expect(page.getByTestId('connection-bitget')).toContainText('연결됨');
  await expect(page.getByTestId('brokerage-account-connections')).toContainText('실주문/취소/이체/출금 0건');

  await openMenuItem(page, '정보', '포트폴리오');
  await expect(page).toHaveURL(/\/portfolio$/u);
  await expect(page.getByRole('heading', { name: '포트폴리오', exact: true })).toBeVisible();
  await expect(page.getByTestId('portfolio-data-quality')).toContainText('일부 데이터');

  await openMenuItem(page, '기술', '모의매매');
  await expect(page).toHaveURL(/\/paper-trading$/u);
  await expect(page.getByTestId('paper-trading-shell')).toBeVisible();

  await openMenuItem(page, '정보', '연구센터');
  await expect(page).toHaveURL(/\/research-center$/u);
  await expect(page.getByRole('navigation', { name: '연구센터 작업 영역' })).toBeVisible();
  await expect(page.getByTestId('research-overview-tab')).toBeVisible();
  await expect(page.getByText('수익성 검증', { exact: true })).toBeVisible();
  await expect(page.getByText('미검증', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(/\/research-center$/u);
  await expect(page.getByTestId('research-overview-tab')).toBeVisible();

  await openMenuItem(page, '정보', '포트폴리오');
  await expect(page.getByRole('heading', { name: '포트폴리오', exact: true })).toBeVisible();

  fixtures.expireSession();
  await ageBrowserSession(page);
  await page.reload();
  await expect(page.getByLabel('아이디')).toBeVisible();
  await expect(page.getByRole('heading', { name: '포트폴리오', exact: true })).toHaveCount(0);
  await expect(page.getByTestId('portfolio-data-quality')).toHaveCount(0);
});

test('search fault matrix fails closed and latest response wins without leaking across navigation', async ({ page }, testInfo) => {
  await installFullProductFixtures(page);
  await loginThroughUi(page);
  await openMenuItem(page, '종목', '통합검색');
  await expect(page.getByTestId('unified-asset-search-page')).toBeVisible();

  const pattern = '**/api/search/suggest?**';
  const matrix: Array<{
    name: string;
    expected: RegExp;
    handler: (route: Route) => Promise<unknown>;
  }> = [
    { name: 'null', expected: /DATA_UNAVAILABLE/u, handler: (route) => json(route, null) },
    { name: 'abort', expected: /DATA_UNAVAILABLE/u, handler: (route) => route.abort('failed') },
    {
      name: 'timeout',
      expected: /DATA_UNAVAILABLE/u,
      handler: async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 5_200));
        return route.abort('timedout').catch(() => undefined);
      },
    },
    { name: '401', expected: /DATA_UNAVAILABLE/u, handler: (route) => json(route, { error: 'UNAUTHORIZED' }, 401) },
    { name: '403', expected: /DATA_UNAVAILABLE/u, handler: (route) => json(route, { error: 'FORBIDDEN' }, 403) },
    { name: '429', expected: /DATA_UNAVAILABLE/u, handler: (route) => json(route, { error: 'RATE_LIMITED' }, 429) },
    { name: '500', expected: /DATA_UNAVAILABLE/u, handler: (route) => json(route, { error: 'UPSTREAM_ERROR' }, 500) },
    {
      name: 'provider-unavailable',
      expected: /PROVIDER_UNAVAILABLE/u,
      handler: async (route) => {
        const query = new URL(route.request().url()).searchParams.get('q') ?? '';
        return json(route, {
          ...searchEnvelope(query, []),
          state: 'DEGRADED',
          partial: true,
          providers: [{ provider: 'krx', status: 'error', count: 0, dataAsOf: null, message: 'provider unavailable' }],
        });
      },
    },
  ];

  const results: Array<{ scenario: string; terminal: string }> = [];
  for (const scenario of matrix) {
    await page.route(pattern, scenario.handler);
    const query = `fault-${scenario.name}-${Date.now()}`;
    await expectSearchOutcome(page, query, scenario.expected);
    results.push({ scenario: scenario.name, terminal: await page.getByTestId('unified-search-outcome').innerText() });
    await page.unroute(pattern, scenario.handler);
  }

  let requestNumber = 0;
  const staleRace = async (route: Route) => {
    requestNumber += 1;
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    await new Promise((resolve) => setTimeout(resolve, requestNumber % 2 === 1 ? 900 : 40));
    return json(route, searchEnvelope(query));
  };
  await page.route(pattern, staleRace);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('삼성전자');
  await page.waitForTimeout(260);
  await input.fill('AAPL');
  await expect(page.getByRole('option').filter({ hasText: 'Apple' }).first()).toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole('option').filter({ hasText: '삼성전자' })).toHaveCount(0);
  results.push({ scenario: 'stale-race', terminal: 'latest-response-wins' });
  await page.unroute(pattern, staleRace);

  const delayedUnmount = async (route: Route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    await new Promise((resolve) => setTimeout(resolve, 900));
    return json(route, searchEnvelope(query)).catch(() => undefined);
  };
  await page.route(pattern, delayedUnmount);
  await input.fill('삼성전자');
  await page.waitForTimeout(260);
  await openMenuItem(page, '설정', '계정');
  await expect(page).toHaveURL(/\/account$/u);
  await expect(page.getByTestId('brokerage-account-connections')).toBeVisible();
  await page.waitForTimeout(1_000);
  results.push({ scenario: 'unmount', terminal: 'navigation-remained-coherent' });
  await page.unroute(pattern, delayedUnmount);

  await testInfo.attach('full-product-fault-matrix.json', {
    body: Buffer.from(JSON.stringify({
      covered: ['null', 'timeout', 'abort', 'stale-response', '401', '403', '429', '500', 'provider-unavailable', 'unmount', 'race-condition'],
      results,
    }, null, 2)),
    contentType: 'application/json',
  });
});
