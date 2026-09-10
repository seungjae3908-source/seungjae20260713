import { test, expect, type Page } from '@playwright/test';

async function installAuthenticatedUser(page: Page) {
  await page.addInitScript(() => {
    const timestamp = new Date().toISOString();
    window.localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: 'search-response-truth-access-token',
      refresh_token: 'search-response-truth-refresh-token',
      expires_in: 60 * 60,
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
      token_type: 'bearer',
      user: {
        id: 'search-response-truth-user',
        aud: 'authenticated',
        role: 'authenticated',
        email: 'search-response-truth@accounts.seungjae-stock.com',
        email_confirmed_at: timestamp,
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
      const now = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'search-response-truth-user',
          login_name: 'search-truth',
          display_name: 'Search Truth',
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

function canonicalMoverPayload() {
  const now = new Date().toISOString();
  const row = {
    ticker: '005930',
    name: '삼성전자',
    market: 'KR',
    currency: 'KRW',
    price: 70000,
    changePercent: 0,
    volume: 100,
    tradingValue: 1_000_000,
    rating: { score: 70 },
  };

  return {
    market: 'KR',
    provider: 'live-market-providers',
    dataStatus: 'complete',
    diagnostics: {
      status: 'complete',
      requestedMarkets: ['KRX'],
      completedMarkets: ['KRX'],
      failedMarkets: [],
      listingDiagnostics: [{ market: 'KRX', diagnostics: null }],
    },
    popular: [row],
    volume: [row],
    recommended: [row],
    gainers: [row],
    losers: [row],
    risky: [row],
    rankingSource: {
      popular: '실제 거래대금 기준',
      gainers: '실제 등락률 기준',
      losers: '실제 등락률 기준',
      recommended: '실제 데이터 기반 종합점수 기준',
    },
    updatedAt: now,
  };
}

async function installRankingSuccess(page: Page) {
  await page.route('**/api/market/movers**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(canonicalMoverPayload()),
    });
  });
  await page.route('**/api/quotes**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        quotes: [{ ticker: '005930', price: 70000, changePercent: 0 }],
        requested: 1,
        available: 1,
        updatedAt: new Date().toISOString(),
      }),
    });
  });
}

async function openSearch(page: Page, installRanking = true) {
  await installAuthenticatedUser(page);
  if (installRanking) await installRankingSuccess(page);
  await page.goto('/search?asset=stock&market=KR&rank=marketCap');
  await expect(page.getByPlaceholder('국내 종목명 또는 종목코드 검색')).toBeVisible();
}

test('SearchPage rejects malformed legacy HTTP 200 instead of displaying a normal empty result', async ({ page }) => {
  let legacyCalls = 0;
  await page.route('**/api/search?*', async (route) => {
    legacyCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await openSearch(page);
  await page.getByPlaceholder('국내 종목명 또는 종목코드 검색').fill('삼성전자');

  await expect(page.getByText('종목 데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.')).toBeVisible();
  await expect(page.getByText('표시할 종목이 없습니다.')).toHaveCount(0);
  expect(legacyCalls).toBeGreaterThan(0);
});

test('SearchPage preserves a producer-backed genuine empty search result', async ({ page }) => {
  await page.route('**/api/search?*', async (route) => {
    const url = new URL(route.request().url());
    const q = url.searchParams.get('q') ?? '';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        q,
        results: [],
        count: 0,
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  await openSearch(page);
  await page.getByPlaceholder('국내 종목명 또는 종목코드 검색').fill('존재하지않는종목');

  await expect(page.getByText('표시할 종목이 없습니다.')).toBeVisible();
  await expect(page.getByText('종목 데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.')).toHaveCount(0);
});

test('SearchPage rejects malformed movers HTTP 200 instead of displaying a normal empty ranking', async ({ page }) => {
  await page.route('**/api/market/movers**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  });

  await openSearch(page, false);

  await expect(page.getByText('종목 데이터를 불러오지 못했습니다. 잠시 후 새로고침해 주세요.')).toBeVisible();
  await expect(page.getByText('표시할 종목이 없습니다.')).toHaveCount(0);
});
