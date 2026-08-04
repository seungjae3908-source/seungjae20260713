import { expect, test, type Page, type Route } from '@playwright/test';

const NOW = '2026-08-05T00:00:00.000Z';

function fulfill(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
}

type Diagnostics = {
  assertClean: () => void;
  forbiddenRequests: string[];
};

async function mockInformationApi(page: Page, options: { delayKrMovers?: number } = {}): Promise<Diagnostics> {
  const errors: string[] = [];
  const forbiddenRequests: string[] = [];
  const unexpectedHttp: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console:${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`page:${error.message}`));
  page.on('requestfailed', (request) => {
    const reason = request.failure()?.errorText ?? '';
    if (!reason.includes('ERR_ABORTED')) errors.push(`request:${request.method()} ${request.url()} ${reason}`);
  });
  page.on('response', (response) => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      unexpectedHttp.push(`${response.status()} ${response.url()}`);
    }
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (/\/(accounts?|positions?|orders?|auto)(\/|$)|\/trade-automation(\/|$)/i.test(path)) {
      forbiddenRequests.push(`${route.request().method()} ${path}`);
      return fulfill(route, { ok: false, error: 'FORBIDDEN_TEST_REQUEST' }, 500);
    }

    if (path === '/api/market/home') {
      return fulfill(route, {
        ok: true,
        updatedAt: NOW,
        indices: [
          { key: 'KOSPI', label: '코스피', price: 3123.45, changePercent: 0.8, provider: 'Yahoo Finance', updatedAt: NOW },
          { key: 'KOSDAQ', label: '코스닥', price: 912.34, changePercent: -0.3, provider: 'Yahoo Finance', updatedAt: NOW },
          { key: 'NASDAQ', label: '나스닥', price: 22345.67, changePercent: 1.1, provider: 'Yahoo Finance', updatedAt: NOW },
        ],
      });
    }

    if (path === '/api/market/movers') {
      const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
      if (market === 'KR' && options.delayKrMovers) {
        await new Promise((resolve) => setTimeout(resolve, options.delayKrMovers));
      }
      const rows = market === 'US'
        ? [{ ticker: 'AAPL', name: 'Apple Inc.', market: 'US', currency: 'USD', price: 240, changePercent: 1.2, volume: 500000, tradingValue: 120000000, marketCap: 3500000000000 }]
        : [{ ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW', price: 78000, changePercent: 0.7, volume: 700000, tradingValue: 54000000000, marketCap: 465000000000000 }];
      return fulfill(route, {
        market,
        provider: 'test-public-market',
        popular: rows,
        volume: rows,
        gainers: rows,
        losers: rows,
        updatedAt: NOW,
      });
    }

    if (path === '/api/market/sector-popular') {
      const market = url.searchParams.get('market') === 'US' ? 'US' : 'KR';
      return fulfill(route, {
        market,
        sectors: [{ name: market === 'US' ? 'Technology' : '반도체', tradingValue: 123000000, changePercent: 0.9 }],
        updatedAt: NOW,
      });
    }

    if (path === '/api/search') {
      return fulfill(route, {
        results: [
          { ticker: '005930', name: '삼성전자', market: 'KR', currency: 'KRW' },
          { ticker: 'AAPL', name: 'Apple Inc.', market: 'US', currency: 'USD' },
        ],
        count: 2,
        updatedAt: NOW,
      });
    }

    if (path === '/api/stocks/special-feed') {
      const asset = url.searchParams.get('asset') ?? 'stock';
      const market = url.searchParams.get('market') ?? 'KR';
      if (asset === 'coin') {
        return fulfill(route, {
          ok: false,
          asset,
          market,
          items: [],
          count: 0,
          updatedAt: NOW,
          message: '코인 뉴스·정보 제공기관이 아직 연결되지 않았습니다.',
        });
      }
      return fulfill(route, {
        ok: true,
        asset,
        market,
        count: 2,
        updatedAt: NOW,
        items: [
          { id: `${market}-news`, kind: 'news', title: `${market} 시장 뉴스`, summary: '시장 공개 정보', source: '테스트뉴스', sourceAt: NOW, ticker: market === 'US' ? 'AAPL' : '005930', market },
          { id: `${market}-filing`, kind: 'disclosure', title: `${market} 공식 공시`, summary: '공식 공시 정보', source: market === 'US' ? 'SEC' : 'DART', sourceAt: NOW, ticker: market === 'US' ? 'AAPL' : '005930', market },
        ],
      });
    }

    if (path === '/api/crypto/spot/markets') {
      return fulfill(route, {
        exchange: 'UPBIT',
        count: 2,
        updatedAt: NOW,
        markets: [
          { market: 'KRW-BTC', symbol: 'BTC', koreanName: '비트코인', englishName: 'Bitcoin', warning: false },
          { market: 'KRW-ETH', symbol: 'ETH', koreanName: '이더리움', englishName: 'Ethereum', warning: false },
        ],
      });
    }

    if (path === '/api/crypto/spot/tickers') {
      return fulfill(route, {
        exchange: 'UPBIT',
        count: 2,
        updatedAt: NOW,
        tickers: [
          { market: 'KRW-BTC', symbol: 'BTC', price: 101000000, changePercent: 1.3, high24h: 102000000, low24h: 99000000, volume24h: 1234, tradingValue24h: 125000000000 },
          { market: 'KRW-ETH', symbol: 'ETH', price: 5200000, changePercent: -0.8, high24h: 5300000, low24h: 5100000, volume24h: 5432, tradingValue24h: 28000000000 },
        ],
      });
    }

    if (path === '/api/crypto/futures/tickers') {
      return fulfill(route, {
        ok: true,
        provider: 'bitget',
        exchange: 'BITGET',
        count: 2,
        updatedAt: NOW,
        tickers: [
          { symbol: 'BTCUSDT', price: 70000, changePercent24h: 0.6, high24h: 71000, low24h: 68000, volume24h: 100000, tradingValue24h: 7000000000, fundingRatePercent: 0.01, openInterest: 550000 },
          { symbol: 'ETHUSDT', price: 3800, changePercent24h: -1.1, high24h: 3900, low24h: 3700, volume24h: 200000, tradingValue24h: 760000000, fundingRatePercent: -0.005, openInterest: 330000 },
        ],
      });
    }

    if (path === '/api/notifications/price-alerts') return fulfill(route, { alerts: [] });
    if (path === '/api/watchlist/sync') return fulfill(route, { ok: true, items: [] });
    return fulfill(route, { ok: true });
  });

  return {
    forbiddenRequests,
    assertClean: () => {
      expect(errors, errors.join('\n')).toEqual([]);
      expect(unexpectedHttp, unexpectedHttp.join('\n')).toEqual([]);
      expect(forbiddenRequests, forbiddenRequests.join('\n')).toEqual([]);
    },
  };
}

async function openInformationMenu(page: Page) {
  await page.getByRole('button', { name: '정보', exact: true }).click();
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeVisible();
}

test('information popup closes by button, outside touch, and selection', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/stocks/kr');

  await openInformationMenu(page);
  await expect(page.getByText('주식', { exact: true })).toBeVisible();
  await expect(page.getByText('코인', { exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '국내', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '해외', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '현물', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '선물', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '정보 메뉴 닫기' }).click();
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();

  await openInformationMenu(page);
  await page.getByRole('heading', { name: '국내주식 정보' }).click();
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();

  await openInformationMenu(page);
  await page.getByRole('menuitem', { name: '해외', exact: true }).click();
  await expect(page).toHaveURL(/\/stocks\/us$/);
  await expect(page.getByRole('menu', { name: '정보 메뉴' })).toBeHidden();
  await expect(page.getByRole('heading', { name: '미국주식 정보' })).toBeVisible();
  diagnostics.assertClean();
});

test('all four market information routes support direct entry and refresh', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  const routes = [
    ['/stocks/kr', '국내주식 정보', 'KRX'],
    ['/stocks/us', '미국주식 정보', 'US'],
    ['/coins/spot', '코인 현물 정보', 'UPBIT'],
    ['/coins/futures', '코인 선물 정보', 'BITGET'],
  ] as const;

  for (const [path, title, exchange] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByText(new RegExp(`^${exchange} ·`)).first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
  }
  diagnostics.assertClean();
});

test('rapid KR to US change never applies the delayed KR ranking', async ({ page }) => {
  const diagnostics = await mockInformationApi(page, { delayKrMovers: 800 });
  await page.goto('/stocks/kr');
  await openInformationMenu(page);
  await page.getByRole('menuitem', { name: '해외', exact: true }).click();
  await expect(page.getByText('애플', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(1000);
  await expect(page.getByText('애플', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('삼성전자', { exact: true })).toHaveCount(0);
  diagnostics.assertClean();
});

test('spot and futures information stay separated and send no private API requests', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  await page.goto('/coins/spot');
  await expect(page.getByText('비트코인', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/펀딩/)).toHaveCount(0);
  await expect(page.getByText(/미결제약정/)).toHaveCount(0);
  await expect(page.getByText('코인 뉴스·정보 제공기관이 아직 연결되지 않았습니다.')).toBeVisible();

  await page.goto('/coins/futures');
  await expect(page.getByText('BTCUSDT', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/펀딩 0.01%/).first()).toBeVisible();
  await expect(page.getByText(/OI 550,000/).first()).toBeVisible();
  await expect(page.getByText('제공기관 미지원', { exact: true }).first()).toBeVisible();
  diagnostics.assertClean();
});

test('search results never cross the selected market', async ({ page }) => {
  const diagnostics = await mockInformationApi(page);
  await page.goto('/stocks/kr');
  await page.getByRole('textbox', { name: '국내주식 정보 검색' }).fill('공통');
  await expect(page.getByText('삼성전자', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('애플', { exact: true })).toHaveCount(0);

  await page.goto('/stocks/us');
  await page.getByRole('textbox', { name: '미국주식 정보 검색' }).fill('common');
  await expect(page.getByText('애플', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('삼성전자', { exact: true })).toHaveCount(0);
  diagnostics.assertClean();
});
