import { test, expect, type Page } from '@playwright/test';

const now = '2026-09-04T03:00:00.000Z';

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

type SearchRequest = { q: string; asset: string | null; market: string | null };

function successfulResponse(q: string, market: string | null, results: readonly unknown[]) {
  return {
    ok: true,
    state: results.length ? 'FULL' : 'EMPTY',
    q,
    asset: 'stock',
    market,
    results,
    count: results.length,
    dataAsOf: now,
    stale: false,
    partial: false,
    providers: [],
    hiddenMatches: [],
  };
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

async function installNonSearchApiMocks(page: Page) {
  await page.route('**/api/market/recommendations**', async (route) => {
    const market = new URL(route.request().url()).searchParams.get('market') === 'US' ? 'US' : 'KR';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, market, rows: [] }),
    });
  });
}

async function openStocksPage(page: Page) {
  await installAuthenticatedUser(page);
  await installNonSearchApiMocks(page);
  await page.goto('/market-browser');
  await expect(page.getByTestId('stocks-shell')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toHaveCount(1);
}

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
      body: JSON.stringify(successfulResponse(request.q, request.market, results)),
    }).catch(() => undefined);
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('삼성전자');
  await expect(page.getByRole('option', { name: /삼성전자.*005930/ })).toBeVisible();
  expect(requests.at(-1)).toEqual({ q: '삼성전자', asset: 'stock', market: 'KR' });

  await input.fill('005930');
  await expect(page.getByRole('option', { name: /삼성전자.*005930/ })).toBeVisible();
  expect(requests.at(-1)).toEqual({ q: '005930', asset: 'stock', market: 'KR' });
  await page.getByRole('option', { name: /삼성전자.*005930/ }).click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fmarket-browser&asset=stock&market=KR&ticker=005930$/);

  await page.goto('/market-browser');
  await expect(page.getByTestId('stocks-shell')).toBeVisible();
  await page.getByRole('button', { name: '해외', exact: true }).click();
  const usInput = page.getByRole('combobox', { name: '통합 자산 검색' });
  await usInput.fill('AAPL');
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  expect(requests.at(-1)).toEqual({ q: 'AAPL', asset: 'stock', market: 'US' });
  await page.getByRole('option', { name: /애플.*AAPL/ }).click();
  await expect(page).toHaveURL(/\/stock-info\/analysis\?back=%2Fmarket-browser&asset=stock&market=US&ticker=AAPL$/);

  expect(legacyCalls).toBe(0);
});

test('rapid input and market switch never allow an older stock result to overwrite the latest identity', async ({ page }) => {
  const requests: SearchRequest[] = [];

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
        body: JSON.stringify(successfulResponse(request.q, request.market, [krSamsung])),
      }).catch(() => undefined);
      return;
    }

    if (request.market === 'KR' && request.q === '005930') {
      await new Promise((resolve) => setTimeout(resolve, 650));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(successfulResponse(request.q, request.market, [krSamsung])),
      }).catch(() => undefined);
      return;
    }

    const results = request.market === 'US' && request.q === 'AAPL' ? [usApple] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(request.q, request.market, results)),
    }).catch(() => undefined);
  });

  await openStocksPage(page);
  const input = page.getByRole('combobox', { name: '통합 자산 검색' });

  await input.fill('A');
  await page.waitForTimeout(260);
  await input.fill('AA');
  await input.fill('AAP');
  await input.fill('AAPL');
  await page.getByRole('button', { name: '해외', exact: true }).click();
  await input.fill('AAPL');
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole('option', { name: /삼성전자/ })).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ q: 'AAPL', asset: 'stock', market: 'US' });

  await page.getByRole('button', { name: '국내', exact: true }).click();
  await input.fill('005930');
  await page.waitForTimeout(260);
  await page.getByRole('button', { name: '해외', exact: true }).click();
  await input.fill('AAPL');
  await expect(page.getByRole('option', { name: /애플.*AAPL/ })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole('option', { name: /삼성전자/ })).toHaveCount(0);
});

test('zero results, provider failure, and identity-only results remain truthfully distinct', async ({ page }) => {
  await page.route('**/api/search/suggest**', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    const market = url.searchParams.get('market');

    if (q === 'provider-down') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...successfulResponse(q, market, []),
          state: 'DEGRADED',
          stale: true,
          partial: true,
          providers: [{ provider: 'KRX', status: 'error', count: 0, dataAsOf: null }],
        }),
      });
      return;
    }

    const results = q === '005930' ? [krSamsung] : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(successfulResponse(q, market, results)),
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
