import { test, expect, type Page } from '@playwright/test';

const now = '2026-08-04T06:00:00.000Z';
const fixtures = [
  { id: 'stock:KR:KOSPI:005930', assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', baseSymbol: '005930', quoteCurrency: 'KRW', matchType: 'name_prefix', active: true, provider: 'KRX', dataAsOf: now },
  { id: 'stock:US:NASDAQ:AAPL', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'AAPL', productCode: 'AAPL', koreanName: '애플', englishName: 'Apple', displayName: '애플', baseSymbol: 'AAPL', quoteCurrency: 'USD', matchType: 'code_exact', active: true, provider: 'FINNHUB', dataAsOf: now },
  { id: 'stock:US:NASDAQ:TSLA', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'TSLA', productCode: 'TSLA', koreanName: '테슬라', englishName: 'Tesla', displayName: '테슬라', baseSymbol: 'TSLA', quoteCurrency: 'USD', matchType: 'name_prefix', active: true, provider: 'FINNHUB', dataAsOf: now },
  { id: 'stock:US:NASDAQ:TSLB', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'TSLB', productCode: 'TSLB', koreanName: '테슬라 에너지', englishName: 'Tesla Energy', displayName: '테슬라 에너지', baseSymbol: 'TSLB', quoteCurrency: 'USD', matchType: 'name_prefix', active: true, provider: 'FINNHUB', dataAsOf: now },
  { id: 'coin:spot:UPBIT:KRW-BTC', assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', baseSymbol: 'BTC', quoteCurrency: 'KRW', matchType: 'alias', active: true, provider: 'UPBIT', dataAsOf: now },
  { id: 'coin:futures:BITGET:BTCUSDT', assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', baseSymbol: 'BTC', quoteCurrency: 'USDT', matchType: 'code_exact', active: true, provider: 'BITGET', dataAsOf: now },
] as const;

function matches(query: string) {
  if (!/[\p{L}\p{N}]/u.test(query.normalize('NFKC'))) return [];
  const q = query.toLowerCase().replace(/[\s/.-]/g, '');
  return fixtures.filter((item) => [item.displayName, item.englishName, item.productCode, 'ticker' in item ? item.ticker : '', 'symbol' in item ? item.symbol : '', item.baseSymbol]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().replace(/[\s/.-]/g, '').includes(q)));
}

function responseFor(query: string, market: string | null, asset = 'all') {
  const results = matches(query).filter((item) => !market || item.market === market);
  const otherMarket = market ? matches(query).find((item) => item.market !== market)?.market : undefined;
  return {
    ok: true,
    state: results.length ? 'FULL' : 'EMPTY',
    q: query,
    asset,
    market,
    results,
    count: results.length,
    dataAsOf: now,
    stale: false,
    partial: false,
    providers: [],
    hiddenMatches: otherMarket ? [{ market: otherMarket, count: 1 }] : [],
  };
}

async function mockSearch(page: Page) {
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    if (q === '오류') {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, state: 'ERROR', error: 'SEARCH_INDEX_UNAVAILABLE', message: '검색 인덱스를 준비하지 못했습니다.' }),
      }).catch(() => undefined);
      return;
    }
    if (q === 't') await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responseFor(q, url.searchParams.get('market'), url.searchParams.get('asset') ?? 'all')),
    }).catch(() => undefined);
  });
}

for (const [width, height] of [[320, 760], [360, 800], [390, 844], [412, 915], [430, 932], [1440, 900]] as const) {
  test(`unified search uses one input and has no overflow at ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mockSearch(page);
    await page.goto('/__phase11-unified-search-e2e');
    await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toHaveCount(1);
    await page.getByRole('combobox', { name: '통합 자산 검색' }).fill('삼');
    await expect(page.getByRole('option', { name: /삼성전자/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('latest request wins, keyboard selection opens clean stock detail, and spot/futures remain distinct', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('t');
  await input.fill('TSLA');
  await expect(page.getByRole('option', { name: /테슬라/ }).first()).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fsearch&asset=stock&market=US&ticker=TSLA$/);

  await page.goto('/__phase11-unified-search-e2e');
  const nextInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await nextInput.fill('BTC');
  await expect(page.getByRole('option', { name: /UPBIT.*BTC\/KRW/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /BITGET.*BTCUSDT/ })).toBeVisible();
  await nextInput.press('Escape');
  await expect(page.getByRole('listbox', { name: '통합 자산 자동완성 결과' })).toBeHidden();
});

test('market tabs narrow the single search without creating another search input', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/__phase11-unified-search-e2e');
  await page.getByRole('button', { name: '코인 현물', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toHaveCount(1);
  await page.getByRole('combobox', { name: '통합 자산 검색' }).fill('BTC');
  await expect(page.getByRole('option', { name: /UPBIT.*BTC\/KRW/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /BITGET.*BTCUSDT/ })).toHaveCount(0);
});

test('all asset groups navigate to canonical detail routes', async ({ page }) => {
  await mockSearch(page);

  const selectAndExpect = async (query: string, optionName: RegExp, expectedUrl: RegExp) => {
    await page.goto('/__phase11-unified-search-e2e');
    const input = page.getByRole('combobox', { name: '통합 자산 검색' });
    await input.fill(query);
    await page.getByRole('option', { name: optionName }).click();
    await expect(page).toHaveURL(expectedUrl);
  };

  await selectAndExpect('005930', /삼성전자.*005930/, /\/stock-info\/analysis\?back=%2Fsearch&asset=stock&market=KR&ticker=005930$/);
  await selectAndExpect('AAPL', /애플.*AAPL/, /\/stock-info\/analysis\?back=%2Fsearch&asset=stock&market=US&ticker=AAPL$/);
  await selectAndExpect('KRW-BTC', /비트코인.*UPBIT.*BTC\/KRW/, /\/stock-info\?back=%2Fsearch&asset=coin&coinMarket=spot&symbol=BTC$/);
  await selectAndExpect('BTCUSDT', /비트코인.*BITGET.*BTCUSDT/, /\/stock-info\?back=%2Fsearch&asset=coin&coinMarket=futures&symbol=BTCUSDT$/);
});

test('real symbol and name queries resolve the same canonical assets', async ({ page }) => {
  await mockSearch(page);
  const cases: Array<{ query: string; option: RegExp; code: string }> = [
    { query: '005930', option: /삼성전자.*005930/, code: '005930' },
    { query: 'Samsung', option: /삼성전자.*005930/, code: '005930' },
    { query: 'AAPL', option: /애플.*AAPL/, code: 'AAPL' },
    { query: 'Apple', option: /애플.*AAPL/, code: 'AAPL' },
    { query: 'BTC', option: /비트코인.*UPBIT.*BTC\/KRW/, code: 'BTC/KRW' },
    { query: 'KRW-BTC', option: /비트코인.*UPBIT.*BTC\/KRW/, code: 'BTC/KRW' },
    { query: 'BTCUSDT', option: /비트코인.*BITGET.*BTCUSDT/, code: 'BTCUSDT' },
  ];
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  for (const item of cases) {
    await input.fill(item.query);
    await expect(page.getByRole('option', { name: item.option })).toBeVisible();
    await expect(page.getByText(item.code, { exact: true }).first()).toBeVisible();
  }
});

test('search distinguishes NO_MATCH, PROVIDER_UNAVAILABLE, and DATA_UNAVAILABLE', async ({ page }) => {
  await page.route('**/api/search/suggest**', async (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    if (q === 'data-down') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, state: 'ERROR', error: 'SEARCH_INDEX_UNAVAILABLE', message: '검색 데이터가 없습니다.' }) });
      return;
    }
    const providerDown = q === 'provider-down';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true,
      state: providerDown ? 'DEGRADED' : 'EMPTY',
      q,
      asset: 'all',
      market: null,
      results: [],
      count: 0,
      dataAsOf: now,
      stale: providerDown,
      partial: providerDown,
      providers: providerDown ? [{ provider: 'upbit', status: 'error', count: 0, dataAsOf: null }] : [],
      hiddenMatches: [],
    }) });
  });
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('no-match');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('NO_MATCH');
  await input.fill('provider-down');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('PROVIDER_UNAVAILABLE');
  await input.fill('data-down');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('DATA_UNAVAILABLE');
});

test('watchlist and recent searches prioritize equal-tier suggestions', async ({ page }) => {
  await page.addInitScript(({ recent, watchlist }) => {
    window.localStorage.setItem('unified-asset-search:recent:v1', JSON.stringify(recent));
    window.localStorage.setItem('seungjae_watchlist_v1', JSON.stringify(watchlist));
  }, {
    recent: [fixtures.find((item) => item.id === 'stock:US:NASDAQ:TSLA')],
    watchlist: [{ ticker: 'TSLB', name: '테슬라 에너지', market: 'US' }],
  });
  await mockSearch(page);
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('테');
  const options = page.getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText('TSLB');
  await expect(options.nth(1)).toContainText('TSLA');
});

test('IME composition defers search, touch selection navigates, and errors can retry', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/search/suggest**', async (route) => {
    calls += 1;
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    if (q === '오류') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, state: 'ERROR', error: 'SEARCH_INDEX_UNAVAILABLE', message: '검색 인덱스를 준비하지 못했습니다.' }) }).catch(() => undefined);
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(responseFor(q, null)) }).catch(() => undefined);
  });
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.dispatchEvent('compositionstart');
  await input.fill('비');
  await page.waitForTimeout(300);
  expect(calls).toBe(0);
  await input.dispatchEvent('compositionend');
  await expect(page.getByRole('option', { name: /비트코인/ }).first()).toBeVisible();
  await page.getByRole('option', { name: /비트코인.*UPBIT/ }).click();
  await expect(page).toHaveURL(/coinMarket=spot/);

  await page.goto('/__phase11-unified-search-e2e');
  const errorInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await errorInput.fill('오류');
  await expect(page.getByText('검색 인덱스를 준비하지 못했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '재시도' })).toBeVisible();
});

test('search browser diagnostics remain zero on a healthy flow', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedSearchResponses: string[] = [];
  const privateRequests: string[] = [];

  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    if (response.url().includes('/api/search/suggest') && response.status() >= 400) failedSearchResponses.push(`${response.status()}:${response.url()}`);
  });
  page.on('request', (request) => {
    if (/\/api\/(?:trade|orders?|account|broker|exchange)\b/i.test(new URL(request.url()).pathname)) privateRequests.push(request.url());
  });

  await mockSearch(page);
  await page.goto('/__phase11-unified-search-e2e');
  await page.getByRole('combobox', { name: '통합 자산 검색' }).fill('AAPL');
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedSearchResponses).toEqual([]);
  expect(privateRequests).toEqual([]);
});
