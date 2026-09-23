import { expect, test, type Route } from '@playwright/test';

function searchResponse(query: string, displayName: string, ticker: string) {
  const dataAsOf = new Date().toISOString();
  return {
    ok: true,
    state: 'FULL',
    q: query,
    asset: 'all',
    market: null,
    results: [{
      id: `stock:US:NASDAQ:${ticker}`,
      assetType: 'stock',
      market: 'US',
      instrumentType: 'stock',
      exchange: 'NASDAQ',
      ticker,
      productCode: ticker,
      koreanName: displayName,
      englishName: displayName,
      displayName,
      baseSymbol: ticker,
      quoteCurrency: 'USD',
      matchType: 'name_prefix',
      active: true,
      provider: 'FINNHUB',
      dataAsOf,
    }],
    count: 1,
    dataAsOf,
    stale: false,
    partial: false,
    providers: [{ provider: 'finnhub', status: 'ok', count: 1, dataAsOf }],
    hiddenMatches: [],
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

test('changing the query aborts an in-flight manual retry before stale results can render', async ({ page }) => {
  let staleCalls = 0;
  let releaseRetry!: () => void;
  let markRetryStarted!: () => void;
  const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve; });
  const retryStarted = new Promise<void>((resolve) => { markRetryStarted = resolve; });

  await page.route('**/api/search/suggest**', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';

    if (query === 'stale') {
      staleCalls += 1;
      if (staleCalls === 1) {
        await fulfillJson(route, {
          ok: false,
          state: 'ERROR',
          error: 'SEARCH_INDEX_UNAVAILABLE',
          message: '검색 인덱스를 준비하지 못했습니다.',
        }, 503);
        return;
      }

      markRetryStarted();
      await retryGate;
      await fulfillJson(route, searchResponse('stale', '이전검색결과', 'OLD'));
      return;
    }

    if (query === 'fresh') {
      await fulfillJson(route, searchResponse('fresh', '새검색결과', 'NEW'));
      return;
    }

    await fulfillJson(route, searchResponse(query, '기타검색결과', 'OTHER'));
  });

  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('stale');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('DATA_UNAVAILABLE');
  await page.getByRole('button', { name: '재시도' }).click();
  await retryStarted;

  await input.fill('fresh');
  releaseRetry();

  await page.waitForTimeout(100);
  await expect(page.getByRole('option', { name: /이전검색결과/ })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /새검색결과/ })).toBeVisible();
});
