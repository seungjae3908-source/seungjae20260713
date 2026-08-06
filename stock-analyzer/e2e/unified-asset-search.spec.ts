import { test, expect, type Page } from '@playwright/test';

const now = '2026-08-04T06:00:00.000Z';
const fixtures = [
  { id: 'stock:KR:KOSPI:005930', assetType: 'stock', market: 'KR', instrumentType: 'stock', exchange: 'KOSPI', ticker: '005930', productCode: '005930', koreanName: '삼성전자', englishName: 'Samsung Electronics', displayName: '삼성전자', baseSymbol: '005930', quoteCurrency: 'KRW', matchType: 'name_prefix', active: true, provider: 'KRX', dataAsOf: now },
  { id: 'stock:US:NASDAQ:TSLA', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'TSLA', productCode: 'TSLA', koreanName: '테슬라', englishName: 'Tesla', displayName: '테슬라', baseSymbol: 'TSLA', quoteCurrency: 'USD', matchType: 'name_prefix', active: true, provider: 'FINNHUB', dataAsOf: now },
  { id: 'stock:US:NASDAQ:TSLB', assetType: 'stock', market: 'US', instrumentType: 'stock', exchange: 'NASDAQ', ticker: 'TSLB', productCode: 'TSLB', koreanName: '테슬라 에너지', englishName: 'Tesla Energy', displayName: '테슬라 에너지', baseSymbol: 'TSLB', quoteCurrency: 'USD', matchType: 'name_prefix', active: true, provider: 'FINNHUB', dataAsOf: now },
  { id: 'coin:spot:UPBIT:KRW-BTC', assetType: 'coin', market: 'spot', instrumentType: 'spot', exchange: 'UPBIT', symbol: 'BTC', productCode: 'KRW-BTC', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', baseSymbol: 'BTC', quoteCurrency: 'KRW', matchType: 'alias', active: true, provider: 'UPBIT', dataAsOf: now },
  { id: 'coin:futures:BITGET:BTCUSDT', assetType: 'coin', market: 'futures', instrumentType: 'futures', exchange: 'BITGET', symbol: 'BTCUSDT', productCode: 'BTCUSDT', koreanName: '비트코인', englishName: 'Bitcoin', displayName: '비트코인', baseSymbol: 'BTC', quoteCurrency: 'USDT', matchType: 'code_exact', active: true, provider: 'BITGET', dataAsOf: now },
];

function matches(query: string) {
  if (!/[\p{L}\p{N}]/u.test(query.normalize('NFKC'))) return [];
  const q = query.toLowerCase().replace(/[\s/.-]/g, '');
  return fixtures.filter((item) => [item.displayName, item.englishName, item.productCode, item.ticker, item.symbol, item.baseSymbol]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().replace(/[\s/.-]/g, '').includes(q)));
}

async function mockSearch(page: Page) {
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    if (q === '오류') {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'SEARCH_INDEX_UNAVAILABLE', message: '검색 인덱스를 준비하지 못했습니다.' }) }).catch(() => undefined);
      return;
    }
    if (q === 't') await new Promise((resolve) => setTimeout(resolve, 500));
    const market = url.searchParams.get('market');
    const results = matches(q).filter((item) => !market || item.market === market);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        q,
        asset: url.searchParams.get('asset') ?? 'all',
        market,
        results,
        count: results.length,
        dataAsOf: now,
        stale: false,
        partial: false,
        providers: [],
        hiddenMatches: market && matches(q).some((item) => item.market !== market)
          ? [{ market: matches(q).find((item) => item.market !== market)?.market, count: 1 }]
          : [],
      }),
    }).catch(() => undefined);
  });
}

for (const [width, height] of [[360, 800], [390, 844], [430, 932], [1440, 900]] as const) {
  test(`unified search supports one-character results and no overflow at ${width}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await mockSearch(page);
    await page.goto('/__phase11-unified-search-e2e');
    const input = page.getByRole('combobox', { name: '통합 자산 검색' });
    await input.fill('삼');
    await expect(page.getByRole('option', { name: /삼성전자/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('latest request wins, keyboard selection works, and spot/futures stay separated', async ({ page }) => {
  await mockSearch(page);
  await page.goto('/__phase11-unified-search-e2e');
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('t');
  await input.fill('TSLA');
  await expect(page.getByRole('option', { name: /테슬라/ })).toBeVisible();
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/stock-info\?back=%2Fsearch&asset=stock&market=US&ticker=TSLA$/);

  await page.goto('/__phase11-unified-search-e2e');
  await input.fill('BTC');
  await expect(page.getByText('코인 현물', { exact: true })).toBeVisible();
  await expect(page.getByText('코인 선물', { exact: true })).toBeVisible();
  await expect(page.getByText('BTC/KRW', { exact: true })).toBeVisible();
  await expect(page.getByText('BTCUSDT', { exact: true })).toBeVisible();
  await input.press('Escape');
  await expect(page.getByRole('listbox', { name: '통합 자산 자동완성 결과' })).toBeHidden();
});

test('all asset groups navigate to their exact existing detail routes', async ({ page }) => {
  await mockSearch(page);

  const selectAndExpect = async (query: string, optionName: RegExp, expectedUrl: RegExp) => {
    await page.goto('/__phase11-unified-search-e2e');
    const input = page.getByRole('combobox', { name: '통합 자산 검색' });
    await input.fill(query);
    await page.getByRole('option', { name: optionName }).click();
    await expect(page).toHaveURL(expectedUrl);
  };

  await selectAndExpect('005930', /삼성전자.*005930/, /\/stock-info\?back=%2Fsearch&asset=stock&market=KR&ticker=005930$/);
  await selectAndExpect('TSLA', /테슬라.*TSLA/, /\/stock-info\?back=%2Fsearch&asset=stock&market=US&ticker=TSLA$/);
  await selectAndExpect('KRW-BTC', /비트코인.*UPBIT.*BTC\/KRW/, /\/stock-info\?back=%2Fsearch&asset=coin&coinMarket=spot&symbol=BTC$/);
  await selectAndExpect('BTCUSDT', /비트코인.*BITGET.*BTCUSDT/, /\/stock-info\?back=%2Fsearch&asset=coin&coinMarket=futures&symbol=BTCUSDT$/);
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
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'SEARCH_INDEX_UNAVAILABLE', message: '검색 인덱스를 준비하지 못했습니다.' }) }).catch(() => undefined);
      return;
    }
    const results = matches(q);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, q, asset: 'all', market: null, results, count: results.length, dataAsOf: now, stale: false, partial: false, providers: [], hiddenMatches: [] }) }).catch(() => undefined);
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
  await input.fill('오류');
  await expect(page.getByText('검색 인덱스를 준비하지 못했습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '재시도' })).toBeVisible();
});
