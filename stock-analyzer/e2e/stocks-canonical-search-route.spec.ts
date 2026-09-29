import { test, expect, type Page } from '@playwright/test';

const now = new Date().toISOString();

const krSamsung = {
  id: 'stock:KR:KOSPI:005930',
  assetType: 'stock',
  market: 'KR',
  instrumentType: 'stock',
  exchange: 'KOSPI',
  ticker: '005930',
  productCode: '005930',
  koreanName: '삼성전자',
  englishName: 'Samsung Electronics',
  displayName: '삼성전자',
  baseSymbol: '005930',
  quoteCurrency: 'KRW',
  matchType: 'code_exact',
  active: true,
  provider: 'KRX',
  dataAsOf: now,
} as const;

const usApple = {
  id: 'stock:US:NASDAQ:AAPL',
  assetType: 'stock',
  market: 'US',
  instrumentType: 'stock',
  exchange: 'NASDAQ',
  ticker: 'AAPL',
  productCode: 'AAPL',
  koreanName: '애플',
  englishName: 'Apple',
  displayName: '애플',
  baseSymbol: 'AAPL',
  quoteCurrency: 'USD',
  matchType: 'code_exact',
  active: true,
  provider: 'FINNHUB',
  dataAsOf: now,
} as const;

const spotBitcoin = {
  id: 'coin:spot:UPBIT:KRW-BTC',
  assetType: 'coin',
  market: 'spot',
  instrumentType: 'spot',
  exchange: 'UPBIT',
  symbol: 'BTC',
  productCode: 'KRW-BTC',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  displayName: '비트코인',
  baseSymbol: 'BTC',
  quoteCurrency: 'KRW',
  matchType: 'code_exact',
  active: true,
  provider: 'UPBIT',
  dataAsOf: now,
} as const;

const futuresBitcoin = {
  id: 'coin:futures:BITGET:BTCUSDT',
  assetType: 'coin',
  market: 'futures',
  instrumentType: 'futures',
  exchange: 'BITGET',
  symbol: 'BTCUSDT',
  productCode: 'BTCUSDT',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  displayName: '비트코인',
  baseSymbol: 'BTC',
  quoteCurrency: 'USDT',
  matchType: 'code_exact',
  active: true,
  provider: 'BITGET',
  dataAsOf: now,
} as const;

type SearchRequest = { q: string; asset: string | null; market: string | null };

function successfulResponse(q: string, asset: string, market: string | null, results: readonly unknown[]) {
  const dataAsOf = new Date().toISOString();
  return {
    ok: true,
    state: results.length ? 'FULL' : 'EMPTY',
    q,
    asset,
    market,
    results: results.map((result) => ({ ...(result as object), dataAsOf })),
    count: results.length,
    dataAsOf,
    stale: false,
    partial: false,
    providers: [
      { provider: 'krx', status: 'ok', count: 1, dataAsOf },
      { provider: 'finnhub', status: 'ok', count: 1, dataAsOf },
      { provider: 'upbit', status: 'ok', count: 1, dataAsOf },
      { provider: 'bitget', status: 'ok', count: 1, dataAsOf },
    ],
    hiddenMatches: [],
  };
}

async function expectLatestRequest(requests: SearchRequest[], expected: SearchRequest) {
  await expect.poll(() => requests.at(-1)).toEqual(expected);
}

async function expectRequestStarted(requests: SearchRequest[], expected: SearchRequest) {
  await expect.poll(() => requests.some((request) => (
    request.q === expected.q
      && request.asset === expected.asset
      && request.market === expected.market
  ))).toBe(true);
}

async function installAuthenticatedUser(page: Page) {
  await page.addInitScript(() => {
    const timestamp = new Date().toISOString();
    window.localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: 'stocks-canonical-search-e2e-access-token',
      refresh_token: 'stocks-canonical-search-e2e-refresh-token',
      expires_in: 60 * 60,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      token_type: 'bearer',
      user: {
        id: 'stocks-canonical-search-e2e-user',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'stocks-canonical-search-e2e@accounts.seungjae-stock.com',
        email_confirmed_at: timestamp,
        phone: '',
        confirmed_at: timestamp,
        last_sign_in_at: timestamp,
        app_metadata: { provider: 'email', providers: ['email'] },
        user_metadata: {},
        identities: [],
        created_at: timestamp,
        updated_at: timestamp,
      },
    }));
  });

  await page.route('**/__e2e-supabase/rest/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/profiles')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'stocks-canonical-search-e2e-user',
          login_name: 'stocks-e2e',
          display_name: 'Stocks E2E',
          role: 'admin',
          status: 'approved',
          is_active: true,
          membership_level: 'admin',
          permissions_updated_at: now,
          updated_at: now,
        }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.route('**/__e2e-supabase/auth/v1/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function installNonSearchApiMocks(page: Page, options: { memberWatchlistItems?: unknown[] } = {}) {
  await page.route('**/api/backup/latest**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, exists: false, itemCount: 0, updatedAt: null }) });
  });
  await page.route('**/api/member-watchlist**', async (route) => {
    const items = options.memberWatchlistItems ?? [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, items, identitySource: 'AUTHENTICATED_MEMBER' }),
    });
  });
  await page.route('**/api/stocks/*/quote**', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const ticker = parts[3] ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticker, price: null, changePercent: null, dataAsOf: now }) });
  });
  await page.route('**/api/stocks/*/profile**', async (route) => {
    const parts = new URL(route.request().url()).pathname.split('/');
    const ticker = parts[3] ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ticker, name: ticker, market: ticker.length === 6 ? 'KR' : 'US' }) });
  });
  await page.route('**/api/market/recommendations**', async (route) => {
    const market = new URL(route.request().url()).searchParams.get('market') === 'US' ? 'US' : 'KR';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        provider: 'rule-based-engine',
        analysisMode: 'rule-based',
        aiConfigured: false,
        analysisDescription: '검색 경로 검증 fixture',
        market,
        generatedAt: now,
        rows: [],
        excludedCount: 0,
        excludedBreakdown: {},
        dataQualityNote: '검증 fixture',
      }),
    });
  });
}

async function openStocksPage(page: Page, options: { memberWatchlistItems?: unknown[] } = {}) {
  await installAuthenticatedUser(page);
  await installNonSearchApiMocks(page, options);
  await page.goto('/market-browser');
  await expect(page.getByTestId('stocks-shell')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toHaveCount(1);
}

test('desktop search selection opens factual preview without forcing navigation', async ({ page }) => {
  const requests: SearchRequest[] = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const request = {
      q: url.searchParams.get('q') ?? '',
      asset: url.searchParams.get('asset'),
      market: url.searchParams.get('market'),
    };
    requests.push(request);
    const results = request.market === 'KR' && request.q === '삼성전자' ? [krSamsung] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'stock', request.market, results)),
    });
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });
  await input.fill('삼성전자');
  await expectLatestRequest(requests, { q: '삼성전자', asset: 'stock', market: 'KR' });
  await page.getByRole('option', { name: /삼성전자.*005930/ }).click();

  await expect(page).toHaveURL(/\/market-browser$/u);
  const preview = page.getByTestId('stocks-preview-pane');
  await expect(preview).toBeVisible();
  await expect(preview).toContainText('삼성전자');
  await expect(preview).toContainText('005930');
  await expect(preview.getByRole('button', { name: '상세 보기', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'AI 차트', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '신호 보기', exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: '뉴스·공시', exact: true })).toBeVisible();
});

test('mobile search selection keeps direct-detail behavior', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    const market = url.searchParams.get('market');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(q, 'stock', market, q === '005930' ? [krSamsung] : [])),
    });
  });
  await openStocksPage(page);
  await page.getByRole('combobox', { name: '통합 자산 검색' }).fill('005930');
  await page.getByRole('option', { name: /삼성전자.*005930/ }).click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fmarket-browser&asset=stock&market=KR&ticker=005930$/u);
});

test('search badges expose only factual local watchlist and holding state', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('sa-portfolio-chart-overlays-v1', JSON.stringify([
      {
        ticker: '005930',
        name: '삼성전자',
        market: 'KR',
        currency: 'KRW',
        averagePrice: 70000,
        quantity: 3,
        purchaseDate: '2026-09-01',
        currentPrice: 71000,
        rate: (1000 / 70000) * 100,
        updatedAt: '2026-09-26T00:00:00.000Z',
      },
    ]));
  });
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    const market = url.searchParams.get('market');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(q, 'stock', market, q === '삼성전자' ? [krSamsung] : [])),
    });
  });

  await openStocksPage(page, {
    memberWatchlistItems: [{
      ticker: '005930',
      name: '삼성전자',
      market: 'KR_STOCK',
      currency: 'KRW',
      targetPrice: null,
    }],
  });
  await page.getByRole('combobox', { name: '통합 자산 검색' }).fill('삼성전자');
  const option = page.getByRole('option', { name: /삼성전자.*005930/ });
  await expect(option).toContainText('관심');
  await expect(option).toContainText('보유');
  await expect(option).not.toContainText('신호 0');
  await expect(option).not.toContainText('뉴스 0');
});

test('stocks user surface reuses shared EmptyState instead of a private empty-card implementation', async () => {
  const fs = await import('node:fs/promises');
  const [stocks, states] = await Promise.all([
    fs.readFile(new URL('../src/pages/stocks.tsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/data-state.tsx', import.meta.url), 'utf8'),
  ]);
  expect(stocks).toContain('EmptyState');
  expect(stocks).not.toContain('function EmptyBox');
  expect(states).toContain('export function EmptyState');
  expect(states).toContain('data-testid="empty-state"');
});

test('StocksPage source removes sub-12px labels and two-step market switching', async () => {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(new URL('../src/pages/stocks.tsx', import.meta.url), 'utf8');
  expect(source).not.toContain('text-[9px]');
  expect(source).not.toContain('text-[10px]');
  expect(source).not.toContain('text-[11px]');
  expect(source).not.toContain('<AssetSwitch');
  expect(source).toContain('data-testid="stocks-market-bar"');
  expect(source).toContain('data-testid="stocks-category-bar"');
  expect(source).toContain('data-testid="stocks-master-detail"');
  expect(source).toContain('data-testid="stocks-preview-pane"');
  expect(source).toContain("if (category === 'ai' || category === 'theme') setCategory('tradingValue');");
});

for (const [width, height] of [[390, 844], [768, 1024], [1024, 820], [1440, 900]] as const) {
  test(`StocksPage ${width}px keeps market/search/category controls bounded with one vertical owner`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route('**/api/search/suggest**', async (route) => {
      const url = new URL(route.request().url());
      const q = url.searchParams.get('q') ?? '';
      const asset = url.searchParams.get('asset') ?? 'stock';
      const market = url.searchParams.get('market');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successfulResponse(q, asset, market, [])),
      });
    });
    await openStocksPage(page);

    const marketBar = page.getByTestId('stocks-market-bar');
    const categoryBar = page.getByTestId('stocks-category-bar');
    await expect(marketBar).toBeVisible();
    await expect(categoryBar).toBeVisible();
    for (const label of ['국내', '미국', '코인 현물', '코인 선물']) {
      const button = marketBar.getByRole('button', { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);
    }

    const geometry = await page.evaluate(() => {
      const shell = document.querySelector<HTMLElement>('[data-testid="stocks-shell"]');
      const content = document.querySelector<HTMLElement>('[data-testid="stocks-scroll-content"]');
      if (!shell || !content) throw new Error('stocks layout owner missing');
      const nested = Array.from(content.querySelectorAll<HTMLElement>('*')).filter((node) => {
        const style = getComputedStyle(node);
        return /(auto|scroll)/u.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      });
      return {
        viewport: innerWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        shellOverflow: getComputedStyle(shell).overflowY,
        contentOverflow: getComputedStyle(content).overflowY,
        nestedScrollOwners: nested.length,
      };
    });
    expect(geometry.root).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.body).toBeLessThanOrEqual(geometry.viewport + 1);
    expect(geometry.shellOverflow).toBe('hidden');
    expect(['auto', 'scroll']).toContain(geometry.contentOverflow);
    expect(geometry.nestedScrollOwners).toBe(0);
  });
}

test('switching from stock-only recommendation category to coin chooses a supported category immediately', async ({ page }) => {
  await page.route('**/api/crypto/spot/markets**', async (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ markets: [] }),
  }));
  await page.route('**/api/crypto/spot/tickers**', async (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ tickers: [] }),
  }));
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(
        url.searchParams.get('q') ?? '',
        url.searchParams.get('asset') ?? 'coin',
        url.searchParams.get('market'),
        [],
      )),
    });
  });
  await openStocksPage(page);
  await expect(page.getByTestId('stocks-category-bar').getByRole('button', { name: 'AI추천', exact: true })).toHaveClass(/bg-primary/);
  await page.getByTestId('stocks-market-bar').getByRole('button', { name: '코인 현물', exact: true }).click();
  await expect(page.getByTestId('stocks-category-bar').getByRole('button', { name: '거래대금', exact: true })).toHaveClass(/bg-primary/);
  await expect(page.getByText(/코인에는 해당 분류를 제공하지 않습니다/)).toHaveCount(0);
});

test('StocksPage uses canonical KR/US search and never calls legacy search/quotes', async ({ page }) => {
  const requests: SearchRequest[] = [];
  let legacyCalls = 0;

  await page.route('**/api/search/quotes**', async (route) => {
    legacyCalls += 1;
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"LEGACY_ROUTE_MUST_NOT_BE_USED"}' });
  });
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const request = {
      q: url.searchParams.get('q') ?? '',
      asset: url.searchParams.get('asset'),
      market: url.searchParams.get('market'),
    };
    requests.push(request);
    const results = request.market === 'KR' && (request.q === '삼성전자' || request.q === '005930')
      ? [krSamsung]
      : request.market === 'US' && request.q === 'AAPL'
        ? [usApple]
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'stock', request.market, results)),
    }).catch(() => undefined);
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('삼성전자');
  await expectLatestRequest(requests, { q: '삼성전자', asset: 'stock', market: 'KR' });
  await expect(page.getByRole('option', { name: /삼성전자.*005930/ })).toBeVisible();

  await input.fill('005930');
  await expectLatestRequest(requests, { q: '005930', asset: 'stock', market: 'KR' });
  await expect(page.getByRole('option', { name: /삼성전자.*005930/ })).toBeVisible();
  await page.getByRole('option', { name: /삼성전자.*005930/ }).click();
  await expect(page).toHaveURL(/\/market-browser$/u);
  const krPreview = page.getByTestId('stocks-preview-pane');
  await expect(krPreview).toContainText('삼성전자');
  await krPreview.getByRole('button', { name: '상세 보기', exact: true }).click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fmarket-browser&asset=stock&market=KR&ticker=005930$/);

  await page.goto('/market-browser');
  await expect(page.getByTestId('stocks-shell')).toBeVisible();
  await page.getByRole('button', { name: '미국', exact: true }).click();
  const usInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await usInput.fill('AAPL');
  await expectLatestRequest(requests, { q: 'AAPL', asset: 'stock', market: 'US' });
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  await page.getByRole('option', { name: /애플.*AAPL/ }).click();
  await expect(page).toHaveURL(/\/market-browser$/u);
  const usPreview = page.getByTestId('stocks-preview-pane');
  await expect(usPreview).toContainText('애플');
  await usPreview.getByRole('button', { name: '상세 보기', exact: true }).click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fmarket-browser&asset=stock&market=US&ticker=AAPL$/);

  expect(legacyCalls).toBe(0);
});

test('coin search uses canonical unified search even when ticker-list APIs are unavailable', async ({ page }) => {
  const requests: SearchRequest[] = [];

  await page.route('**/api/crypto/spot/markets**', async (route) => {
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"SPOT_MARKETS_UNAVAILABLE"}' });
  });
  await page.route('**/api/crypto/spot/tickers**', async (route) => {
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"SPOT_TICKERS_UNAVAILABLE"}' });
  });
  await page.route('**/api/crypto/futures/tickers**', async (route) => {
    await route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"FUTURES_TICKERS_UNAVAILABLE"}' });
  });
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const request = {
      q: url.searchParams.get('q') ?? '',
      asset: url.searchParams.get('asset'),
      market: url.searchParams.get('market'),
    };
    requests.push(request);
    const results = request.market === 'spot' && request.q === 'BTC'
      ? [spotBitcoin]
      : request.market === 'futures' && request.q === 'BTCUSDT'
        ? [futuresBitcoin]
        : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'coin', request.market, results)),
    }).catch(() => undefined);
  });

  await openStocksPage(page);
  await page.getByRole('button', { name: '코인 현물', exact: true }).click();

  const spotInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await spotInput.fill('BTC');
  await expectLatestRequest(requests, { q: 'BTC', asset: 'coin', market: 'spot' });
  await expect(page.getByRole('option', { name: /비트코인.*BTC\/KRW/ })).toBeVisible();

  await page.getByRole('button', { name: '코인 선물', exact: true }).click();
  const futuresInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await futuresInput.fill('BTCUSDT');
  await expectLatestRequest(requests, { q: 'BTCUSDT', asset: 'coin', market: 'futures' });
  await expect(page.getByRole('option', { name: /비트코인.*BTCUSDT/ })).toBeVisible();
});

test('rapid input and market switch never allow an older stock result to overwrite the latest identity', async ({ page }) => {
  const requests: SearchRequest[] = [];
  let delayedKrACompleted = false;
  let delayedKrCodeCompleted = false;

  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const request = {
      q: url.searchParams.get('q') ?? '',
      asset: url.searchParams.get('asset'),
      market: url.searchParams.get('market'),
    };
    requests.push(request);

    if (request.market === 'KR' && request.q === 'A') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'stock', request.market, [krSamsung])),
      }).catch(() => undefined);
      delayedKrACompleted = true;
      return;
    }

    if (request.market === 'KR' && request.q === '005930') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'stock', request.market, [krSamsung])),
      }).catch(() => undefined);
      delayedKrCodeCompleted = true;
      return;
    }

    const results = request.market === 'US' && request.q === 'AAPL' ? [usApple] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(request.q, request.asset ?? 'stock', request.market, results)),
    }).catch(() => undefined);
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('A');
  await expectRequestStarted(requests, { q: 'A', asset: 'stock', market: 'KR' });
  await input.fill('AA');
  await input.fill('AAP');
  await input.fill('AAPL');
  await page.getByRole('button', { name: '미국', exact: true }).click();
  await input.fill('AAPL');
  await expectLatestRequest(requests, { q: 'AAPL', asset: 'stock', market: 'US' });
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  await expect.poll(() => delayedKrACompleted).toBe(true);
  await expect(page.getByRole('option', { name: /삼성전자/ })).toHaveCount(0);
  await expectLatestRequest(requests, { q: 'AAPL', asset: 'stock', market: 'US' });

  // A visible US popup must not block a normal pointer click back to KR.
  await page.getByRole('button', { name: '국내', exact: true }).click();
  await expect(page.getByRole('option', { name: /애플/ })).toHaveCount(0);
  await input.fill('005930');
  await expectRequestStarted(requests, { q: '005930', asset: 'stock', market: 'KR' });

  // Switch again while the KR response is still pending. The late KR result must never contaminate US.
  await page.getByRole('button', { name: '미국', exact: true }).click();
  await input.fill('AAPL');
  await expectLatestRequest(requests, { q: 'AAPL', asset: 'stock', market: 'US' });
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  await expect.poll(() => delayedKrCodeCompleted).toBe(true);
  await expect(page.getByRole('option', { name: /삼성전자/ })).toHaveCount(0);
  await expectLatestRequest(requests, { q: 'AAPL', asset: 'stock', market: 'US' });
});

test('zero results, provider failure, and identity-only results remain truthfully distinct', async ({ page }) => {
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    const market = url.searchParams.get('market');

    if (q === 'provider-down') {
      const unavailable = successfulResponse(q, 'stock', market, []);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...unavailable,
          state: 'DEGRADED',
          stale: false,
          partial: true,
          providers: [
            { provider: 'krx', status: 'error', count: 0, dataAsOf: null },
            { provider: 'finnhub', status: 'ok', count: 1, dataAsOf: unavailable.dataAsOf },
            { provider: 'upbit', status: 'ok', count: 1, dataAsOf: unavailable.dataAsOf },
            { provider: 'bitget', status: 'ok', count: 1, dataAsOf: unavailable.dataAsOf },
          ],
        }),
      });
      return;
    }

    const results = q === '005930' ? [krSamsung] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(q, 'stock', market, results)),
    });
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('NO-SUCH-STOCK');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('NO_MATCH');
  await expect(page.getByTestId('unified-search-outcome')).not.toContainText('PROVIDER_UNAVAILABLE');

  await input.fill('provider-down');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('PROVIDER_UNAVAILABLE');
  await expect(page.getByTestId('unified-search-outcome')).toContainText('정상적인 검색 결과 0건이 아닙니다');

  await input.fill('005930');
  await expect(page.getByRole('option', { name: /삼성전자.*005930/ })).toBeVisible();
  await expect(page.getByRole('listbox', { name: '통합 자산 자동완성 결과' })).not.toContainText(/(?:₩|\$)\s*0(?:\.0+)?/);
  await expect(page.getByRole('listbox', { name: '통합 자산 자동완성 결과' })).not.toContainText(/(?:^|\s)[+-]?0(?:\.0+)?%(?:\s|$)/);
});
